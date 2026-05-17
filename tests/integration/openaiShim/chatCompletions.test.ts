import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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
const MOCK_GEMINI = join(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "mock-gemini",
  "index.mjs"
);
const HAS_MOCK_GEMINI = existsSync(MOCK_GEMINI);

// Optional Plan 08 fixture (in-process mock).
type MockLmStudioModule = typeof import("../../fixtures/mock-lmstudio/inProcess.js");
let mockLmStudio: MockLmStudioModule | undefined;
try {
  mockLmStudio = await import("../../fixtures/mock-lmstudio/inProcess.js");
} catch {
  /* Plan 08 fixture not present */
}
const HAS_LMSTUDIO = mockLmStudio !== undefined;

// Optional Plan 09 fixture — not yet shipped.
type MockOllamaModule = typeof import("../../fixtures/mock-lmstudio/inProcess.js");
let mockOllama: MockOllamaModule | undefined;
try {
  // dynamic import path — TS won't fail if missing
  mockOllama = (await import(
    "../../fixtures/mock-ollama/inProcess.js" as string
  )) as MockOllamaModule;
} catch {
  /* Plan 09 fixture not present */
}
const HAS_OLLAMA = mockOllama !== undefined;

const API_KEY = "sk-test-plan10";

function makeConfig(overrides: Partial<Config> = {}): Config {
  const workDir = mkdtempSync(join(tmpdir(), "claudemcp-plan10-"));
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
  http: import("node:http").Server;
  port: number;
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
    http,
    port,
    shutdown: async (): Promise<void> => {
      await new Promise<void>((resolve) => http.close(() => resolve()));
      archive.close();
    }
  };
}

async function postChat(
  port: number,
  body: unknown,
  stream = false
): Promise<{ status: number; text: string; json?: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`
    },
    body: JSON.stringify({ ...(body as Record<string, unknown>), stream })
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    /* SSE response */
  }
  return { status: res.status, text, json };
}

// ---- Claude backend (always available) ----------------------------------

describe("integration: POST /v1/chat/completions × ClaudeBackend (mock-claude)", () => {
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

  it("non-streaming returns chat.completion body", async () => {
    const res = await postChat(server.port, {
      model: "claude-code-cli",
      messages: [{ role: "user", content: "hello there friend" }]
    });
    expect(res.status).toBe(200);
    const body = res.json as {
      object: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(typeof body.choices[0]?.message.content).toBe("string");
  });

  it("streaming emits OpenAI SSE terminated by data: [DONE]", async () => {
    const res = await postChat(
      server.port,
      {
        model: "claude-code-cli",
        messages: [{ role: "user", content: "hello there friend" }]
      },
      true
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("data: [DONE]");
    const chunks = res.text
      .split("\n\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("data: ") && !l.endsWith("[DONE]"));
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      const parsed = JSON.parse(c.slice("data: ".length)) as {
        object: string;
      };
      expect(parsed.object).toBe("chat.completion.chunk");
    }
  });
});

// ---- LM Studio backend (optional) ---------------------------------------

describe.skipIf(!HAS_LMSTUDIO)(
  "integration: POST /v1/chat/completions × LMStudioBackend (mock-lmstudio)",
  () => {
    let server: Live | undefined;
    let lmHandle: { url: string; close: () => Promise<void> } | undefined;

    beforeAll(async () => {
      const { LMStudioBackend } = await import(
        "../../../src/backends/lmstudioBackend.js"
      );
      lmHandle = await mockLmStudio!.startMockLmStudio({
        models: ["qwen3-coder-30b"]
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

    it("routes a registered LM Studio model through the HTTP backend", async () => {
      const res = await postChat(server!.port, {
        model: "qwen3-coder-30b",
        messages: [{ role: "user", content: "hi there friend" }]
      });
      expect(res.status).toBe(200);
      const body = res.json as { object: string };
      expect(body.object).toBe("chat.completion");
    });
  }
);

// ---- Ollama backend (optional — Plan 09 may not have shipped) ------------

describe.skipIf(!HAS_OLLAMA)(
  "integration: POST /v1/chat/completions × OllamaBackend (mock-ollama)",
  () => {
    it("placeholder — wires up once Plan 09 ships", () => {
      expect(HAS_OLLAMA).toBe(true);
    });
  }
);

// ---- Cross-backend smoke check ------------------------------------------

afterEach(() => {
  // Best-effort cleanup of tmpdirs (created per makeConfig call).
  // No-op for now; tmpdirs are small and the process exits after the test.
});

describe("integration: chatCompletions handler is fully wired in buildApp", () => {
  it("GET /v1/models still works alongside /v1/chat/completions", async () => {
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
    const srv = await startServer({ registry });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/v1/models`, {
        headers: { Authorization: `Bearer ${API_KEY}` }
      });
      const body = (await res.json()) as { object: string; data: unknown[] };
      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);
    } finally {
      await srv.shutdown();
    }
  });
});

// Suppress unused warning when Gemini fixture is absent.
void HAS_MOCK_GEMINI;
