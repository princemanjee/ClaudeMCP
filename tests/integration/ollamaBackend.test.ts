import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BackendRegistry } from "../../src/backends/registry.js";
import { OllamaBackend } from "../../src/backends/ollamaBackend.js";
import { startMockOllama, type MockOllamaHandle } from "../helpers/mockOllamaProcess.js";
import type { NormalizedEvent } from "../../src/backends/types.js";

describe("OllamaBackend integrates with BackendRegistry — dual instance, dual mode", () => {
  let mockCompat: MockOllamaHandle;
  let mockNative: MockOllamaHandle;
  let registry: BackendRegistry;

  beforeAll(async () => {
    mockCompat = await startMockOllama();
    mockNative = await startMockOllama();

    registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });

    registry.register(
      new OllamaBackend({
        enabled: true,
        useNativeApi: false, // backend-wide default
        instances: [
          // instance "compat" inherits the false default
          {
            name: "compat",
            baseUrl: mockCompat.baseUrl,
            priority: 60,
            timeoutMs: 5000,
            useNativeApi: null
          },
          // instance "native" overrides to true
          {
            name: "native",
            baseUrl: mockNative.baseUrl,
            priority: 30,
            timeoutMs: 5000,
            useNativeApi: true
          }
        ]
      })
    );
  });

  afterAll(async () => {
    registry.stop();
    await mockCompat.stop();
    await mockNative.stop();
  });

  it("probe succeeds; registry lists ollama as ok", async () => {
    await registry.probe();
    expect(registry.lastProbeStatus("ollama")?.ok).toBe(true);
    expect(registry.resolveModel("llama-3.3-70b")?.id).toBe("ollama");
  });

  it("per-instance mode resolution survives end-to-end (compat-inherits, native-overrides)", async () => {
    await registry.probe();
    const backend = registry.resolveModel("llama-3.3-70b");
    expect(backend?.id).toBe("ollama");
    // Cast back to OllamaBackend to verify mode resolution directly. This is
    // grey-box: the registry's surface only exposes Backend, so we know the
    // concrete type because we registered it ourselves above.
    const concrete = backend as OllamaBackend;
    expect(concrete.instanceMode("compat")).toBe("compat");
    expect(concrete.instanceMode("native")).toBe("native");
  });

  it("invoke through the registry returns a fully-normalized event stream", async () => {
    await registry.probe();
    const backend = registry.resolveModel("llama-3.3-70b");
    expect(backend).toBeDefined();
    const events: NormalizedEvent[] = [];
    for await (const ev of backend!.invoke({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: [{ type: "text", text: "integration ping" }] }]
    })) {
      events.push(ev);
    }
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
    const text = events
      .filter((e): e is Extract<NormalizedEvent, { kind: "text_delta" }> => e.kind === "text_delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("echo: integration ping");
  });

  it("embed through the registry round-trips a vector batch", async () => {
    await registry.probe();
    const backend = registry.resolveModel("nomic-embed-text");
    expect(backend?.id).toBe("ollama");
    expect(typeof backend?.embed).toBe("function");
    const resp = await backend!.embed!({
      model: "nomic-embed-text",
      input: ["hello", "world"]
    });
    expect(resp.embeddings.length).toBe(2);
    expect(resp.embeddings[0]?.length).toBeGreaterThan(0);
  });

  it("countTokens returns a positive number", async () => {
    await registry.probe();
    const backend = registry.resolveModel("llama-3.3-70b");
    const n = await backend!.countTokens({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: [{ type: "text", text: "tokens please" }] }]
    });
    expect(n).toBeGreaterThan(0);
  });
});
