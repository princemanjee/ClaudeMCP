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

    // Registry + router.
    // NOTE: claude/gemini priorities live on cfg.<backend>.priority because those
    // backends are single-instance. lmstudio/ollama priorities live per-instance
    // in cfg.<backend>.instances[*].priority — in Plan 01 we use literal defaults
    // here since the per-instance map isn't materialized until a real HTTP backend
    // registers in Plan 08+.
    const registry = new BackendRegistry({
      claude: cfg.claude.priority,
      gemini: cfg.gemini.priority,
      lmstudio: 50,
      ollama: 40
    });

    // Register two stubs that share a model id ("shared-model") to exercise
    // the priority-based collision resolution end-to-end.
    registry.register(
      stubBackend("claude", ["claude-opus-4-7", "shared-model"])
    );
    registry.register(stubBackend("ollama", ["llama-3.3-70b", "shared-model"]));
    await registry.probe();

    // Direct alias hit — router resolves without registry lookup.
    const directHit = identifyBackend("claude-opus-4-7", cfg.router.defaultBackend);
    expect(directHit.backend).toBe("claude");

    // Bare local model — router defers to registry, which resolves to ollama.
    const lookupNeeded = identifyBackend("llama-3.3-70b", cfg.router.defaultBackend);
    expect(lookupNeeded.backend).toBeNull();
    expect(registry.resolveModel(lookupNeeded.remainingModel)?.id).toBe("ollama");

    // Collision: both backends advertised "shared-model" — claude (priority
    // 100) outranks ollama (priority 40), so claude must win.
    expect(registry.resolveModel("shared-model")?.id).toBe("claude");

    // End-to-end stream contract: invoke the resolved backend, collect events.
    const resolved = registry.resolveModel("claude-opus-4-7");
    expect(resolved).toBeDefined();
    const events: NormalizedEvent[] = [];
    for await (const ev of resolved!.invoke({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    })) {
      events.push(ev);
    }
    expect(events.map((e) => e.kind)).toEqual([
      "message_start",
      "text_delta",
      "message_stop"
    ]);

    registry.stop();
  });
});
