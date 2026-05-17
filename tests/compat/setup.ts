/**
 * Plan 13 — Compat test harness.
 *
 * `buildCompatServer({enabledBackends})` boots a fully configured ClaudeMCP
 * server on port 0 (OS-assigned) wired against the mock fixtures for whichever
 * subset of backends the caller asks for. Returns `{baseURL, apiKey, registry,
 * teardown}`; callers must await teardown() in `afterAll`.
 *
 * Pattern is borrowed from the Plan-10 integration tests' helpers
 * (`tests/integration/openaiShim/chatCompletions.test.ts`):
 *   - Build a `Config` literal that matches the Zod schema shape.
 *   - Construct `Archive`, `FileStore`, `ResponseCache`, `ConfigSnapshotStore`.
 *   - Register exactly the requested backends with the registry.
 *   - `await registry.probe()` so the model map is populated before any HTTP
 *     request hits.
 *   - Bind the Express app to 127.0.0.1:0 and report the resolved port.
 *
 * The helper does NOT start the registry's periodic probe — compat tests are
 * one-shot per cell and a periodic re-probe could overwrite the model map
 * mid-test with a slow mock-CLI response.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Archive } from "../../src/archive.js";
import { BackendRegistry } from "../../src/backends/registry.js";
import { ClaudeBackend } from "../../src/backends/claudeBackend.js";
import { GeminiBackend } from "../../src/backends/geminiBackend.js";
import { LMStudioBackend } from "../../src/backends/lmstudioBackend.js";
import { OllamaBackend } from "../../src/backends/ollamaBackend.js";
import { ConfigSnapshotStore } from "../../src/admin/configSnapshot.js";
import { FileStore } from "../../src/fileStore.js";
import { ResponseCache } from "../../src/responseCache.js";
import { buildApp } from "../../src/server.js";
import type { Config } from "../../src/config.js";
import {
  startMockLmStudio,
  type MockLmStudioHandle
} from "../fixtures/mock-lmstudio/inProcess.js";
import {
  startMockOllama,
  type MockOllamaHandle
} from "../helpers/mockOllamaProcess.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const MOCK_CLAUDE = join(REPO_ROOT, "tests", "fixtures", "mock-claude", "index.mjs");
const MOCK_GEMINI = join(REPO_ROOT, "tests", "fixtures", "mock-gemini", "index.mjs");

/** Identifiers for the four backends the compat suite knows about. */
export type CompatBackendId = "claude" | "gemini" | "lmstudio" | "ollama";

export interface CompatServerOptions {
  /**
   * Which backends to register. The setup spins up only the fixtures needed.
   * Defaults to all four when omitted.
   */
  enabledBackends?: ReadonlyArray<CompatBackendId>;
  /**
   * API key clients must send. Defaults to a random string per setup() call
   * so tests don't accidentally share auth state.
   */
  apiKey?: string;
}

export interface CompatServerHandle {
  /** Base URL of the running test server, e.g. http://127.0.0.1:54123. */
  baseURL: string;
  /** The API key clients must send. */
  apiKey: string;
  /** The BackendRegistry, exposed for advanced assertions. */
  registry: BackendRegistry;
  /** Stop the server, kill any spawned mocks, free port. */
  teardown: () => Promise<void>;
}

const DEFAULT_ENABLED: ReadonlyArray<CompatBackendId> = [
  "claude",
  "gemini",
  "lmstudio",
  "ollama"
];

/**
 * Model ids each mock backend's catalog exposes. The compat tests use these
 * as the `model` field in their SDK calls; the resolver maps `model → backend`
 * via the catalog populated at probe() time.
 *
 * If a mock fixture changes its catalog, update these constants in lockstep.
 */
export const COMPAT_MODELS: Record<CompatBackendId, { chat: string; embed?: string }> =
  {
    claude: { chat: "claude-sonnet-4-6" },
    gemini: { chat: "gemini-flash" },
    lmstudio: { chat: "mock-chat-model", embed: "mock-embed-model" },
    ollama: { chat: "llama3.2:latest", embed: "nomic-embed-text:latest" }
  };

/**
 * Build a `Config` value matching what the production `loadConfig` would
 * produce, with every backend disabled by default. Callers flip the enabled
 * flag on the backends they need and supply a workDir for file-store etc.
 */
