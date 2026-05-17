import { describe, expect, it } from "vitest";
import {
  normalizedEventsToFinalResponse,
  normalizedEventsToSSE
} from "../../../src/anthropicShim/responseTranslator.js";
import type { NormalizedEvent } from "../../../src/backends/types.js";

async function* fromArray(events: NormalizedEvent[]): AsyncIterable<NormalizedEvent> {
  for (const e of events) yield e;
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function parseSseChunk(chunk: string): { event: string; data: unknown } {
  const lines = chunk.split("\n");
  const event = lines[0]?.replace(/^event:\s*/, "") ?? "";
  const data = lines[1]?.replace(/^data:\s*/, "") ?? "";
  return { event, data: JSON.parse(data) };
}

const META = { messageId: "msg_test_001", model: "claude-sonnet-4-6" };

describe("normalizedEventsToSSE — single text block", () => {
  it("emits the documented Anthropic event sequence", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hello " },
      { kind: "text_delta", index: 0, text: "world" },
      {
        kind: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 2 }
      }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const parsed = chunks.map(parseSseChunk);
    expect(parsed.map((p) => p.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]);
  });

  it("message_start carries id, model, role, and zeroed usage", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const start = parseSseChunk(chunks[0]!);
    expect(start.event).toBe("message_start");
    expect(start.data).toMatchObject({
      type: "message_start",
      message: {
        id: "msg_test_001",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  });

  it("content_block_start carries index and empty text block", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const start = parseSseChunk(chunks[1]!);
    expect(start.event).toBe("content_block_start");
    expect(start.data).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    });
  });

  it("content_block_delta carries index and text_delta", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hello" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const delta = parseSseChunk(chunks[2]!);
    expect(delta.event).toBe("content_block_delta");
    expect(delta.data).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" }
    });
  });

  it("message_delta carries stop_reason and usage", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hi" },
      {
        kind: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 2 }
      }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const messageDelta = parseSseChunk(chunks[chunks.length - 2]!);
    expect(messageDelta.event).toBe("message_delta");
    expect(messageDelta.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 }
    });
  });

  it("each emitted chunk is a complete Anthropic SSE event", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    for (const chunk of chunks) {
      expect(chunk.startsWith("event: ")).toBe(true);
      expect(chunk.endsWith("\n\n")).toBe(true);
      expect(chunk.split("\n").filter((l) => l.startsWith("data: "))).toHaveLength(1);
    }
  });

  it("synthesizes message_start when the source stream omits it", async () => {
    const events: NormalizedEvent[] = [
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    expect(parseSseChunk(chunks[0]!).event).toBe("message_start");
  });

  it("synthesizes message_stop when the source stream ends without one", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hi" }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!);
    expect(last.event).toBe("message_stop");
  });
});

describe("normalizedEventsToSSE — stop_reason mapping", () => {
  async function stopReasonInResponse(
    reason: NonNullable<
      Extract<NormalizedEvent, { kind: "message_stop" }>["stopReason"]
    >
  ): Promise<unknown> {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: reason }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const messageDelta = parseSseChunk(chunks[chunks.length - 2]!);
    return (messageDelta.data as { delta: { stop_reason: unknown } }).delta.stop_reason;
  }

  it("maps end_turn → end_turn", async () => {
    expect(await stopReasonInResponse("end_turn")).toBe("end_turn");
  });

  it("maps stop_sequence → stop_sequence", async () => {
    expect(await stopReasonInResponse("stop_sequence")).toBe("stop_sequence");
  });

  it("maps max_tokens → max_tokens", async () => {
    expect(await stopReasonInResponse("max_tokens")).toBe("max_tokens");
  });

  it("maps tool_use → tool_use", async () => {
    expect(await stopReasonInResponse("tool_use")).toBe("tool_use");
  });

  it("maps error → null", async () => {
    expect(await stopReasonInResponse("error")).toBeNull();
  });
});

describe("normalizedEventsToFinalResponse — non-streaming aggregation", () => {
  it("assembles a single text block from concatenated deltas", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hello " },
      { kind: "text_delta", index: 0, text: "world" },
      {
        kind: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 2 }
      }
    ];
    const resp = await normalizedEventsToFinalResponse(fromArray(events), META);
    expect(resp).toEqual({
      id: "msg_test_001",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hello world" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 }
    });
  });

  it("returns zeroed usage when the source provides none", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const resp = await normalizedEventsToFinalResponse(fromArray(events), META);
    expect(resp.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("returns stop_reason null on error events", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "partial" },
      { kind: "message_stop", stopReason: "error" }
    ];
    const resp = await normalizedEventsToFinalResponse(fromArray(events), META);
    expect(resp.stop_reason).toBeNull();
  });

  it("model field uses meta.model (not the backend's reported model id)", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "DIFFERENT-MODEL" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const resp = await normalizedEventsToFinalResponse(fromArray(events), META);
    expect(resp.model).toBe("claude-sonnet-4-6");
  });

  it("empty event stream returns an empty content array and stop_reason null", async () => {
    const events: NormalizedEvent[] = [];
    const resp = await normalizedEventsToFinalResponse(fromArray(events), META);
    expect(resp.content).toEqual([]);
    expect(resp.stop_reason).toBeNull();
  });
});
