import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config.js";
import { checkAuth } from "../../src/auth.js";
import { Archive } from "../../src/archive.js";
import { identifyBackend } from "../../src/modelRouter.js";
import { BackendRegistry } from "../../src/backends/registry.js";
import type {
  Backend,
  BackendCapabilities,
  NormalizedEvent
} from "../../src/backends/types.js";

function stubBackend(id: Backend["id"], modelIds: string[]): Backend {
  const caps: BackendCapabilities = {
    toolUse: true,
    multimodal: false,
    thinking: false,
    cacheControl: "none",
    samplingParams: { temperature: false, topP: false, topK: false },
    stopSequences: "server-side-cut",
    embeddings: false
  };
  return {
    id,
    capabilitiesFor: () => caps,
    listModels: async () => modelIds.map((m) => ({ id: m })),
    invoke: async function* (): AsyncIterable<NormalizedEvent> {
      yield { kind: "message_start", model: modelIds[0] ?? "unknown" };
      yield { kind: "text_delta", index: 0, text: "ok" };
      yield { kind: "message_stop", stopReason: "end_turn" };
    },
    countTokens: async () => 1
  };
}

describe("Plan 01 foundation cooperates end-to-end", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-found-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads config, validates auth, opens archive, probes registry, identifies backend", async () => {
    const cfgPath = join(dir, "config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        apiKey: "sk-integration-key",
        claude: { enabled: true, command: "claude" },
        gemini: { enabled: true, command: "gemini" },
        lmstudio: { enabled: true, instances: [] },
        ollama: { enabled: true, useNativeApi: false, instances: [] },
        archive: { dbPath: join(dir, "archive.sqlite"), compressionLevel: 3 }
      })
    );
    const cfg = loadConfig(cfgPath);

    // Auth
    expect(
      checkAuth({ headers: { "x-api-key": "sk-integration-key" }, query: {} }, cfg.apiKey)
    ).toBe(true);

    // Archive
    const archive = new Archive(cfg.archive.dbPath);
    try {
      expect(archive.raw().prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
    } finally {
      archive.close();
    }

    // Registry + router
    const registry = new BackendRegistry({
      claude: cfg.claude.priority,
      gemini: cfg.gemini.priority,
      lmstudio: 50,
      ollama: 40
    });
    registry.register(stubBackend("claude", ["claude-opus-4-7"]));
    registry.register(stubBackend("ollama", ["llama-3.3-70b"]));
    await registry.probe();

    const directHit = identifyBackend("claude-opus-4-7", cfg.router.defaultBackend);
    expect(directHit.backend).toBe("claude");

    const lookupNeeded = identifyBackend("llama-3.3-70b", cfg.router.defaultBackend);
    expect(lookupNeeded.backend).toBeNull();
    expect(registry.resolveModel(lookupNeeded.remainingModel)?.id).toBe("ollama");

    registry.stop();
  });
});
