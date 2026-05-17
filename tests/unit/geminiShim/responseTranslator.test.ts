import { describe, expect, it } from "vitest";
import {
  normalizedEventsToGeminiFinalResponse,
  normalizedEventsToGeminiSSE
} from "../../../src/geminiShim/responseTranslator.js";
import type { NormalizedEvent } from "../../../src/backends/types.js";

async function* fromArray(events: NormalizedEvent[]): AsyncIterable<NormalizedEvent> {
  for (const e of events) yield e;
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

function parseSseChunk(chunk: string): unknown {
  const data = chunk.replace(/^data:\s*/, "").trimEnd();
  return JSON.parse(data);
}

const META = { model: "gemini-pro" };

describe("normalizedEventsToGeminiSSE — text only", () => {
  it("emits a data: <JSON>\\n\\n chunk per delta", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "hello " },
      { kind: "text_delta", index: 0, text: "world" },
      { kind: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    expect(chunks.length).toBe(3);
    for (const c of chunks) {
      expect(c.startsWith("data: ")).toBe(true);
      expect(c.endsWith("\n\n")).toBe(true);
    }
  });

  it("final chunk carries finishReason STOP and usageMetadata", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!) as {
      candidates: { finishReason?: string }[];
      usageMetadata: unknown;
    };
    expect(last.candidates[0]?.finishReason).toBe("STOP");
    expect(last.usageMetadata).toBeDefined();
  });

  it("accumulated text reproduces the original", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "hello " },
      { kind: "text_delta", index: 0, text: "world" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!) as {
      candidates: { content: { parts: { text?: string }[] } }[];
    };
    const text = last.candidates[0]?.content.parts.map((p) => p.text ?? "").join("");
    expect(text).toBe("hello world");
  });

  it("model field uses meta.model when source omits message_start", async () => {
    const events: NormalizedEvent[] = [
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!) as { modelVersion: string };
    expect(last.modelVersion).toBe("gemini-pro");
  });
});

describe("normalizedEventsToGeminiSSE — finishReason mapping", () => {
  async function reasonInFinal(
    reason: Extract<NormalizedEvent, { kind: "message_stop" }>["stopReason"]
  ): Promise<string | undefined> {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: reason }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!) as {
      candidates: { finishReason?: string }[];
    };
    return last.candidates[0]?.finishReason;
  }

  it("end_turn → STOP", async () => { expect(await reasonInFinal("end_turn")).toBe("STOP"); });
  it("stop_sequence → STOP", async () => { expect(await reasonInFinal("stop_sequence")).toBe("STOP"); });
  it("max_tokens → MAX_TOKENS", async () => { expect(await reasonInFinal("max_tokens")).toBe("MAX_TOKENS"); });
  it("tool_use → STOP", async () => { expect(await reasonInFinal("tool_use")).toBe("STOP"); });
  it("error → OTHER", async () => { expect(await reasonInFinal("error")).toBe("OTHER"); });
});

describe("normalizedEventsToGeminiSSE — tool_use", () => {
  it("emits a functionCall part on the final chunk", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "tool_use_start", index: 0, id: "call_abc", name: "calc" },
      { kind: "tool_use_delta", index: 0, partialJson: '{"x":1,"y":2}' },
      { kind: "tool_use_stop", index: 0 },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!) as {
      candidates: { content: { parts: Array<{ functionCall?: { name: string; args: unknown } }> } }[];
    };
    const fc = last.candidates[0]?.content.parts.find((p) => p.functionCall);
    expect(fc?.functionCall?.name).toBe("calc");
    expect(fc?.functionCall?.args).toEqual({ x: 1, y: 2 });
  });

  it("multiple tool_use blocks at different indices each produce a functionCall part", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "tool_use_start", index: 0, id: "c1", name: "a" },
      { kind: "tool_use_delta", index: 0, partialJson: "{}" },
      { kind: "tool_use_stop", index: 0 },
      { kind: "tool_use_start", index: 1, id: "c2", name: "b" },
      { kind: "tool_use_delta", index: 1, partialJson: "{}" },
      { kind: "tool_use_stop", index: 1 },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!) as {
      candidates: { content: { parts: Array<{ functionCall?: { name: string } }> } }[];
    };
    const names = last.candidates[0]?.content.parts
      .filter((p) => p.functionCall)
      .map((p) => p.functionCall?.name);
    expect(names).toEqual(["a", "b"]);
  });

  it("partial JSON from multiple deltas is concatenated and parsed at stop time", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "tool_use_start", index: 0, id: "c1", name: "split" },
      { kind: "tool_use_delta", index: 0, partialJson: '{"x":' },
      { kind: "tool_use_delta", index: 0, partialJson: "42}" },
      { kind: "tool_use_stop", index: 0 },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!) as {
      candidates: { content: { parts: Array<{ functionCall?: { args: unknown } }> } }[];
    };
    expect(last.candidates[0]?.content.parts[0]?.functionCall?.args).toEqual({ x: 42 });
  });
});