function makeConfig(apiKey: string, workDir: string): Config {
  return {
    apiKey,
    claude: { enabled: false, command: "claude", priority: 100, timeoutMs: 10000 },
    gemini: { enabled: false, command: "gemini", priority: 90, timeoutMs: 10000 },
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
    archive: { dbPath: join(workDir, "archive.sqlite"), compressionLevel: 3 },
    embeddings: {
      legacyBackendUrl: "",
      legacyApiKey: "",
      legacyTimeoutMs: 30000
    },
    adminUi: { enabled: true, bindLocalhost: true, sessionTtlMs: 3600000 }
  } as Config;
}

/**
 * Boot a ClaudeMCP server on port 0 with the chosen backends registered
 * against the supplied mock fixtures. Returns base URL + API key + a teardown
 * the caller must `await` in `afterAll`.
 */
export async function buildCompatServer(
  opts: CompatServerOptions = {}
): Promise<CompatServerHandle> {
  const enabled = new Set<CompatBackendId>(opts.enabledBackends ?? DEFAULT_ENABLED);
  const apiKey =
    opts.apiKey ?? `compat-test-${Math.random().toString(36).slice(2, 12)}`;
  const workDir = mkdtempSync(join(tmpdir(), "claudemcp-compat-"));

  const lmHandles: MockLmStudioHandle[] = [];
  const ollamaHandles: MockOllamaHandle[] = [];

  const config = makeConfig(apiKey, workDir);

  const registry = new BackendRegistry({
    claude: 100,
    gemini: 90,
    lmstudio: 50,
    ollama: 40
  });

  // ---- Claude backend (mock CLI on PATH) -----------------------------------
  if (enabled.has("claude")) {
    registry.register(
      new ClaudeBackend({
        command: [process.execPath, MOCK_CLAUDE],
        timeoutMs: 10000
      })
    );
  }

  // ---- Gemini backend (mock CLI) -------------------------------------------
  if (enabled.has("gemini")) {
    registry.register(
      new GeminiBackend({
        command: [process.execPath, MOCK_GEMINI],
        timeoutMs: 10000
      })
    );
  }

  // ---- LM Studio backend (in-process mock HTTP) ----------------------------
  if (enabled.has("lmstudio")) {
    const lm = await startMockLmStudio({
      models: ["mock-chat-model", "mock-embed-model"]
    });
    lmHandles.push(lm);
    registry.register(
      new LMStudioBackend({
        enabled: true,
        instances: [
          {
            name: "local",
            baseUrl: lm.url,
            apiKey: "",
            priority: 50,
            timeoutMs: 10000,
            useNativeApi: null
          }
        ]
      })
    );
  }

  // ---- Ollama backend (subprocess mock HTTP) -------------------------------
  if (enabled.has("ollama")) {
    const ol = await startMockOllama();
    ollamaHandles.push(ol);
    registry.register(
      new OllamaBackend({
        enabled: true,
        useNativeApi: false,
        instances: [
          {
            name: "compat",
            baseUrl: ol.baseUrl,
            priority: 40,
            timeoutMs: 10000,
            useNativeApi: null
          }
        ]
      })
    );
  }

  // Probe so resolveModel() works immediately for the SDK's first request.
  await registry.probe();

  // ---- Build runtime deps + Express app ------------------------------------
  const archive = new Archive(config.archive.dbPath);
  const fileStore = new FileStore({
    dir: config.files.dir,
    ttlMs: config.files.ttlMs,
    maxTotalBytes: config.files.maxTotalBytes,
    // Disable sweep timer so it doesn't outlive teardown.
    sweepIntervalMs: 0
  });
  const responseCache = new ResponseCache({
    file: config.cache.file,
    ttlMs: config.cache.ttlMs,
    maxEntries: config.cache.maxEntries
  });
  const configSnapshot = new ConfigSnapshotStore({
    initial: config,
    path: join(workDir, "default.json")
  });

  const app = buildApp({
    config,
    registry,
    archive,
    fileStore,
    responseCache,
    configSnapshot
  });

  // Listen on port 0; Node assigns a free port on 127.0.0.1.
  const server: Server = await new Promise((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });

  const addr = server.address() as AddressInfo;
  const baseURL = `http://127.0.0.1:${addr.port}`;

  const teardown = async (): Promise<void> => {
    await new Promise<void>((res, rej) =>
      server.close((err) => (err ? rej(err) : res()))
    );
    registry.stop();
    fileStore.stop();
    archive.close();
    for (const lm of lmHandles) await lm.close();
    for (const ol of ollamaHandles) await ol.stop();
  };

  return { baseURL, apiKey, registry, teardown };
}
