import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import request from "supertest";
import type { Express } from "express";
import { Archive } from "../../src/archive.js";
import { BackendRegistry } from "../../src/backends/registry.js";
import { ClaudeBackend } from "../../src/backends/claudeBackend.js";
import { buildApp } from "../../src/server.js";
import type { Config } from "../../src/config.js";
import { ConfigSnapshotStore } from "../../src/admin/configSnapshot.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const MOCK_CLAUDE_JS = join(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "mock-claude",
  "index.mjs"
);

interface InProcessServer {
  app: Express;
  registry: BackendRegistry;
  archive: Archive;
  workDir: string;
}

/**
 * Builds the full Express app via `buildApp` exactly as `main()` would, but
 * wires a `ClaudeBackend` that points at the mock-claude fixture (executed
 * via `node`). The plan originally spawned `src/bin.ts` as a subprocess and
 * read config from disk; doing so requires the config schema to accept an
 * array `claude.command`, which it does not (zod schema is `z.string()`).
 * Switching to in-process `buildApp` lets us exercise the full HTTP routing
 * stack (auth, translation, routing, streaming, count_tokens, models) against
 * the real `ClaudeBackend` + mock-claude pair — losing only `bin.ts`
 * argv-parsing coverage, which has no logic worth integration-testing.
 */
async function startServer(): Promise<InProcessServer> {
  const workDir = mkdtempSync(join(tmpdir(), "claudemcp-it-"));
  const dbPath = join(workDir, "archive.sqlite");

  const config: Config = {
    apiKey: "sk-integration",
    claude: {
      enabled: true,
      command: "claude", // unused at runtime — backend is constructed below
      priority: 100,
      timeoutMs: 10000
    },
    gemini: {
      enabled: false,
      command: "gemini",
      priority: 90,
      timeoutMs: 600000
    },
    lmstudio: { enabled: false, instances: [] },
    ollama: { enabled: false, useNativeApi: false, instances: [] },
    router: {
      defaultBackend: "claude",
      localProbeIntervalMs: 60000,
      thresholds: {
        opusPromptTokens: 50000,
        opusToolCount: 5,
        sonnetPromptTokens: 5000
      },
      reasoningEffortMap: {
        claude: {
          low: "claude-haiku-4-5",
          medium: "claude-sonnet-4-6",
          high: "claude-opus-4-7"
        },
        gemini: {
          low: "gemini-flash-lite",
          medium: "gemini-flash",
          high: "gemini-pro"
        },
        lmstudio: {},
        ollama: {}
      }
    },
    files: {
      dir: join(workDir, "files"),
      ttlMs: 604800000,
      maxTotalBytes: 5368709120
    },
    cache: {
      file: join(workDir, "response-cache.json"),
      ttlMs: 3600000,
      maxEntries: 500
    },
    archive: { dbPath, compressionLevel: 3 },
    embeddings: { legacyBackendUrl: "", legacyApiKey: "", legacyTimeoutMs: 30000 },
    adminUi: { enabled: true, bindLocalhost: true, sessionTtlMs: 3600000 }
  };

  const archive = new Archive(dbPath);

  // Build the registry manually so we can register a ClaudeBackend that
  // points at the mock-claude fixture via `node <path>`. The runtime
  // ClaudeBackend accepts `command: string | string[]`; we use the array
  // form here.
  const registry = new BackendRegistry({
    claude: config.claude.priority,
    gemini: config.gemini.priority,
    lmstudio: 50,
    ollama: 40
  });
  registry.register(
    new ClaudeBackend({
      command: [process.execPath, MOCK_CLAUDE_JS],
      timeoutMs: config.claude.timeoutMs
    })
  );

  // Probe so the model map is populated for /v1/anthropic/models.
  await registry.probe();

  const configSnapshot = new ConfigSnapshotStore({
    initial: config,
    path: join(workDir, "default.json")
  });
  const app = buildApp({ config, registry, archive, configSnapshot } as never);
  return { app, registry, archive, workDir };
}

