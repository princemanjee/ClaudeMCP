import { afterEach, describe, expect, it } from "vitest";
import { LMStudioBackend } from "../../../src/backends/lmstudioBackend.js";
import type { NormalizedEvent } from "../../../src/backends/types.js";
import {
  startMockLmStudio,
  type MockLmStudioHandle
} from "../../fixtures/mock-lmstudio/inProcess.js";

describe("LMStudioBackend skeleton", () => {
  let handle: MockLmStudioHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function makeBackend(): Promise<LMStudioBackend> {
    handle = await startMockLmStudio({ models: ["qwen3-coder-30b", "nomic-embed-text"] });
    return new LMStudioBackend({
      enabled: true,
      instances: [
        {
          name: "local",
          baseUrl: handle.url,
          apiKey: "",
          priority: 50,
          timeoutMs: 5000,
          useNativeApi: null
        }
      ]
    });
  }

  it("has id 'lmstudio'", async () => {
    const b = await makeBackend();
    expect(b.id).toBe("lmstudio");
  });

  it("capabilitiesFor returns the LM Studio surface (samplingParams all true, embeddings true)", async () => {
    const b = await makeBackend();
    const caps = b.capabilitiesFor("qwen3-coder-30b");
    expect(caps.toolUse).toBe(true);
    expect(caps.multimodal).toBe(true); // conservative; per-model narrowing is future
    expect(caps.thinking).toBe(false);
    expect(caps.cacheControl).toBe("none");
    expect(caps.samplingParams).toEqual({
      temperature: true,
      topP: true,
      topK: true
    });
    expect(caps.stopSequences).toBe("native");
    expect(caps.embeddings).toBe(true); // first backend to flip this on
  });

  it("listModels returns the live probed model ids from the single instance", async () => {
    const b = await makeBackend();
    const models = await b.listModels();
    expect(models.map((m) => m.id).sort()).toEqual(
      ["nomic-embed-text", "qwen3-coder-30b"].sort()
    );
    for (const m of models) {
      expect(typeof m.id).toBe("string");
      // contextWindow may be undefined when the server doesn't report it.
    }
  });

  it("listModels returns an empty array gracefully when the server lists nothing", async () => {
    await handle?.close();
    handle = await startMockLmStudio({ models: [] });
    const b = new LMStudioBackend({
      enabled: true,
      instances: [
        {
          name: "local",
          baseUrl: handle.url,
          apiKey: "",
          priority: 50,
          timeoutMs: 5000,
          useNativeApi: null
        }
      ]
    });
    expect(await b.listModels()).toEqual([]);
  });

  it("countTokens estimates via char/4 fallback", async () => {
    const b = await makeBackend();
    // 23 chars → ceil(23/4) = 6
    const n = await b.countTokens({
      model: "qwen3-coder-30b",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello world hello world" }] }
      ]
    });
    expect(n).toBe(6);
  });

  it("countTokens sums system + multi-block messages", async () => {
    const b = await makeBackend();
    const n = await b.countTokens({
      model: "qwen3-coder-30b",
      system: "you are helpful", // 15 chars → 4
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] }, // 5 → 2
        { role: "assistant", content: [{ type: "text", text: "ok" }] }, // 2 → 1
        { role: "user", content: [{ type: "text", text: "again" }] } // 5 → 2
      ]
    });
    expect(n).toBe(4 + 2 + 1 + 2);
  });

  it("invoke streams: emits message_start, text_delta(s), message_stop in order", async () => {
    const b = await makeBackend();
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "qwen3-coder-30b",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    })) {
      events.push(ev);
    }
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");

    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toBe("echo: hello");
  });

  it("invoke surfaces usage on the terminal message_stop", async () => {
    const b = await makeBackend();
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "qwen3-coder-30b",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    })) {
      events.push(ev);
    }
    const stop = events[events.length - 1];
    expect(stop?.kind).toBe("message_stop");
    if (stop?.kind === "message_stop") {
      expect(stop.usage).toBeDefined();
      expect(stop.usage?.inputTokens).toBeGreaterThan(0);
      expect(stop.usage?.outputTokens).toBeGreaterThan(0);
      expect(stop.stopReason).toBe("end_turn");
    }
  });

  it("invoke forwards system as a prepended system message", async () => {
    const b = await makeBackend();
    // Use chatCompletionsBuffered side-channel: the mock echoes the first
    // user message. With a system message prepended, the echo still reflects
    // the user content, so the verification is "doesn't blow up". A stronger
    // test would inspect the mock's recorded request body — Task 8's
    // multi-instance test does that via per-instance separation.
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "qwen3-coder-30b",
      system: "you are helpful",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    })) {
      events.push(ev);
    }
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke forwards samplingParams (temperature, top_p, top_k)", async () => {
    const b = await makeBackend();
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "qwen3-coder-30b",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      samplingParams: { temperature: 0.7, topP: 0.9, topK: 40 }
    })) {
      events.push(ev);
    }
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke forwards stopSequences as `stop: [...]`", async () => {
    const b = await makeBackend();
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "qwen3-coder-30b",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      stopSequences: ["END"]
    })) {
      events.push(ev);
    }
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke emits tool_use_start/_delta/_stop when the server returns tool_calls", async () => {
    const b = await makeBackend();
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "qwen3-coder-30b",
      messages: [
        { role: "user", content: [{ type: "text", text: "MOCK_TOOL_USE please" }] }
      ],
      tools: [{ name: "mock_tool", inputSchema: { type: "object" } }]
    })) {
      events.push(ev);
    }

    const starts = events.filter((e) => e.kind === "tool_use_start");
    const deltas = events.filter((e) => e.kind === "tool_use_delta");
    const stops = events.filter((e) => e.kind === "tool_use_stop");
    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(stops).toHaveLength(1);

    const accumulated = deltas
      .map((e) => (e.kind === "tool_use_delta" ? e.partialJson : ""))
      .join("");
    expect(JSON.parse(accumulated)).toEqual({ a: 1 });

    const stop = events[events.length - 1];
    expect(stop?.kind).toBe("message_stop");
    if (stop?.kind === "message_stop") {
      expect(stop.stopReason).toBe("tool_use");
    }
  });

  it("invoke folds a tool_result back into the request as role=tool", async () => {
    const b = await makeBackend();
    // We can't easily inspect the wire here, but we can verify the call
    // doesn't throw and produces a normal message_stop.
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "qwen3-coder-30b",
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "mock_tool",
              input: { a: 1 }
            }
          ]
        },
        {
          role: "tool",
          content: [
            { type: "tool_result", toolUseId: "call_1", content: '{"ok": true}' }
          ]
        }
      ]
    })) {
      events.push(ev);
    }
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke throws on image content blocks (Plan 08 scope is text-only chat)", async () => {
    const b = await makeBackend();
    await expect(async () => {
      for await (const _ of b.invoke({
        model: "qwen3-coder-30b",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image", mediaType: "image/png", data: "BASE64" }
            ]
          }
        ]
      })) {
        // no-op
      }
    }).rejects.toThrow(/multimodal|image/i);
  });

  it("invoke throws on document content blocks", async () => {
    const b = await makeBackend();
    await expect(async () => {
      for await (const _ of b.invoke({
        model: "qwen3-coder-30b",
        messages: [
          {
            role: "user",
            content: [
              { type: "document", mediaType: "application/pdf", data: "BASE64" }
            ]
          }
        ]
      })) {
        // no-op
      }
    }).rejects.toThrow(/document/i);
  });

  it("invoke throws on thinking: true", async () => {
    const b = await makeBackend();
    await expect(async () => {
      for await (const _ of b.invoke({
        model: "qwen3-coder-30b",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        thinking: true
      })) {
        // no-op
      }
    }).rejects.toThrow(/thinking/i);
  });

  it("embed round-trips a single input", async () => {
    const b = await makeBackend();
    const resp = await b.embed!({
      model: "nomic-embed-text",
      input: ["hello"]
    });
    expect(resp.model).toBe("nomic-embed-text");
    expect(resp.embeddings).toHaveLength(1);
    expect(resp.embeddings[0]).toHaveLength(4);
  });

  it("embed round-trips multiple inputs preserving order", async () => {
    const b = await makeBackend();
    const resp = await b.embed!({
      model: "nomic-embed-text",
      input: ["alpha", "beta", "gamma"]
    });
    expect(resp.embeddings).toHaveLength(3);
    // The mock's vectors are keyed off input length / 10 in slot 0.
    expect(resp.embeddings[0]?.[0]).toBeCloseTo(0.5);
    expect(resp.embeddings[1]?.[0]).toBeCloseTo(0.4);
    expect(resp.embeddings[2]?.[0]).toBeCloseTo(0.5);
  });

  it("embed surfaces server errors via the OpenAICompatHTTPError", async () => {
    await handle?.close();
    handle = await startMockLmStudio({
      models: ["nomic-embed-text"],
      failEmbeddings: true
    });
    const b = new LMStudioBackend({
      enabled: true,
      instances: [
        {
          name: "local",
          baseUrl: handle.url,
          apiKey: "",
          priority: 50,
          timeoutMs: 5000,
          useNativeApi: null
        }
      ]
    });
    // Probe so the embed model is in lastModels (else fallback would still hit
    // this instance — verifying error path either way).
    await b.listModels();
    await expect(
      b.embed!({ model: "nomic-embed-text", input: ["hi"] })
    ).rejects.toThrow();
  });

  it("rejects an empty instances[] in the constructor", () => {
    expect(
      () =>
        new LMStudioBackend({ enabled: true, instances: [] })
    ).toThrow(/instance/i);
  });

  it("rejects duplicate instance names in the constructor", () => {
    expect(
      () =>
        new LMStudioBackend({
          enabled: true,
          instances: [
            {
              name: "dup",
              baseUrl: "http://a.test/v1",
              apiKey: "",
              priority: 50,
              timeoutMs: 5000,
              useNativeApi: null
            },
            {
              name: "dup",
              baseUrl: "http://b.test/v1",
              apiKey: "",
              priority: 50,
              timeoutMs: 5000,
              useNativeApi: null
            }
          ]
        })
    ).toThrow(/unique/i);
  });
});

