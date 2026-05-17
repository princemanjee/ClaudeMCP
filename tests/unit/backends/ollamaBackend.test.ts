import { describe, expect, it } from "vitest";
import { OllamaBackend, type OllamaBackendConfig } from "../../../src/backends/ollamaBackend.js";

describe("OllamaBackend skeleton", () => {
  function makeConfig(overrides: Partial<OllamaBackendConfig> = {}): OllamaBackendConfig {
    return {
      enabled: true,
      useNativeApi: false,
      instances: [
        {
          name: "local",
          baseUrl: "http://127.0.0.1:11434",
          priority: 40,
          timeoutMs: 30000,
          useNativeApi: null
        }
      ],
      ...overrides
    };
  }

  it("has id 'ollama'", () => {
    const backend = new OllamaBackend(makeConfig());
    expect(backend.id).toBe("ollama");
  });

  it("constructor throws when instances array is empty", () => {
    expect(() => new OllamaBackend(makeConfig({ instances: [] }))).toThrow(/instance/i);
  });

  it("constructor throws when two instances share a name", () => {
    expect(() =>
      new OllamaBackend(
        makeConfig({
          instances: [
            { name: "a", baseUrl: "http://127.0.0.1:1", priority: 1, timeoutMs: 1000, useNativeApi: null },
            { name: "a", baseUrl: "http://127.0.0.1:2", priority: 1, timeoutMs: 1000, useNativeApi: null }
          ]
        })
      )
    ).toThrow(/unique/i);
  });

  it("capabilitiesFor returns the per-spec matrix (same across all models)", () => {
    const backend = new OllamaBackend(makeConfig());
    const caps = backend.capabilitiesFor("llama-3.3-70b");
    expect(caps.toolUse).toBe(true);
    expect(caps.multimodal).toBe(true);
    expect(caps.thinking).toBe(false);
    expect(caps.cacheControl).toBe("none");
    expect(caps.samplingParams).toEqual({ temperature: true, topP: true, topK: true });
    expect(caps.stopSequences).toBe("native");
    expect(caps.embeddings).toBe(true);
  });

  it("listModels stub returns an empty array (real listing lands in Task 6)", async () => {
    const backend = new OllamaBackend(makeConfig());
    const models = await backend.listModels();
    expect(models).toEqual([]);
  });

  it("invoke stub throws (lands in Task 7)", async () => {
    const backend = new OllamaBackend(makeConfig());
    await expect(async () => {
      for await (const _ of backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      })) {
        // no-op
      }
    }).rejects.toThrow(/invoke|Task/);
  });

  it("embed stub throws (lands in Task 9)", async () => {
    const backend = new OllamaBackend(makeConfig());
    await expect(
      backend.embed!({ model: "nomic-embed-text", input: ["hello"] })
    ).rejects.toThrow(/embed|Task/);
  });
});

describe("OllamaBackend per-instance mode resolution", () => {
  function inst(name: string, useNativeApi: boolean | null): OllamaBackendConfig["instances"][number] {
    return {
      name,
      baseUrl: `http://127.0.0.1:${name === "a" ? 11434 : name === "b" ? 11435 : 11436}`,
      priority: 40,
      timeoutMs: 30000,
      useNativeApi
    };
  }

  it("instance with null inherits backend default (false → compat)", () => {
    const backend = new OllamaBackend({
      enabled: true,
      useNativeApi: false,
      instances: [inst("a", null), inst("b", null), inst("c", null)]
    });
    expect(backend.instanceMode("a")).toBe("compat");
    expect(backend.instanceMode("b")).toBe("compat");
    expect(backend.instanceMode("c")).toBe("compat");
  });

  it("instance with null inherits backend default (true → native)", () => {
    const backend = new OllamaBackend({
      enabled: true,
      useNativeApi: true,
      instances: [inst("a", null), inst("b", null), inst("c", null)]
    });
    expect(backend.instanceMode("a")).toBe("native");
    expect(backend.instanceMode("b")).toBe("native");
    expect(backend.instanceMode("c")).toBe("native");
  });

  it("three-instance mixed resolution: inherit-compat, inherit-native (after default flip), override-opposite", () => {
    // Backend default is native; instance "a" overrides to compat; "b" inherits
    // native; "c" overrides to native explicitly (same as inherit but the
    // override path is exercised).
    const backend = new OllamaBackend({
      enabled: true,
      useNativeApi: true,
      instances: [inst("a", false), inst("b", null), inst("c", true)]
    });
    expect(backend.instanceMode("a")).toBe("compat");
    expect(backend.instanceMode("b")).toBe("native");
    expect(backend.instanceMode("c")).toBe("native");
  });

  it("instance with override true under default false works", () => {
    const backend = new OllamaBackend({
      enabled: true,
      useNativeApi: false,
      instances: [inst("a", true)]
    });
    expect(backend.instanceMode("a")).toBe("native");
  });

  it("instanceMode throws for unknown instance name", () => {
    const backend = new OllamaBackend({
      enabled: true,
      useNativeApi: false,
      instances: [inst("a", null)]
    });
    expect(() => backend.instanceMode("nope")).toThrow(/unknown instance/i);
  });
});
