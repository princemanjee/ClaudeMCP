import type { NormalizedEvent } from "../backends/types.js";
import type {
  GeminiCandidate,
  GeminiFinishReason,
  GeminiGenerateContentResponse,
  GeminiPart
} from "./types.js";

export interface GeminiResponseMeta {
  /** Model id as the client requested it (used for `modelVersion` field). */
  model: string;
}

function mapFinishReason(
  reason: Extract<NormalizedEvent, { kind: "message_stop" }>["stopReason"]
): GeminiFinishReason {
  switch (reason) {
    case "end_turn":
      return "STOP";
    case "stop_sequence":
      return "STOP"; // Gemini doesn't distinguish — SDK infers from output text
    case "max_tokens":
      return "MAX_TOKENS";
    case "tool_use":
      return "STOP"; // Gemini treats tool calls as a normal stop with functionCall parts
    case "error":
      return "OTHER";
  }
}

function sseChunk(response: GeminiGenerateContentResponse): string {
  return `data: ${JSON.stringify(response)}\n\n`;
}

interface PendingTool {
  id: string;
  name: string;
  partials: string[];
}

interface StreamingState {
  textBuffers: Map<number, string>;
  toolBuffers: Map<number, PendingTool>;
  /** Index order as content blocks first appear, so the final candidate's parts
   *  array preserves chronological ordering for the SDK. */
  appearance: number[];
}

function buildPartsFromState(state: StreamingState): GeminiPart[] {
  const out: GeminiPart[] = [];
  for (const idx of state.appearance) {
    const text = state.textBuffers.get(idx);
    if (text !== undefined) {
      out.push({ text });
      continue;
    }
    const tool = state.toolBuffers.get(idx);
    if (tool) {
      const joined = tool.partials.join("");
      let args: Record<string, unknown>;
      try {
        args = joined.length > 0 ? (JSON.parse(joined) as Record<string, unknown>) : {};
      } catch {
        // Malformed JSON from upstream — surface as empty args rather than
        // failing the whole response. A future plan could 500 the connection.
        args = {};
      }
      out.push({ functionCall: { name: tool.name, args } });
    }
  }
  return out;
}

/**
 * Emit Gemini-shaped SSE chunks. Each chunk is a `data: <JSON>\n\n` line where
 * the JSON is a complete GenerateContentResponse. Non-final chunks carry the
 * incremental text accumulated so far. The final chunk additionally carries
 * finishReason and usageMetadata.
 */
