import type { NormalizedEvent } from "../backends/types.js";
import type {
  AnthropicMessagesResponse,
  AnthropicResponseContentBlock,
  AnthropicStopReason
} from "./types.js";

export interface ResponseMeta {
  /** Anthropic message id ("msg_..."). Caller supplies. */
  messageId: string;
  /** Model id as the client requested it. */
  model: string;
}

function mapStopReason(
  reason: Extract<NormalizedEvent, { kind: "message_stop" }>["stopReason"]
): AnthropicStopReason | null {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "stop_sequence":
      return "stop_sequence";
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "error":
      return null;
  }
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Yield Anthropic-shaped SSE event strings for each NormalizedEvent.
 *
 * Synthesizes the leading `message_start` if the source stream omits it
 * (some backends emit text_delta first when there's no init event upstream).
 * Synthesizes the trailing `message_delta` + `message_stop` if the source
 * stream ends without one. Never emits content_block_start/stop for a block
 * that received zero deltas.
 */
export async function* normalizedEventsToSSE(
  events: AsyncIterable<NormalizedEvent>,
  meta: ResponseMeta
): AsyncIterable<string> {
  let startEmitted = false;
  // Track which content-block indexes have been opened so we can emit
  // start/stop pairs as deltas come and go. Value is the block kind so the
  // synthesized close path can stay symmetrical.
  const openBlocks = new Map<number, "text" | "tool_use">();
  let stopReason: AnthropicStopReason | null = null;
  let outputTokens = 0;
  let messageStopSent = false;

  function ensureStart(model: string): string | undefined {
    if (startEmitted) return undefined;
    startEmitted = true;
    return sse("message_start", {
      type: "message_start",
      message: {
        id: meta.messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  for await (const ev of events) {
    if (ev.kind === "message_start") {
      const chunk = ensureStart(ev.model || meta.model);
      if (chunk) yield chunk;
      continue;
    }

    if (ev.kind === "text_delta") {
      const chunk = ensureStart(meta.model);
      if (chunk) yield chunk;
      if (!openBlocks.has(ev.index)) {
        openBlocks.set(ev.index, "text");
        yield sse("content_block_start", {
          type: "content_block_start",
          index: ev.index,
          content_block: { type: "text", text: "" }
        });
      }
      yield sse("content_block_delta", {
        type: "content_block_delta",
        index: ev.index,
        delta: { type: "text_delta", text: ev.text }
      });
      continue;
    }

    if (ev.kind === "tool_use_start") {
      const chunk = ensureStart(meta.model);
      if (chunk) yield chunk;
      openBlocks.set(ev.index, "tool_use");
      yield sse("content_block_start", {
        type: "content_block_start",
        index: ev.index,
        content_block: { type: "tool_use", id: ev.id, name: ev.name, input: {} }
      });
      continue;
    }

    if (ev.kind === "tool_use_delta") {
      // No ensureStart — a tool_use_delta without a preceding tool_use_start
      // is malformed, but tolerate it by treating it as a stale event.
      if (!openBlocks.has(ev.index)) continue;
      yield sse("content_block_delta", {
        type: "content_block_delta",
        index: ev.index,
        delta: { type: "input_json_delta", partial_json: ev.partialJson }
      });
      continue;
    }

    if (ev.kind === "tool_use_stop") {
      if (!openBlocks.has(ev.index)) continue;
      openBlocks.delete(ev.index);
      yield sse("content_block_stop", {
        type: "content_block_stop",
        index: ev.index
      });
      continue;
    }

    if (ev.kind === "message_stop") {
      const chunk = ensureStart(meta.model);
      if (chunk) yield chunk;
      // Close every still-open content block.
      for (const idx of [...openBlocks.keys()].sort((a, b) => a - b)) {
        yield sse("content_block_stop", {
          type: "content_block_stop",
          index: idx
        });
      }
      openBlocks.clear();
      stopReason = mapStopReason(ev.stopReason);
      outputTokens = ev.usage?.outputTokens ?? 0;
      yield sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens }
      });
      yield sse("message_stop", { type: "message_stop" });
      messageStopSent = true;
      return;
    }
  }

  // Source ended without an explicit message_stop. Synthesize one so clients
  // never see a half-open stream.
  if (!messageStopSent) {
    const chunk = ensureStart(meta.model);
    if (chunk) yield chunk;
    for (const idx of [...openBlocks.keys()].sort((a, b) => a - b)) {
      yield sse("content_block_stop", {
        type: "content_block_stop",
        index: idx
      });
    }
    yield sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: null, stop_sequence: null },
      usage: { output_tokens: outputTokens }
    });
    yield sse("message_stop", { type: "message_stop" });
  }
}

type BlockState =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; partialJson: string };

/**
 * Buffer the entire event stream and assemble the non-streaming response body.
 * Each content-block index gets its own block; text deltas with the same
 * index are concatenated in arrival order, tool_use deltas accumulate
 * partial_json strings which are parsed at finalize time.
 */
export async function normalizedEventsToFinalResponse(
  events: AsyncIterable<NormalizedEvent>,
  meta: ResponseMeta
): Promise<AnthropicMessagesResponse> {
  const blocks = new Map<number, BlockState>();
  let stopReason: AnthropicStopReason | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const ev of events) {
    if (ev.kind === "text_delta") {
      const cur = blocks.get(ev.index);
      if (cur === undefined) {
        blocks.set(ev.index, { kind: "text", text: ev.text });
      } else if (cur.kind === "text") {
        cur.text += ev.text;
      }
      // text_delta on a tool_use index is dropped silently — malformed.
    } else if (ev.kind === "tool_use_start") {
      blocks.set(ev.index, {
        kind: "tool_use",
        id: ev.id,
        name: ev.name,
        partialJson: ""
      });
    } else if (ev.kind === "tool_use_delta") {
      const cur = blocks.get(ev.index);
      if (cur?.kind === "tool_use") {
        cur.partialJson += ev.partialJson;
      }
    } else if (ev.kind === "tool_use_stop") {
      // No-op for aggregation; the JSON parse happens at finalize time.
    } else if (ev.kind === "message_stop") {
      stopReason = mapStopReason(ev.stopReason);
      if (ev.usage) {
        inputTokens = ev.usage.inputTokens;
        outputTokens = ev.usage.outputTokens;
      }
    }
    // message_start ignored — meta.model wins
  }

  const content: AnthropicResponseContentBlock[] = [];
  // Iterate in index order to match the on-the-wire arrival order.
  const orderedKeys = Array.from(blocks.keys()).sort((a, b) => a - b);
  for (const idx of orderedKeys) {
    const block = blocks.get(idx);
    if (!block) continue;
    if (block.kind === "text") {
      content.push({ type: "text", text: block.text });
    } else {
      let parsedInput: unknown;
      try {
        parsedInput =
          block.partialJson.length > 0 ? JSON.parse(block.partialJson) : {};
      } catch {
        // Malformed JSON from upstream; surface the raw string so clients
        // can still see what arrived rather than getting a 500.
        parsedInput = block.partialJson;
      }
      content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: parsedInput
      });
    }
  }

  return {
    id: meta.messageId,
    type: "message",
    role: "assistant",
    model: meta.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
  };
}
