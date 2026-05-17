import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { OllamaBackend, type OllamaBackendConfig } from "../../../src/backends/ollamaBackend.js";
import { startMockOllama, type MockOllamaHandle } from "../../helpers/mockOllamaProcess.js";

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

  it("invoke against unreachable instance surfaces a connection error", async () => {
    // After Task 7, invoke() actually dispatches; verify it surfaces the
    // unreachable host as an error rather than silently hanging.
    const backend = new OllamaBackend(makeConfig());
    await expect(async () => {
      for await (const _ of backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      })) {
        // no-op
      }
    }).rejects.toThrow();
  });

  it("embed against unreachable instance surfaces a connection error", async () => {
    // After Task 9, embed() actually dispatches; verify it surfaces the
    // unreachable host as an error rather than silently hanging.
    const backend = new OllamaBackend(makeConfig());
    await expect(
      backend.embed!({ model: "nomic-embed-text", input: ["hello"] })
    ).rejects.toThrow();
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

describe("OllamaBackend.listModels (compat mode)", () => {
  let mock: MockOllamaHandle;
  let backend: OllamaBackend;

  beforeAll(async () => {
    mock = await startMockOllama();
    backend = new OllamaBackend({
      enabled: true,
      useNativeApi: false,
      instances: [
        { name: "local", baseUrl: mock.baseUrl, priority: 40, timeoutMs: 5000, useNativeApi: null }
      ]
    });
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("returns models from /v1/models", async () => {
    const models = await backend.listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("llama-3.3-70b");
    expect(ids).toContain("nomic-embed-text");
  });
});

describe("OllamaBackend.listModels (native mode)", () => {
  let mock: MockOllamaHandle;
  let backend: OllamaBackend;

  beforeAll(async () => {
    mock = await startMockOllama();
    backend = new OllamaBackend({
      enabled: true,
      useNativeApi: true,
      instances: [
        { name: "local", baseUrl: mock.baseUrl, priority: 40, timeoutMs: 5000, useNativeApi: null }
      ]
    });
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("returns models from /api/tags", async () => {
    const models = await backend.listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("llama-3.3-70b");
    expect(ids).toContain("nomic-embed-text");
  });

  it("each ModelDescriptor carries a parsed-from-tags description", async () => {
    const models = await backend.listModels();
    const llama = models.find((m) => m.id === "llama-3.3-70b");
    expect(llama?.description).toBeDefined();
    expect(typeof llama?.description).toBe("string");
  });
});

describe("OllamaBackend.listModels (multi-instance dedup + priority)", () => {
  let mockA: MockOllamaHandle;
  let mockB: MockOllamaHandle;
  let backend: OllamaBackend;

  beforeAll(async () => {
    mockA = await startMockOllama();
    mockB = await startMockOllama();
    backend = new OllamaBackend({
      enabled: true,
      useNativeApi: false,
      instances: [
        { name: "high", baseUrl: mockA.baseUrl, priority: 100, timeoutMs: 5000, useNativeApi: null },
        { name: "low", baseUrl: mockB.baseUrl, priority: 10, timeoutMs: 5000, useNativeApi: true }
      ]
    });
  });

  afterAll(async () => {
    await mockA.stop();
    await mockB.stop();
  });

  it("dedupes overlapping model ids, keeping the higher-priority entry", async () => {
    const models = await backend.listModels();
    // mockA + mockB both report llama-3.3-70b; only one should remain.
    const llamaEntries = models.filter((m) => m.id === "llama-3.3-70b");
    expect(llamaEntries.length).toBe(1);
  });
});

describe("OllamaBackend.listModels (instance probe failure does not crash)", () => {
  let mock: MockOllamaHandle;
  let backend: OllamaBackend;

  beforeAll(async () => {
    mock = await startMockOllama();
    backend = new OllamaBackend({
      enabled: true,
      useNativeApi: false,
      instances: [
        { name: "ok", baseUrl: mock.baseUrl, priority: 40, timeoutMs: 5000, useNativeApi: null },
        { name: "bad", baseUrl: "http://127.0.0.1:1", priority: 10, timeoutMs: 500, useNativeApi: null }
      ]
    });
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("returns models from reachable instances even when others fail", async () => {
    const models = await backend.listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("llama-3.3-70b");
  });
});

describe("OllamaBackend.invoke (compat mode)", () => {
  let mock: MockOllamaHandle;
  let backend: OllamaBackend;

  beforeAll(async () => {
    mock = await startMockOllama();
    backend = new OllamaBackend({
      enabled: true,
      useNativeApi: false,
      instances: [
        { name: "local", baseUrl: mock.baseUrl, priority: 40, timeoutMs: 5000, useNativeApi: null }
      ]
    });
    // Cause listModels to populate the instance-owner cache.
    await backend.listModels();
  });

  afterAll(async () => {
    await mock.stop();
  });

  async function collect(it: AsyncIterable<import("../../../src/backends/types.js").NormalizedEvent>): Promise<import("../../../src/backends/types.js").NormalizedEvent[]> {
    const out: import("../../../src/backends/types.js").NormalizedEvent[] = [];
    for await (const ev of it) out.push(ev);
    return out;
  }

  it("emits message_start → text_delta(s) → message_stop for a normal chat", async () => {
    const events = await collect(
      backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
      })
    );
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
    const text = events
      .filter((e): e is Extract<import("../../../src/backends/types.js").NormalizedEvent, { kind: "text_delta" }> => e.kind === "text_delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("echo: hello");
  });

  it("forwards samplingParams as flat fields (OpenAI-compat shape)", async () => {
    // The mock doesn't validate the request; success of this call is the contract.
    const events = await collect(
      backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        samplingParams: { temperature: 0.5, topP: 0.9, topK: 40 },
        maxTokens: 100,
        stopSequences: ["END"]
      })
    );
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("emits tool_use events for tool_calls (compat mode)", async () => {
    const events = await collect(
      backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "MOCK_TOOL_CALL" }] }],
        tools: [{ name: "echo", inputSchema: { type: "object" } }]
      })
    );
    expect(events.some((e) => e.kind === "tool_use_start")).toBe(true);
    expect(events.some((e) => e.kind === "tool_use_delta")).toBe(true);
    expect(events.some((e) => e.kind === "tool_use_stop")).toBe(true);
  });

  it("propagates HTTP 500 as a thrown error from the iterator", async () => {
    await expect(async () => {
      for await (const _ of backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "MOCK_ERROR" }] }]
      })) {
        // no-op
      }
    }).rejects.toThrow();
  });
});

