import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { Archive } from "../../../src/archive.js";
import { BackendRegistry } from "../../../src/backends/registry.js";
import { ClaudeBackend } from "../../../src/backends/claudeBackend.js";
import { buildApp } from "../../../src/server.js";
import type { Config } from "../../../src/config.js";
import { ConfigSnapshotStore } from "../../../src/admin/configSnapshot.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..", "..");
const MOCK_CLAUDE = join(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "mock-claude",
  "index.mjs"
);

type MockLmStudioModule = typeof import("../../fixtures/mock-lmstudio/inProcess.js");
let mockLmStudio: MockLmStudioModule | undefined;
try {
  mockLmStudio = await import("../../fixtures/mock-lmstudio/inProcess.js");
} catch {
  /* Plan 08 not shipped */
}
const HAS_LMSTUDIO = mockLmStudio !== undefined;

type MockOllamaModule = typeof import("../../fixtures/mock-lmstudio/inProcess.js");
let mockOllama: MockOllamaModule | undefined;
try {
  mockOllama = (await import(
    "../../fixtures/mock-ollama/inProcess.js" as string
  )) as MockOllamaModule;
} catch {
  /* Plan 09 not shipped */
}
const HAS_OLLAMA = mockOllama !== undefined;

const API_KEY = "sk-test-plan10-embed";

function makeConfig(overrides: Partial<Config> = {}): Config {
  const workDir = mkdtempSync(join(tmpdir(), "claudemcp-plan10-embed-"));
  return {
    apiKey: API_KEY,
    claude: {
      enabled: false,
      command: "claude",
      priority: 100,
      timeoutMs: 10000
    },
    gemini: {
      enabled: false,
      command: "gemini",
      priority: 90,
      timeoutMs: 10000
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
      file: join(workDir, "cache.json"),
      ttlMs: 3600000,
      maxEntries: 500
    },
    archive: { dbPath: join(workDir, "archive.sqlite"), compressionLevel: 3 },
    embeddings: {
      legacyBackendUrl: "",
      legacyApiKey: "",
      legacyTimeoutMs: 30000
    },
    adminUi: { enabled: true, bindLocalhost: true, sessionTtlMs: 3600000 },
    ...overrides
  } as Config;
}

interface Live {
  app: Express;
  port: number;
  archive: Archive;
  shutdown: () => Promise<void>;
}

async function startServer(opts: {
  registry: BackendRegistry;
}): Promise<Live> {
  const config = makeConfig();
  const archive = new Archive(config.archive.dbPath);
  const configSnapshot = new ConfigSnapshotStore({
    initial: config,
    path: join(config.files.dir, "..", "default.json")
  });
  const app = buildApp({
    config,
    registry: opts.registry,
    archive,
    configSnapshot
  } as never);
  const http = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    http.once("listening", () => resolve());
    http.once("error", reject);
  });
  const port = (http.address() as AddressInfo).port;
  return {
    app,
    port,
    archive,
    shutdown: async (): Promise<void> => {
      await new Promise<void>((resolve) => http.close(() => resolve()));
      archive.close();
    }
  };
}

