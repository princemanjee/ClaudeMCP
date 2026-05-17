import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "../../../src/backends/types.js";
import {
  normalizedEventsToOpenAIFinalResponse,
  normalizedEventsToOpenAISSE
} from "../../../src/openaiShim/responseTranslator.js";
import type {
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionResponse,
  OpenAIChunkMeta
} from "../../../src/openaiShim/types.js";

const META: OpenAIChunkMeta = {
  id: "chatcmpl-test",
  model: "claude-sonnet-4-6",
  created: 1700000000
};

async function* eventsFrom(arr: NormalizedEvent[]): AsyncIterable<NormalizedEvent> {
  for (const e of arr) yield e;
}

async function collectChunks(
  events: NormalizedEvent[]
): Promise<OpenAIChatCompletionChunk[]> {
  const out: OpenAIChatCompletionChunk[] = [];
  for await (const sse of normalizedEventsToOpenAISSE(
    eventsFrom(events),
    META
  )) {
    expect(sse.startsWith("data: ")).toBe(true);
    expect(sse.endsWith("\n\n")).toBe(true);
    const json = JSON.parse(sse.slice("data: ".length).trim());
    out.push(json);
  }
  return out;
}

async function bufferedBody(
  events: NormalizedEvent[]
): Promise<OpenAIChatCompletionResponse> {
  const { body } = await normalizedEventsToOpenAIFinalResponse(
    eventsFrom(events),
    META
  );
  return body;
}

describe("normalizedEventsToOpenAISSE — ANSWER mode", () => {
  it("first chunk is the role-only opener", async () => {
    const chunks = await collectChunks([
      { kind: "message_start", model: "test" },
      { kind: "text_delta", index: 0, text: "the answer is 42" },
      { kind: "message_stop", stopReason: "end_turn" }
    ]);
    const first = chunks[0]!;
    expect(first.choices[0]?.delta).toEqual({ role: "assistant" });
    expect(first.choices[0]?.finish_reason).toBeNull();
  });

  it("emits content chunks for text after classification", async () => {
    const chunks = await collectChunks([
      { kind: "text_delta", index: 0, text: "the answer is 42 yes" },
      { kind: "text_delta", index: 0, text: " plus more" },
      { kind: "text_delta", index: 0, text: " end" },
      { kind: "message_stop", stopReason: "end_turn" }
    ]);
    // Opener + classify-emit + 2 passthroughs + final.
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    const contentChunks = chunks.filter(
      (c) => typeof c.choices[0]?.delta.content === "string"
    );
    const merged = contentChunks
      .map((c) => c.choices[0]?.delta.content ?? "")
      .join("");
    expect(merged).toContain("the answer is 42 yes");
    expect(merged).toContain("plus more");
    expect(merged).toContain("end");
  });

  it("last chunk carries finish_reason 'stop' and usage", async () => {
    const chunks = await collectChunks([
      { kind: "text_delta", index: 0, text: "this is long enough" },
      {
        kind: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 10 }
      }
    ]);
    const last = chunks[chunks.length - 1]!;
    expect(last.choices[0]?.finish_reason).toBe("stop");
    expect(last.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 10,
      total_tokens: 15
    });
  });

  it("message_stop.stopReason 'max_tokens' maps to finish_reason 'length'", async () => {
    const chunks = await collectChunks([
      { kind: "text_delta", index: 0, text: "this is long enough text" },
      { kind: "message_stop", stopReason: "max_tokens" }
    ]);
    const last = chunks[chunks.length - 1]!;
    expect(last.choices[0]?.finish_reason).toBe("length");
  });

  it("last chunk shape matches OpenAI's documented schema", async () => {
    const chunks = await collectChunks([
      { kind: "text_delta", index: 0, text: "abcdefghij" },
      {
        kind: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 }
      }
    ]);
    const last = chunks[chunks.length - 1]!;
    expect(last).toMatchObject({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "claude-sonnet-4-6",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2
      }
    });
  });
});

