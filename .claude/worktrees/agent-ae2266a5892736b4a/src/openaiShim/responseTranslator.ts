import type { NormalizedEvent } from "../backends/types.js";
import { parseClaudeResponse, TAG_OPEN } from "./responseParser.js";
import type {
  OpenAIChatChunkDelta,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionResponse,
  OpenAIChunkMeta,
  OpenAIFinishReason,
  OpenAIUsage
} from "./types.js";

const MIN_CLASSIFY_LEN = 10;

type Mode = "UNKNOWN" | "TOOL" | "ANSWER";

function nonWhitespaceLength(s: string): number {
  return s.replace(/\s+/g, "").length;
}

function makeChunk(
  meta: OpenAIChunkMeta,
  delta: OpenAIChatChunkDelta,
  finish: OpenAIFinishReason = null,
  usage?: OpenAIUsage
): OpenAIChatCompletionChunk {
  const chunk: OpenAIChatCompletionChunk = {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finish }]
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

function sseLine(chunk: OpenAIChatCompletionChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function mapFinishReason(stopReason: string | undefined): OpenAIFinishReason {
  if (stopReason === "max_tokens") return "length";
  return "stop";
}

function buildUsage(
  raw: { inputTokens: number; outputTokens: number } | undefined
): OpenAIUsage | undefined {
  if (!raw) return undefined;
  return {
    prompt_tokens: raw.inputTokens,
    completion_tokens: raw.outputTokens,
    total_tokens: raw.inputTokens + raw.outputTokens
  };
}

/**
 * Translate a NormalizedEvent stream from any backend into OpenAI SSE chunks.
 * Yields complete "data: <JSON>\n\n" lines. The handler is responsible for
 * writing the terminating "data: [DONE]\n\n" frame and closing the response.
 *
 * The classifier matches dist/openaiShim/streamTranslator.js byte-for-byte:
 * UNKNOWN → TOOL | ANSWER on first non-whitespace text long enough to decide.
 */
export async function* normalizedEventsToOpenAISSE(
  events: AsyncIterable<NormalizedEvent>,
  meta: OpenAIChunkMeta
): AsyncIterable<string> {
  // Opening chunk: role-only delta.
  yield sseLine(makeChunk(meta, { role: "assistant" }));

  let buffer = "";
  let mode: Mode = "UNKNOWN";
  let toolCallIndex = 0;
  let emittedToolCalls = false;
  let stopReason: string | undefined;
  let usage: { inputTokens: number; outputTokens: number } | undefined;

  for await (const ev of events) {
    if (ev.kind === "message_stop") {
      stopReason = ev.stopReason;
      usage = ev.usage;
      break;
    }
    if (ev.kind !== "text_delta") continue;
    const text = ev.text;
    if (text.length === 0) continue;

    if (mode === "UNKNOWN") {
      buffer += text;
      const stripped = buffer.replace(/^\s+/, "");
      if (stripped.startsWith(TAG_OPEN)) {
        mode = "TOOL";
        buffer = stripped;
        const parsed = parseClaudeResponse(buffer);
        if (parsed.kind === "tool_calls" && parsed.calls.length >= 1) {
          for (const c of parsed.calls) {
            yield sseLine(
              makeChunk(meta, {
                tool_calls: [
                  {
                    index: toolCallIndex++,
                    id: c.id,
                    type: "function",
                    function: { name: c.name, arguments: c.argumentsJson }
                  }
                ]
              })
            );
            emittedToolCalls = true;
          }
          buffer = "";
        }
        continue;
      } else if (nonWhitespaceLength(stripped) >= MIN_CLASSIFY_LEN) {
        mode = "ANSWER";
        yield sseLine(makeChunk(meta, { content: stripped }));
        buffer = "";
        continue;
      } else {
        continue;
      }
    }

    if (mode === "ANSWER") {
      yield sseLine(makeChunk(meta, { content: text }));
      continue;
    }

    // mode === "TOOL"
    buffer += text;
    const parsed = parseClaudeResponse(buffer);
    if (parsed.kind === "tool_calls" && parsed.calls.length >= 1) {
      for (const c of parsed.calls) {
        yield sseLine(
          makeChunk(meta, {
            tool_calls: [
              {
                index: toolCallIndex++,
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.argumentsJson }
              }
            ]
          })
        );
        emittedToolCalls = true;
      }
      buffer = "";
    }
  }

  // Finalize.
  const usageOpenAI = buildUsage(usage);

  if (mode === "UNKNOWN") {
    const stripped = buffer.replace(/^\s+/, "");
    if (stripped.length > 0) {
      yield sseLine(makeChunk(meta, { content: stripped }));
    }
    yield sseLine(makeChunk(meta, {}, "stop", usageOpenAI));
    return;
  }

  if (mode === "ANSWER") {
    yield sseLine(
      makeChunk(meta, {}, mapFinishReason(stopReason), usageOpenAI)
    );
    return;
  }

  // mode === "TOOL"
  if (!emittedToolCalls) {
    if (buffer.length > 0) {
      yield sseLine(makeChunk(meta, { content: buffer }));
    }
    yield sseLine(makeChunk(meta, {}, "stop", usageOpenAI));
    return;
  }
  yield sseLine(makeChunk(meta, {}, "tool_calls", usageOpenAI));
}

export interface BufferedOutcome {
  body: OpenAIChatCompletionResponse;
  toolCallsEmitted: number;
}

/**
 * Buffer the entire event stream and produce a single OpenAI
 * chat.completion body. Mirrors the streaming classifier semantics — the
 * parsed result is the same as concatenating all text and running it
 * through parseClaudeResponse.
 */
export async function normalizedEventsToOpenAIFinalResponse(
  events: AsyncIterable<NormalizedEvent>,
  meta: OpenAIChunkMeta
): Promise<BufferedOutcome> {
  let allText = "";
  let stopReason: string | undefined;
  let usage: { inputTokens: number; outputTokens: number } | undefined;

  for await (const ev of events) {
    if (ev.kind === "text_delta") {
      allText += ev.text;
    } else if (ev.kind === "message_stop") {
      stopReason = ev.stopReason;
      usage = ev.usage;
    }
  }

  const parsed = parseClaudeResponse(allText);
  const usageOpenAI = buildUsage(usage);

  const body: OpenAIChatCompletionResponse =
    parsed.kind === "tool_calls"
      ? {
          id: meta.id,
          object: "chat.completion",
          created: meta.created,
          model: meta.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: parsed.calls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.argumentsJson }
                }))
              },
              finish_reason: "tool_calls"
            }
          ],
          ...(usageOpenAI ? { usage: usageOpenAI } : {})
        }
      : {
          id: meta.id,
          object: "chat.completion",
          created: meta.created,
          model: meta.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: parsed.text },
              finish_reason: mapFinishReason(stopReason)
            }
          ],
          ...(usageOpenAI ? { usage: usageOpenAI } : {})
        };

  return {
    body,
    toolCallsEmitted: parsed.kind === "tool_calls" ? parsed.calls.length : 0
  };
}