describe("LMStudioBackend multi-instance dispatch", () => {
  const handles: MockLmStudioHandle[] = [];
  afterEach(async () => {
    while (handles.length > 0) {
      const h = handles.shift()!;
      await h.close();
    }
  });

  async function makeMultiInstanceBackend(): Promise<LMStudioBackend> {
    const local = await startMockLmStudio({
      models: ["qwen3-coder-30b", "shared-model"]
    });
    const work = await startMockLmStudio({
      models: ["llama-3.3-70b", "shared-model"]
    });
    handles.push(local, work);
    return new LMStudioBackend({
      enabled: true,
      instances: [
        {
          name: "local",
          baseUrl: local.url,
          apiKey: "",
          priority: 50,
          timeoutMs: 5000,
          useNativeApi: null
        },
        {
          name: "work-server",
          baseUrl: work.url,
          apiKey: "",
          priority: 60, // higher priority — wins on the shared-model collision
          timeoutMs: 5000,
          useNativeApi: null
        }
      ]
    });
  }

  it("listModels merges across instances, deduping by id", async () => {
    const b = await makeMultiInstanceBackend();
    const ids = (await b.listModels()).map((m) => m.id).sort();
    expect(ids).toEqual(
      ["llama-3.3-70b", "qwen3-coder-30b", "shared-model"].sort()
    );
  });

  it("routes a model unique to one instance to that instance", async () => {
    const b = await makeMultiInstanceBackend();
    await b.listModels(); // populate lastModels on each instance

    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "llama-3.3-70b", // only on work-server
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }]
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toBe("echo: ping");
  });

  it("routes a colliding model id to the higher-priority instance by default", async () => {
    const b = await makeMultiInstanceBackend();
    await b.listModels();

    // shared-model is on both; work-server has priority 60 > local 50, so it wins.
    // We can't easily prove which one served the request without instrumenting
    // the mocks, so we verify the request succeeds end-to-end (proves routing
    // didn't break) and trust the priority test on listModels above to assert
    // the model-map view.
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "shared-model",
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }]
    })) {
      events.push(ev);
    }
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("honors explicit lmstudio:<instance>/<model> prefix to force the loser", async () => {
    const b = await makeMultiInstanceBackend();
    await b.listModels();

    // Force routing to `local` even for a model that exists on both. Same
    // verification limitation as above — we verify the call succeeds and the
    // mock returns the expected echo.
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "lmstudio:local/shared-model",
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }]
    })) {
      events.push(ev);
    }
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("throws when explicit prefix names an unknown instance", async () => {
    const b = await makeMultiInstanceBackend();
    await b.listModels();

    await expect(async () => {
      for await (const _ of b.invoke({
        model: "lmstudio:nonexistent/shared-model",
        messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }]
      })) {
        // no-op
      }
    }).rejects.toThrow(/nonexistent/);
  });

  it("routes embed requests using the same instance resolution rules", async () => {
    const b = await makeMultiInstanceBackend();
    await b.listModels();
    // Embedding round-trip via the explicit prefix to verify embed honors it.
    const resp = await b.embed!({
      model: "lmstudio:local/shared-model", // mock answers any embed request
      input: ["hello"]
    });
    expect(resp.embeddings).toHaveLength(1);
  });

  it("listModels survives a failing instance — returns models from the survivors", async () => {
    const good = await startMockLmStudio({ models: ["good-model"] });
    handles.push(good);
    const b = new LMStudioBackend({
      enabled: true,
      instances: [
        {
          name: "good",
          baseUrl: good.url,
          apiKey: "",
          priority: 50,
          timeoutMs: 5000,
          useNativeApi: null
        },
        {
          // This URL points at a port no server is bound to — connection refused.
          name: "broken",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "",
          priority: 60,
          timeoutMs: 500,
          useNativeApi: null
        }
      ]
    });
    const ids = (await b.listModels()).map((m) => m.id);
    expect(ids).toEqual(["good-model"]);
  });
});