function stopServer(s: InProcessServer): void {
  s.registry.stop();
  s.archive.close();
  rmSync(s.workDir, { recursive: true, force: true });
}

describe("Anthropic shim — full HTTP stack against mock-claude", () => {
  let server: InProcessServer;

  beforeAll(async () => {
    server = await startServer();
  }, 30000);

  afterAll(() => {
    if (server) stopServer(server);
  });

  it("POST /v1/messages (non-streaming) returns Anthropic-shaped body", async () => {
    const res = await request(server.app)
      .post("/v1/messages")
      .set("x-api-key", "sk-integration")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "integration ping" }]
      });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe("message");
    expect(res.body.stop_reason).toBe("end_turn");
    expect(res.body.content[0]?.type).toBe("text");
    expect(res.body.content[0]?.text).toContain("echo:");
  });

  it("POST /v1/messages (streaming) yields the documented event sequence", async () => {
    const res = await request(server.app)
      .post("/v1/messages")
      .set("x-api-key", "sk-integration")
      .send({
        model: "claude-sonnet-4-6",
        stream: true,
        messages: [{ role: "user", content: "stream ping" }]
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const eventNames = res.text
      .split("\n\n")
      .filter((b) => b.startsWith("event: "))
      .map((b) => b.split("\n")[0]?.replace(/^event:\s*/, "") ?? "");
    expect(eventNames[0]).toBe("message_start");
    expect(eventNames[eventNames.length - 1]).toBe("message_stop");
    expect(eventNames).toContain("content_block_start");
    expect(eventNames).toContain("content_block_delta");
    expect(eventNames).toContain("content_block_stop");
    expect(eventNames).toContain("message_delta");
  });

  it("POST /v1/messages/count_tokens returns {input_tokens: <n>}", async () => {
    const res = await request(server.app)
      .post("/v1/messages/count_tokens")
      .set("x-api-key", "sk-integration")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello world" }]
      });
    expect(res.status).toBe(200);
    expect(typeof res.body.input_tokens).toBe("number");
    expect(res.body.input_tokens).toBeGreaterThan(0);
  });

  it("GET /v1/anthropic/models lists at least the Claude catalog", async () => {
    const res = await request(server.app)
      .get("/v1/anthropic/models")
      .set("x-api-key", "sk-integration");
    expect(res.status).toBe(200);
    expect(res.body.has_more).toBe(false);
    const ids = res.body.data.map((d: { id: string }) => d.id);
    expect(ids).toContain("claude-opus-4-7");
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("claude-haiku-4-5");
  });

  it("GET /v1/anthropic/models/{id} returns the matching entry", async () => {
    const res = await request(server.app)
      .get("/v1/anthropic/models/claude-sonnet-4-6")
      .set("x-api-key", "sk-integration");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("claude-sonnet-4-6");
    expect(res.body.type).toBe("model");
  });

  it("GET /v1/anthropic/models/{id} returns 404 on unknown id", async () => {
    const res = await request(server.app)
      .get("/v1/anthropic/models/does-not-exist")
      .set("x-api-key", "sk-integration");
    expect(res.status).toBe(404);
  });

  it("GET /v1/models returns the OpenAI-shaped envelope (Plan 10)", async () => {
    const res = await request(server.app)
      .get("/v1/models")
      .set("x-api-key", "sk-integration");
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(Array.isArray(res.body.data)).toBe(true);
    const ids = (res.body.data as Array<{ id: string }>).map((d) => d.id);
    expect(ids).toContain("claude-sonnet-4-6");
  });

  it("POST /v1/messages with no auth returns 401 + Anthropic envelope", async () => {
    const res = await request(server.app)
      .post("/v1/messages")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(401);
    expect(res.body.type).toBe("error");
    expect(res.body.error.type).toBe("authentication_error");
  });
});