async function postEmbed(
  port: number,
  body: unknown
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`
    },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  return { status: res.status, json };
}

// ---- Always-available: rejection of Claude-mapped models ----------------

describe("integration: POST /v1/embeddings rejects Claude-mapped models", () => {
  let server: Live;
  beforeAll(async () => {
    const registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
    registry.register(
      new ClaudeBackend({
        command: [process.execPath, MOCK_CLAUDE],
        timeoutMs: 10000
      })
    );
    await registry.probe();
    server = await startServer({ registry });
  });
  afterAll(async () => server.shutdown());

  it("returns 400 'model does not support embeddings' for claude models", async () => {
    const res = await postEmbed(server.port, {
      model: "claude-code-cli",
      input: "hi"
    });
    expect(res.status).toBe(400);
    expect((res.json as { error: { message: string } }).error.message).toMatch(
      /does not support embeddings/i
    );
  });

  it("returns 404 not_found_error for an unknown model id", async () => {
    const res = await postEmbed(server.port, {
      model: "no-such-embed",
      input: "hi"
    });
    expect(res.status).toBe(404);
  });
});

// ---- LM Studio ----------------------------------------------------------

describe.skipIf(!HAS_LMSTUDIO)(
  "integration: POST /v1/embeddings × LMStudioBackend",
  () => {
    let server: Live | undefined;
    let lmHandle: { url: string; close: () => Promise<void> } | undefined;
    beforeAll(async () => {
      const { LMStudioBackend } = await import(
        "../../../src/backends/lmstudioBackend.js"
      );
      lmHandle = await mockLmStudio!.startMockLmStudio({
        models: ["nomic-embed-text"]
      });
      const registry = new BackendRegistry({
        claude: 100,
        gemini: 90,
        lmstudio: 50,
        ollama: 40
      });
      registry.register(
        new LMStudioBackend({
          enabled: true,
          instances: [
            {
              name: "local",
              baseUrl: lmHandle.url,
              apiKey: "",
              priority: 50,
              timeoutMs: 10000,
              useNativeApi: null
            }
          ]
        })
      );
      await registry.probe();
      server = await startServer({ registry });
    });
    afterAll(async () => {
      if (server) await server.shutdown();
      if (lmHandle) await lmHandle.close();
    });

    it("routes 'nomic-embed-text' to LM Studio", async () => {
      const res = await postEmbed(server!.port, {
        model: "nomic-embed-text",
        input: "hello"
      });
      expect(res.status).toBe(200);
      const body = res.json as {
        object: string;
        data: Array<{ embedding: number[] }>;
      };
      expect(body.object).toBe("list");
      expect(body.data).toHaveLength(1);
      expect(Array.isArray(body.data[0]?.embedding)).toBe(true);
    });

    it("handles input as an array of strings", async () => {
      const res = await postEmbed(server!.port, {
        model: "nomic-embed-text",
        input: ["a", "b", "c"]
      });
      expect(res.status).toBe(200);
      const body = res.json as { data: Array<{ index: number }> };
      expect(body.data).toHaveLength(3);
      expect(body.data.map((d) => d.index)).toEqual([0, 1, 2]);
    });

    it("embeddings request is archived with endpoint + backend", async () => {
      const res = await postEmbed(server!.port, {
        model: "nomic-embed-text",
        input: "needle-for-archive-check"
      });
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 100));
      const page = server!.archive.list({ limit: 50, offset: 0 });
      const entry = page.data.find(
        (e) =>
          e.endpoint === "/v1/embeddings" &&
          e.backend === "lmstudio" &&
          JSON.stringify(e.requestBody).includes("needle-for-archive-check")
      );
      expect(entry, "expected archive entry for /v1/embeddings").toBeDefined();
    });

    it("response includes usage.prompt_tokens (real OpenAI parity)", async () => {
      const res = await postEmbed(server!.port, {
        model: "nomic-embed-text",
        input: "the quick brown fox jumps over the lazy dog"
      });
      expect(res.status).toBe(200);
      const body = res.json as {
        usage?: { prompt_tokens?: unknown; total_tokens?: unknown };
      };
      expect(body.usage).toBeDefined();
      expect(typeof body.usage?.prompt_tokens).toBe("number");
      expect(body.usage?.prompt_tokens).toBeGreaterThan(0);
      expect(body.usage?.total_tokens).toBe(body.usage?.prompt_tokens);
    });
  }
);

// ---- Ollama (optional) --------------------------------------------------

describe.skipIf(!HAS_OLLAMA)(
  "integration: POST /v1/embeddings × OllamaBackend",
  () => {
    it("placeholder — wires up once Plan 09 ships", () => {
      expect(HAS_OLLAMA).toBe(true);
    });
  }
);