export async function* normalizedEventsToGeminiSSE(
  events: AsyncIterable<NormalizedEvent>,
  meta: GeminiResponseMeta
): AsyncIterable<string> {
  const state: StreamingState = {
    textBuffers: new Map(),
    toolBuffers: new Map(),
    appearance: []
  };
  let messageStopSent = false;
  let modelVersion = meta.model;
  let outputTokens = 0;
  let inputTokens = 0;

  function trackAppearance(idx: number): void {
    if (!state.appearance.includes(idx)) state.appearance.push(idx);
  }

  function emitIncremental(): string {
    return sseChunk({
      candidates: [
        {
          content: { role: "model", parts: buildPartsFromState(state) },
          safetyRatings: [],
          index: 0
        } satisfies GeminiCandidate
      ],
      modelVersion
    });
  }

  for await (const ev of events) {
    if (ev.kind === "message_start") {
      if (ev.model) modelVersion = ev.model;
      continue;
    }

    if (ev.kind === "text_delta") {
      const prev = state.textBuffers.get(ev.index) ?? "";
      state.textBuffers.set(ev.index, prev + ev.text);
      trackAppearance(ev.index);
      yield emitIncremental();
      continue;
    }

    if (ev.kind === "tool_use_start") {
      state.toolBuffers.set(ev.index, { id: ev.id, name: ev.name, partials: [] });
      trackAppearance(ev.index);
      // No chunk emitted yet — wait for first delta so the chunk carries
      // meaningful content. (Empty functionCall.args is still valid; Plan 07
      // emits it on tool_use_stop.)
      continue;
    }

    if (ev.kind === "tool_use_delta") {
      const tool = state.toolBuffers.get(ev.index);
      if (!tool) continue;
      tool.partials.push(ev.partialJson);
      // Don't emit on every delta — Gemini SSE clients expect full functionCall
      // objects, not delta-style emission. We emit once at tool_use_stop.
      continue;
    }

    if (ev.kind === "tool_use_stop") {
      yield emitIncremental();
      continue;
    }

    if (ev.kind === "thinking_delta") {
      // Gemini wire format has no thinking part. Drop silently — Plan 07
      // doesn't surface thinking through the Gemini shim; future plans can
      // map this to a custom field if needed.
      continue;
    }

    if (ev.kind === "message_stop") {
      const finishReason = mapFinishReason(ev.stopReason);
      if (ev.usage) {
        inputTokens = ev.usage.inputTokens;
        outputTokens = ev.usage.outputTokens;
      }
      yield sseChunk({
        candidates: [
          {
            content: { role: "model", parts: buildPartsFromState(state) },
            finishReason,
            safetyRatings: [],
            index: 0
          } satisfies GeminiCandidate
        ],
        modelVersion,
        usageMetadata: {
          promptTokenCount: inputTokens,
          candidatesTokenCount: outputTokens,
          totalTokenCount: inputTokens + outputTokens
        }
      });
      messageStopSent = true;
      return;
    }
  }

  if (!messageStopSent) {
    yield sseChunk({
      candidates: [
        {
          content: { role: "model", parts: buildPartsFromState(state) },
          finishReason: "OTHER",
          safetyRatings: [],
          index: 0
        } satisfies GeminiCandidate
      ],
      modelVersion,
      usageMetadata: {
        promptTokenCount: inputTokens,
        candidatesTokenCount: outputTokens,
        totalTokenCount: inputTokens + outputTokens
      }
    });
  }
}

/**
 * Buffer the entire event stream into a single GenerateContentResponse for the
 * non-streaming `:generateContent` route.
 */
export async function normalizedEventsToGeminiFinalResponse(
  events: AsyncIterable<NormalizedEvent>,
  meta: GeminiResponseMeta
): Promise<GeminiGenerateContentResponse> {
  const state: StreamingState = {
    textBuffers: new Map(),
    toolBuffers: new Map(),
    appearance: []
  };
  let modelVersion = meta.model;
  let finishReason: GeminiFinishReason = "OTHER";
  let inputTokens = 0;
  let outputTokens = 0;

  function track(idx: number): void {
    if (!state.appearance.includes(idx)) state.appearance.push(idx);
  }

  for await (const ev of events) {
    if (ev.kind === "message_start") {
      if (ev.model) modelVersion = ev.model;
    } else if (ev.kind === "text_delta") {
      const prev = state.textBuffers.get(ev.index) ?? "";
      state.textBuffers.set(ev.index, prev + ev.text);
      track(ev.index);
    } else if (ev.kind === "tool_use_start") {
      state.toolBuffers.set(ev.index, { id: ev.id, name: ev.name, partials: [] });
      track(ev.index);
    } else if (ev.kind === "tool_use_delta") {
      const tool = state.toolBuffers.get(ev.index);
      if (tool) tool.partials.push(ev.partialJson);
    } else if (ev.kind === "message_stop") {
      finishReason = mapFinishReason(ev.stopReason);
      if (ev.usage) {
        inputTokens = ev.usage.inputTokens;
        outputTokens = ev.usage.outputTokens;
      }
    }
    // tool_use_stop is a no-op in buffered mode (parts assembled at the end).
    // thinking_delta dropped per the SSE generator's same rationale.
  }

  return {
    candidates: [
      {
        content: { role: "model", parts: buildPartsFromState(state) },
        finishReason,
        safetyRatings: [],
        index: 0
      }
    ],
    modelVersion,
    usageMetadata: {
      promptTokenCount: inputTokens,
      candidatesTokenCount: outputTokens,
      totalTokenCount: inputTokens + outputTokens
    }
  };
}