describe("normalizedEventsToOpenAISSE — TOOL mode", () => {
  it("single <tool_use> block emits one tool_calls chunk", async () => {
    const chunks = await collectChunks([
      {
        kind: "text_delta",
        index: 0,
        text: '<tool_use>{"name":"search","arguments":{"q":"x"}}</tool_use>'
      },
      { kind: "message_stop", stopReason: "tool_use" }
    ]);
    const toolChunks = chunks.filter(
      (c) => c.choices[0]?.delta.tool_calls !== undefined
    );
    expect(toolChunks).toHaveLength(1);
    const tc = toolChunks[0]!.choices[0]!.delta.tool_calls![0]!;
    expect(tc.index).toBe(0);
    expect(tc.id).toMatch(/^call_/);
    expect(tc.type).toBe("function");
    expect(tc.function?.name).toBe("search");
    expect(tc.function?.arguments).toBe('{"q":"x"}');
  });

  it("multiple <tool_use> blocks each emit a chunk with incrementing index", async () => {
    const chunks = await collectChunks([
      {
        kind: "text_delta",
        index: 0,
        text:
          '<tool_use>{"name":"a","arguments":{}}</tool_use>\n' +
          '<tool_use>{"name":"b","arguments":{}}</tool_use>'
      },
      { kind: "message_stop", stopReason: "tool_use" }
    ]);
    const toolChunks = chunks.filter(
      (c) => c.choices[0]?.delta.tool_calls !== undefined
    );
    expect(toolChunks).toHaveLength(2);
    expect(toolChunks[0]?.choices[0]?.delta.tool_calls?.[0]?.index).toBe(0);
    expect(toolChunks[1]?.choices[0]?.delta.tool_calls?.[0]?.index).toBe(1);
  });

  it("arguments field is a JSON string (per OpenAI wire format)", async () => {
    const chunks = await collectChunks([
      {
        kind: "text_delta",
        index: 0,
        text: '<tool_use>{"name":"x","arguments":{"a":1,"b":[2,3]}}</tool_use>'
      },
      { kind: "message_stop", stopReason: "tool_use" }
    ]);
    const toolChunk = chunks.find(
      (c) => c.choices[0]?.delta.tool_calls !== undefined
    )!;
    const args = toolChunk.choices[0]!.delta.tool_calls![0]!.function!.arguments!;
    expect(typeof args).toBe("string");
    const reparsed = JSON.parse(args);
    expect(reparsed).toEqual({ a: 1, b: [2, 3] });
  });

  it("final chunk carries finish_reason 'tool_calls'", async () => {
    const chunks = await collectChunks([
      {
        kind: "text_delta",
        index: 0,
        text: '<tool_use>{"name":"x","arguments":{}}</tool_use>'
      },
      { kind: "message_stop", stopReason: "tool_use" }
    ]);
    expect(chunks[chunks.length - 1]?.choices[0]?.finish_reason).toBe(
      "tool_calls"
    );
  });

  it("partial <tool_use> across multiple deltas buffers correctly", async () => {
    const chunks = await collectChunks([
      { kind: "text_delta", index: 0, text: "<tool_use>" },
      { kind: "text_delta", index: 0, text: '{"name":"sea' },
      { kind: "text_delta", index: 0, text: 'rch","arguments":{"q":"x"}}</tool_use>' },
      { kind: "message_stop", stopReason: "tool_use" }
    ]);
    const toolChunks = chunks.filter(
      (c) => c.choices[0]?.delta.tool_calls !== undefined
    );
    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0]?.choices[0]?.delta.tool_calls?.[0]?.function?.name).toBe(
      "search"
    );
  });

  it("incomplete <tool_use> at stream end falls back to content mode", async () => {
    const chunks = await collectChunks([
      { kind: "text_delta", index: 0, text: '<tool_use>{"name":"x"' },
      { kind: "message_stop", stopReason: "end_turn" }
    ]);
    const last = chunks[chunks.length - 1]!;
    expect(last.choices[0]?.finish_reason).toBe("stop");
    // Some prior chunk should carry the buffer as content fallback.
    const contentChunks = chunks.filter(
      (c) => typeof c.choices[0]?.delta.content === "string"
    );
    const merged = contentChunks
      .map((c) => c.choices[0]?.delta.content ?? "")
      .join("");
    expect(merged).toContain('<tool_use>{"name":"x"');
  });
});