describe("normalizedEventsToGeminiSSE — safetyRatings + synthesis", () => {
  it("each candidate carries safetyRatings: []", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    for (const c of chunks) {
      const obj = parseSseChunk(c) as {
        candidates: { safetyRatings: unknown[] }[];
      };
      expect(obj.candidates[0]?.safetyRatings).toEqual([]);
    }
  });

  it("synthesizes a final chunk when source stream ends without message_stop", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "hi" }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!) as {
      candidates: { finishReason?: string }[];
    };
    expect(last.candidates[0]?.finishReason).toBe("OTHER");
  });
});

describe("normalizedEventsToGeminiFinalResponse — buffered", () => {
  it("assembles a single text part from concatenated deltas", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "hello " },
      { kind: "text_delta", index: 0, text: "world" },
      { kind: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } }
    ];
    const resp = await normalizedEventsToGeminiFinalResponse(fromArray(events), META);
    expect(resp.candidates[0]?.content.parts).toEqual([{ text: "hello world" }]);
    expect(resp.candidates[0]?.finishReason).toBe("STOP");
    expect(resp.candidates[0]?.safetyRatings).toEqual([]);
    expect(resp.usageMetadata?.promptTokenCount).toBe(5);
    expect(resp.usageMetadata?.candidatesTokenCount).toBe(2);
    expect(resp.usageMetadata?.totalTokenCount).toBe(7);
  });

  it("assembles a tool_use as functionCall part with parsed args", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "tool_use_start", index: 0, id: "c1", name: "calc" },
      { kind: "tool_use_delta", index: 0, partialJson: '{"x":1}' },
      { kind: "tool_use_stop", index: 0 },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const resp = await normalizedEventsToGeminiFinalResponse(fromArray(events), META);
    const part = resp.candidates[0]?.content.parts[0];
    expect(part).toEqual({ functionCall: { name: "calc", args: { x: 1 } } });
  });

  it("interleaved text + tool_use preserves arrival order", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "thinking..." },
      { kind: "tool_use_start", index: 1, id: "c1", name: "calc" },
      { kind: "tool_use_delta", index: 1, partialJson: "{}" },
      { kind: "tool_use_stop", index: 1 },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const resp = await normalizedEventsToGeminiFinalResponse(fromArray(events), META);
    const parts = resp.candidates[0]?.content.parts ?? [];
    expect(parts.length).toBe(2);
    expect((parts[0] as { text?: string }).text).toBe("thinking...");
    expect((parts[1] as { functionCall?: unknown }).functionCall).toBeDefined();
  });

  it("returns zeroed usageMetadata when source omits usage", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const resp = await normalizedEventsToGeminiFinalResponse(fromArray(events), META);
    expect(resp.usageMetadata).toEqual({
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0
    });
  });

  it("empty event stream returns a valid empty-candidate body", async () => {
    const resp = await normalizedEventsToGeminiFinalResponse(fromArray([]), META);
    expect(resp.candidates).toHaveLength(1);
    expect(resp.candidates[0]?.content.parts).toEqual([]);
    expect(resp.candidates[0]?.finishReason).toBe("OTHER");
  });
});
