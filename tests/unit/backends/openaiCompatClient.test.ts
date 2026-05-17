import { afterEach, describe, expect, it } from "vitest";
import {
  OpenAICompatClient,
  OpenAICompatHTTPError,
  OpenAICompatTimeoutError
} from "../../../src/backends/openaiCompatClient.js";
import {
  startMockLmStudio,
  type MockLmStudioHandle
} from "../../fixtures/mock-lmstudio/inProcess.js";

describe("OpenAICompatClient — constructor + listModels", () => {
  let handle: MockLmStudioHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("constructs with baseUrl and reads back the configured fields", () => {
    const c = new OpenAICompatClient({
      baseUrl: "http://example.test/v1",
      apiKey: "secret",
      timeoutMs: 12345
    });
    expect(c.baseUrl).toBe("http://example.test/v1");
    expect(c.timeoutMs).toBe(12345);
  });

  it("strips a trailing slash from baseUrl", () => {
    const c = new OpenAICompatClient({
      baseUrl: "http://example.test/v1/",
      timeoutMs: 100
    });
    expect(c.baseUrl).toBe("http://example.test/v1");
  });

  it("listModels returns data[] from the server", async () => {
    handle = await startMockLmStudio({ models: ["a", "b", "c"] });
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    const data = (await c.listModels()) as Array<{ id: string }>;
    expect(data.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("listModels forwards Authorization bearer when apiKey is set", async () => {
    handle = await startMockLmStudio({
      models: ["only-with-bearer"],
      requiredBearer: "topsecret"
    });
    const c = new OpenAICompatClient({
      baseUrl: handle.url,
      apiKey: "topsecret",
      timeoutMs: 5000
    });
    const data = (await c.listModels()) as Array<{ id: string }>;
    expect(data.map((m) => m.id)).toEqual(["only-with-bearer"]);
  });

  it("listModels throws OpenAICompatHTTPError on 401", async () => {
    handle = await startMockLmStudio({
      models: ["x"],
      requiredBearer: "right-bearer"
    });
    const c = new OpenAICompatClient({
      baseUrl: handle.url,
      apiKey: "wrong-bearer",
      timeoutMs: 5000
    });
    await expect(c.listModels()).rejects.toBeInstanceOf(OpenAICompatHTTPError);
    try {
      await c.listModels();
    } catch (e) {
      expect(e).toBeInstanceOf(OpenAICompatHTTPError);
      const err = e as OpenAICompatHTTPError;
      expect(err.status).toBe(401);
      expect(err.body).toMatchObject({ error: { type: "auth_error" } });
    }
  });

  it("listModels throws OpenAICompatTimeoutError when client timeout fires", async () => {
    handle = await startMockLmStudio({ latencyMs: 5000 });
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 100 });
    await expect(c.listModels()).rejects.toBeInstanceOf(
      OpenAICompatTimeoutError
    );
  });
});

describe("OpenAICompatClient — chatCompletions (streaming)", () => {
  let handle: MockLmStudioHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const ev of stream) out.push(ev);
    return out;
  }

  it("yields one parsed object per SSE event, excluding [DONE]", async () => {
    handle = await startMockLmStudio();
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    const events = await collect(
      c.chatCompletions({
        model: "mock-chat-model",
        messages: [{ role: "user", content: "hello" }],
        stream: true
      })
    );
    expect(events.length).toBeGreaterThan(0);

    // First event: role=assistant (the OpenAI convention).
    const first = events[0] as {
      choices?: Array<{ delta?: { role?: string } }>;
    };
    expect(first.choices?.[0]?.delta?.role).toBe("assistant");

    // Last event: finish_reason: "stop".
    const last = events[events.length - 1] as {
      choices?: Array<{ finish_reason?: string }>;
    };
    expect(last.choices?.[0]?.finish_reason).toBe("stop");
  });

  it("concatenated content deltas reproduce the reply text", async () => {
    handle = await startMockLmStudio();
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    const events = await collect(
      c.chatCompletions({
        model: "mock-chat-model",
        messages: [{ role: "user", content: "hello" }],
        stream: true
      })
    );
    const text = events
      .map((e) => {
        const obj = e as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        return obj.choices?.[0]?.delta?.content ?? "";
      })
      .join("");
    expect(text).toBe("echo: hello");
  });

  it("yields tool_call deltas when the server returns them", async () => {
    handle = await startMockLmStudio();
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    const events = await collect(
      c.chatCompletions({
        model: "mock-chat-model",
        messages: [{ role: "user", content: "MOCK_TOOL_USE please" }],
        tools: [
          {
            type: "function",
            function: { name: "mock_tool", parameters: { type: "object" } }
          }
        ],
        stream: true
      })
    );
    const hasToolDelta = events.some((e) => {
      const obj = e as {
        choices?: Array<{ delta?: { tool_calls?: unknown } }>;
      };
      return Array.isArray(obj.choices?.[0]?.delta?.tool_calls);
    });
    expect(hasToolDelta).toBe(true);
    const last = events[events.length - 1] as {
      choices?: Array<{ finish_reason?: string }>;
    };
    expect(last.choices?.[0]?.finish_reason).toBe("tool_calls");
  });

  it("throws OpenAICompatHTTPError on 5xx before any events are yielded", async () => {
    handle = await startMockLmStudio({ failChat: true });
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    await expect(async () => {
      for await (const _ of c.chatCompletions({
        model: "mock-chat-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true
      })) {
        // no-op
      }
    }).rejects.toBeInstanceOf(OpenAICompatHTTPError);
  });

  it("times out long-running streams via AbortController", async () => {
    handle = await startMockLmStudio({ latencyMs: 5000 });
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 100 });
    await expect(async () => {
      for await (const _ of c.chatCompletions({
        model: "mock-chat-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true
      })) {
        // no-op
      }
    }).rejects.toBeInstanceOf(OpenAICompatTimeoutError);
  });
});

describe("OpenAICompatClient — chatCompletionsBuffered (non-streaming)", () => {
  let handle: MockLmStudioHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("returns the full response JSON", async () => {
    handle = await startMockLmStudio();
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    const resp = (await c.chatCompletionsBuffered({
      model: "mock-chat-model",
      messages: [{ role: "user", content: "hello" }]
    })) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { total_tokens: number };
    };
    expect(resp.choices[0]?.message.content).toBe("echo: hello");
    expect(resp.choices[0]?.finish_reason).toBe("stop");
    expect(resp.usage.total_tokens).toBeGreaterThan(0);
  });

  it("throws on 5xx", async () => {
    handle = await startMockLmStudio({ failChat: true });
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    await expect(
      c.chatCompletionsBuffered({
        model: "mock-chat-model",
        messages: [{ role: "user", content: "hi" }]
      })
    ).rejects.toBeInstanceOf(OpenAICompatHTTPError);
  });
});
