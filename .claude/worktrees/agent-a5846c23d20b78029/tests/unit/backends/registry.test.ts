import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendRegistry } from "../../../src/backends/registry.js";
import type {
  Backend,
  BackendCapabilities,
  ModelDescriptor,
  NormalizedEvent
} from "../../../src/backends/types.js";

function makeBackend(opts: {
  id: Backend["id"];
  priority?: number;
  models?: string[];
  probeError?: Error;
}): Backend & { listModelsMock: ReturnType<typeof vi.fn> } {
  const caps: BackendCapabilities = {
    toolUse: true,
    multimodal: false,
    thinking: false,
    cacheControl: "none",
    samplingParams: { temperature: false, topP: false, topK: false },
    stopSequences: "server-side-cut",
    embeddings: false
  };
  const listModelsMock = vi.fn(async () => {
    if (opts.probeError) throw opts.probeError;
    return (opts.models ?? []).map<ModelDescriptor>((id) => ({ id }));
  });
  return {
    id: opts.id,
    capabilitiesFor: () => caps,
    listModels: listModelsMock,
    invoke: async function* (): AsyncIterable<NormalizedEvent> {
      // pragma: no cover
    },
    countTokens: async () => 0,
    listModelsMock
  };
}

describe("BackendRegistry", () => {
  let registry: BackendRegistry;

  beforeEach(() => {
    registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
  });

  afterEach(() => {
    registry.stop();
  });

  it("starts empty", () => {
    expect(registry.enabledBackends()).toEqual([]);
    expect(registry.get("claude")).toBeUndefined();
    expect(registry.resolveModel("anything")).toBeUndefined();
  });

  it("registers and retrieves a backend", () => {
    const claude = makeBackend({ id: "claude" });
    registry.register(claude);
    expect(registry.get("claude")).toBe(claude);
    expect(registry.enabledBackends().map((b) => b.id)).toEqual(["claude"]);
  });

  it("probe() populates modelMap from each backend's listModels()", async () => {
    const claude = makeBackend({ id: "claude", models: ["claude-opus-4-7"] });
    const ollama = makeBackend({ id: "ollama", models: ["llama-3.3-70b"] });
    registry.register(claude);
    registry.register(ollama);

    await registry.probe();

    expect(registry.resolveModel("claude-opus-4-7")?.id).toBe("claude");
    expect(registry.resolveModel("llama-3.3-70b")?.id).toBe("ollama");
    expect(claude.listModelsMock).toHaveBeenCalledOnce();
  });

  it("higher-priority backend wins on model-id collision", async () => {
    const lmstudio = makeBackend({ id: "lmstudio", models: ["shared-model"] });
    const ollama = makeBackend({ id: "ollama", models: ["shared-model"] });
    registry.register(lmstudio);
    registry.register(ollama);

    await registry.probe();

    // lmstudio priority 50 > ollama priority 40
    expect(registry.resolveModel("shared-model")?.id).toBe("lmstudio");
  });

  it("collision winner flips when priorities are reversed", async () => {
    // Override priorities so ollama outranks lmstudio.
    const flipped = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 40,
      ollama: 50
    });
    try {
      const lmstudio = makeBackend({ id: "lmstudio", models: ["shared-model"] });
      const ollama = makeBackend({ id: "ollama", models: ["shared-model"] });
      flipped.register(lmstudio);
      flipped.register(ollama);

      await flipped.probe();

      expect(flipped.resolveModel("shared-model")?.id).toBe("ollama");
    } finally {
      flipped.stop();
    }
  });

  it("probe failures do not crash, leave the failing backend with no models", async () => {
    const ok = makeBackend({ id: "claude", models: ["claude-opus-4-7"] });
    const bad = makeBackend({
      id: "gemini",
      probeError: new Error("connection refused")
    });
    registry.register(ok);
    registry.register(bad);

    const result = await registry.probe();

    expect(result.failures.map((f) => f.backendId)).toEqual(["gemini"]);
    expect(registry.resolveModel("claude-opus-4-7")?.id).toBe("claude");
    expect(registry.lastProbeStatus("gemini")?.ok).toBe(false);
    expect(registry.lastProbeStatus("claude")?.ok).toBe(true);
  });

  it("startPeriodicProbe schedules repeated probes at the given interval", async () => {
    vi.useFakeTimers();
    const claude = makeBackend({ id: "claude", models: ["claude-opus-4-7"] });
    registry.register(claude);
    registry.startPeriodicProbe(1000);

    await vi.advanceTimersByTimeAsync(0); // initial immediate probe
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(claude.listModelsMock).toHaveBeenCalledTimes(3);
    registry.stop();
    vi.useRealTimers();
  });

  it("stop() halts the periodic probe", async () => {
    vi.useFakeTimers();
    const claude = makeBackend({ id: "claude" });
    registry.register(claude);
    registry.startPeriodicProbe(1000);

    await vi.advanceTimersByTimeAsync(0);
    registry.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(claude.listModelsMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("startPeriodicProbe is idempotent — calling twice replaces the prior interval", async () => {
    vi.useFakeTimers();
    const claude = makeBackend({ id: "claude" });
    registry.register(claude);

    registry.startPeriodicProbe(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(claude.listModelsMock).toHaveBeenCalledTimes(1);

    // Second start should replace, not stack.
    registry.startPeriodicProbe(2000);
    await vi.advanceTimersByTimeAsync(0); // second immediate probe

    // Advance by the first interval (1000ms) — no extra call (interval replaced).
    await vi.advanceTimersByTimeAsync(1000);
    // Advance by the new interval (2000ms total elapsed since second start).
    await vi.advanceTimersByTimeAsync(1000); // total 2000 from second start

    // Expected: 1 (initial) + 1 (re-start initial) + 1 (one tick of 2000ms interval) = 3
    expect(claude.listModelsMock).toHaveBeenCalledTimes(3);
    registry.stop();
    vi.useRealTimers();
  });

  it("accepts partial PriorityMap (Plan 02+ tests may register fewer than four backends)", async () => {
    // Build a registry with only claude's priority specified.
    const partial = new BackendRegistry({ claude: 100 });
    try {
      const claude = makeBackend({ id: "claude", models: ["claude-opus-4-7"] });
      const ollama = makeBackend({ id: "ollama", models: ["llama-3.3-70b"] });
      partial.register(claude);
      partial.register(ollama); // ollama priority unset — defaults to 0 via `?? 0`

      await partial.probe();

      expect(partial.resolveModel("claude-opus-4-7")?.id).toBe("claude");
      expect(partial.resolveModel("llama-3.3-70b")?.id).toBe("ollama");
    } finally {
      partial.stop();
    }
  });
});