describe("normalizedEventsToOpenAISSE — UNKNOWN mode short-buffer behavior", () => {
  it("text shorter than MIN_CLASSIFY_LEN waits before classifying", async () => {
    const chunks = await collectChunks([
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ]);
    // Opener + content fallback + final.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const contentChunks = chunks.filter(
      (c) => typeof c.choices[0]?.delta.content === "string"
    );
    expect(contentChunks.map((c) => c.choices[0]?.delta.content).join("")).toBe(
      "hi"
    );
    expect(chunks[chunks.length - 1]?.choices[0]?.finish_reason).toBe("stop");
  });

  it("text exactly MIN_CLASSIFY_LEN classifies as ANSWER", async () => {
    const chunks = await collectChunks([
      { kind: "text_delta", index: 0, text: "abcdefghij" }, // 10 chars
      { kind: "message_stop", stopReason: "end_turn" }
    ]);
    const contentChunks = chunks.filter(
      (c) => typeof c.choices[0]?.delta.content === "string"
    );
    expect(contentChunks[0]?.choices[0]?.delta.content).toBe("abcdefghij");
  });

  it("leading whitespace is stripped during classification", async () => {
    const chunks = await collectChunks([
      {
        kind: "text_delta",
        index: 0,
        text: '   <tool_use>{"name":"x","arguments":{}}</tool_use>'
      },
      { kind: "message_stop", stopReason: "tool_use" }
    ]);
    const toolChunks = chunks.filter(
      (c) => c.choices[0]?.delta.tool_calls !== undefined
    );
    expect(toolChunks).toHaveLength(1);
  });
});

describe("normalizedEventsToOpenAIFinalResponse — body shape", () => {
  it("returns a chat.completion body with stop finish_reason on plain text", async () => {
    const body = await bufferedBody([
      { kind: "text_delta", index: 0, text: "hello world" },
      { kind: "message_stop", stopReason: "end_turn" }
    ]);
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.choices[0]?.message.content).toBe("hello world");
    expect(body.choices[0]?.message.role).toBe("assistant");
  });

  it("tool_calls parse populates message.tool_calls with content: null and finish_reason 'tool_calls'", async () => {
    const body = await bufferedBody([
      {
        kind: "text_delta",
        index: 0,
        text: '<tool_use>{"name":"search","arguments":{"q":"x"}}</tool_use>'
      },
      { kind: "message_stop", stopReason: "tool_use" }
    ]);
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
    expect(body.choices[0]?.message.content).toBeNull();
    expect(body.choices[0]?.message.tool_calls).toHaveLength(1);
    expect(body.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("search");
    expect(body.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe(
      '{"q":"x"}'
    );
  });

  it("usage block populated from message_stop.usage", async () => {
    const body = await bufferedBody([
      { kind: "text_delta", index: 0, text: "ok" },
      {
        kind: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 3, outputTokens: 7 }
      }
    ]);
    expect(body.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 7,
      total_tokens: 10
    });
  });

  it("incomplete <tool_use> at end falls back to content", async () => {
    const body = await bufferedBody([
      { kind: "text_delta", index: 0, text: '<tool_use>{"name":"x"' },
      { kind: "message_stop", stopReason: "end_turn" }
    ]);
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.choices[0]?.message.content).toContain('<tool_use>{"name":"x"');
  });

  it("empty event stream returns a valid empty-content body with finish_reason 'stop'", async () => {
    const body = await bufferedBody([
      { kind: "message_stop", stopReason: "end_turn" }
    ]);
    expect(body.choices[0]?.message.content).toBe("");
    expect(body.choices[0]?.finish_reason).toBe("stop");
  });
});

describe("legacy parity", () => {
  it("buffered body matches concatenation of streamed content chunks for plain text", async () => {
    const events: NormalizedEvent[] = [
      { kind: "text_delta", index: 0, text: "the answer is 42 because" },
      { kind: "text_delta", index: 0, text: " of reasons" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const body = await bufferedBody(events);
    const chunks = await collectChunks(events);
    const merged = chunks
      .filter((c) => typeof c.choices[0]?.delta.content === "string")
      .map((c) => c.choices[0]?.delta.content ?? "")
      .join("");
    expect(merged).toBe(body.choices[0]?.message.content);
  });

  it("buffered body matches streamed tool_calls assembly", async () => {
    const events: NormalizedEvent[] = [
      {
        kind: "text_delta",
        index: 0,
        text:
          '<tool_use>{"name":"a","arguments":{}}</tool_use>\n' +
          '<tool_use>{"name":"b","arguments":{}}</tool_use>'
      },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const body = await bufferedBody(events);
    const chunks = await collectChunks(events);
    const streamedToolNames = chunks
      .filter((c) => c.choices[0]?.delta.tool_calls)
      .map((c) => c.choices[0]?.delta.tool_calls?.[0]?.function?.name);
    const bufferedToolNames = body.choices[0]?.message.tool_calls?.map(
      (c) => c.function.name
    );
    expect(streamedToolNames).toEqual(bufferedToolNames);
  });
});