describe("OllamaBackend.invoke (native mode)", () => {
  let mock: MockOllamaHandle;
  let backend: OllamaBackend;

  beforeAll(async () => {
    mock = await startMockOllama();
    backend = new OllamaBackend({
      enabled: true,
      useNativeApi: true,
      instances: [
        { name: "local", baseUrl: mock.baseUrl, priority: 40, timeoutMs: 5000, useNativeApi: null }
      ]
    });
    await backend.listModels();
  });

  afterAll(async () => {
    await mock.stop();
  });

  async function collect(it: AsyncIterable<import("../../../src/backends/types.js").NormalizedEvent>): Promise<import("../../../src/backends/types.js").NormalizedEvent[]> {
    const out: import("../../../src/backends/types.js").NormalizedEvent[] = [];
    for await (const ev of it) out.push(ev);
    return out;
  }

  it("emits message_start → text_delta(s) → message_stop for a normal chat", async () => {
    const events = await collect(
      backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
      })
    );
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
    const text = events
      .filter((e): e is Extract<import("../../../src/backends/types.js").NormalizedEvent, { kind: "text_delta" }> => e.kind === "text_delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("echo: hello");
  });

  it("usage on message_stop comes from prompt_eval_count + eval_count", async () => {
    const events = await collect(
      backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
      })
    );
    const stop = events[events.length - 1];
    if (stop?.kind !== "message_stop") throw new Error("expected message_stop");
    expect(stop.usage?.inputTokens).toBeGreaterThan(0);
    expect(stop.usage?.outputTokens).toBeGreaterThan(0);
  });

  it("emits tool_use events for tool_calls (native mode), stopReason=tool_use", async () => {
    const events = await collect(
      backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "MOCK_TOOL_CALL" }] }],
        tools: [{ name: "echo", inputSchema: { type: "object" } }]
      })
    );
    const starts = events.filter((e) => e.kind === "tool_use_start");
    const deltas = events.filter((e) => e.kind === "tool_use_delta");
    const stops = events.filter((e) => e.kind === "tool_use_stop");
    expect(starts.length).toBe(1);
    expect(deltas.length).toBe(1);
    expect(stops.length).toBe(1);
    const finalStop = events[events.length - 1];
    if (finalStop?.kind !== "message_stop") throw new Error("expected message_stop");
    expect(finalStop.stopReason).toBe("tool_use");
  });

  it("translates samplingParams into options.{temperature, top_p, top_k}", async () => {
    // The mock doesn't validate the body; success of the round-trip is what
    // we assert here. The shape contract is exercised more strictly in the
    // unit-level translator helper test below.
    const events = await collect(
      backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        samplingParams: { temperature: 0.7, topP: 0.95, topK: 64 },
        maxTokens: 256,
        stopSequences: ["DONE"]
      })
    );
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("includes keep_alive in the request body by default (verified via translator helper)", () => {
    const body = (backend as unknown as {
      buildNativeBody: (req: import("../../../src/backends/types.js").NormalizedRequest) => Record<string, unknown>;
    }).buildNativeBody({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    });
    expect(body.keep_alive).toBe("5m");
    expect(body.stream).toBe(true);
  });

  it("translator: sampling params land under options, not flat", () => {
    const body = (backend as unknown as {
      buildNativeBody: (req: import("../../../src/backends/types.js").NormalizedRequest) => Record<string, unknown>;
    }).buildNativeBody({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      samplingParams: { temperature: 0.5, topP: 0.9, topK: 30 },
      maxTokens: 128,
      stopSequences: ["END"]
    });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    const options = body.options as Record<string, unknown>;
    expect(options.temperature).toBe(0.5);
    expect(options.top_p).toBe(0.9);
    expect(options.top_k).toBe(30);
    expect(options.num_predict).toBe(128);
    expect(options.stop).toEqual(["END"]);
  });

  it("translator: format: \"json\" landed when req.metadata.format === 'json'", () => {
    const body = (backend as unknown as {
      buildNativeBody: (req: import("../../../src/backends/types.js").NormalizedRequest) => Record<string, unknown>;
    }).buildNativeBody({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      metadata: { format: "json" }
    });
    expect(body.format).toBe("json");
  });

  it("translator: image blocks lift onto user message as images: [...]", () => {
    const body = (backend as unknown as {
      buildNativeBody: (req: import("../../../src/backends/types.js").NormalizedRequest) => Record<string, unknown>;
    }).buildNativeBody({
      model: "llama-3.3-70b",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", mediaType: "image/png", data: "QkFTRTY0IGltYWdlIGRhdGE=" }
          ]
        }
      ]
    });
    const messages = body.messages as Array<{ role: string; content: string; images?: string[] }>;
    expect(messages[0]?.images).toEqual(["QkFTRTY0IGltYWdlIGRhdGE="]);
    expect(messages[0]?.content).toBe("what is this?");
  });

  it("translator: assistant tool_use → tool_calls; tool_result → role=tool message", () => {
    const body = (backend as unknown as {
      buildNativeBody: (req: import("../../../src/backends/types.js").NormalizedRequest) => Record<string, unknown>;
    }).buildNativeBody({
      model: "llama-3.3-70b",
      messages: [
        { role: "user", content: [{ type: "text", text: "use the tool" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool_use", id: "call_42", name: "echo", input: { text: "x" } }
          ]
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolUseId: "call_42", content: "ok" }]
        }
      ]
    });
    const messages = body.messages as Array<{
      role: string;
      content: string;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      tool_call_id?: string;
    }>;
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.tool_calls?.[0]?.id).toBe("call_42");
    expect(messages[1]?.tool_calls?.[0]?.function.name).toBe("echo");
    expect(messages[2]?.role).toBe("tool");
    expect(messages[2]?.tool_call_id).toBe("call_42");
    expect(messages[2]?.content).toBe("ok");
  });
});
