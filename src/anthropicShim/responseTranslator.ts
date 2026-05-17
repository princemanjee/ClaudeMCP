import type { NormalizedEvent } from "../backends/types.js";
import type {
  AnthropicMessagesResponse,
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
  // start/stop pairs as deltas come and go.
  const openBlocks = new Set<number>();
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
        openBlocks.add(ev.index);
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

    if (ev.kind === "message_stop") {
      const chunk = ensureStart(meta.model);
      if (chunk) yield chunk;
      // Close every still-open content block.
      for (const idx of [...openBlocks].sort((a, b) => a - b)) {
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

    // tool_use_* events are Plan-04 territory. If they arrive here, ignore
    // them rather than crashing — the request translator already rejected
    // requests that would have caused them.
  }

  // Source ended without an explicit message_stop. Synthesize one so clients
  // never see a half-open stream.
  if (!messageStopSent) {
    const chunk = ensureStart(meta.model);
    if (chunk) yield chunk;
    for (const idx of [...openBlocks].sort((a, b) => a - b)) {
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

/**
 * Buffer the entire event stream and assemble the non-streaming response body.
 * Each content-block index gets its own AnthropicResponseTextBlock; deltas with
 * the same index are concatenated in arrival order.
 */
export async function normalizedEventsToFinalResponse(
  events: AsyncIterable<NormalizedEvent>,
  meta: ResponseMeta
): Promise<AnthropicMessagesResponse> {
  // Index → accumulated text. Map preserves insertion order, which is the
  // order content blocks first appeared.
  const blocks = new Map<number, string>();
  let stopReason: AnthropicStopReason | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const ev of events) {
    if (ev.kind === "text_delta") {
      blocks.set(ev.index, (blocks.get(ev.index) ?? "") + ev.text);
    } else if (ev.kind === "message_stop") {
      stopReason = mapStopReason(ev.stopReason);
      if (ev.usage) {
        inputTokens = ev.usage.inputTokens;
        outputTokens = ev.usage.outputTokens;
      }
    }
    // message_start ignored — meta.model wins
    // tool_use_* ignored in Plan 03 — request translator rejects upstream
  }

  return {
    id: meta.messageId,
    type: "message",
    role: "assistant",
    model: meta.model,
    content: Array.from(blocks.values()).map((text) => ({ type: "text", text })),
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
  };
}
