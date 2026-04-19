import { parseClaudeResponse } from "./responseParser.js";
import type {
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionResponse,
  StreamJsonEvent,
} from "./types.js";

const TAG_OPEN = "<tool_use>";
const MIN_CLASSIFY_LEN = 10; // length of <tool_use>; after this we can decide

type Meta = { id: string; model: string; created: number };

function chunk(
  meta: Meta,
  delta: OpenAIChatCompletionChunk["choices"][number]["delta"],
  finish: OpenAIChatCompletionChunk["choices"][number]["finish_reason"] = null,
): OpenAIChatCompletionChunk {
  return {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function extractText(e: StreamJsonEvent): string | null {
  if (e.type !== "assistant") return null;
  const msg = (e as { message?: { content?: unknown } }).message;
  if (!msg || !Array.isArray(msg.content)) return null;
  let text = "";
  for (const item of msg.content) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: string }).type === "text" &&
      typeof (item as { text?: string }).text === "string"
    ) {
      text += (item as { text: string }).text;
    }
  }
  return text;
}

function extractSessionId(e: StreamJsonEvent): string | null {
  if (e.type === "system" && (e as { subtype?: string }).subtype === "init") {
    const sid = (e as { session_id?: string }).session_id;
    return typeof sid === "string" ? sid : null;
  }
  if (e.type === "result") {
    const sid = (e as { session_id?: string }).session_id;
    return typeof sid === "string" ? sid : null;
  }
  return null;
}

export type TranslateStreamContext = Meta;

export async function* translateStream(
  events: AsyncIterable<StreamJsonEvent>,
  meta: Meta,
): AsyncGenerator<OpenAIChatCompletionChunk> {
  yield chunk(meta, { role: "assistant" });

  let buffer = "";
  type Mode = "UNKNOWN" | "ANSWER" | "TOOL";
  let mode: Mode = "UNKNOWN";
  let toolCallIndex = 0;
  let emittedToolCalls = false;

  function nonWhitespaceLength(s: string): number {
    return s.replace(/\s+/g, "").length;
  }

  for await (const ev of events) {
    if (ev.type === "result") break;
    const text = extractText(ev);
    if (text === null || text.length === 0) continue;

    if (mode === "UNKNOWN") {
      buffer += text;
      const stripped = buffer.replace(/^\s+/, "");
      if (stripped.startsWith(TAG_OPEN)) {
        mode = "TOOL";
        buffer = stripped;
        // Attempt to parse the buffer immediately (don't append text again below)
        const parsed = parseClaudeResponse(buffer);
        if (parsed.kind === "tool_calls" && parsed.calls.length >= 1) {
          for (const c of parsed.calls) {
            yield chunk(meta, {
              tool_calls: [
                {
                  index: toolCallIndex++,
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.argumentsJson },
                },
              ],
            });
            emittedToolCalls = true;
          }
          buffer = "";
        }
        continue;
      } else if (nonWhitespaceLength(stripped) >= MIN_CLASSIFY_LEN) {
        mode = "ANSWER";
        yield chunk(meta, { content: stripped });
        buffer = "";
        continue;
      } else {
        continue;
      }
    }

    if (mode === "ANSWER") {
      yield chunk(meta, { content: text });
      continue;
    }

    // mode === "TOOL" (already classified in a prior iteration)
    buffer += text;
    const parsed = parseClaudeResponse(buffer);
    if (parsed.kind === "tool_calls" && parsed.calls.length >= 1) {
      for (const c of parsed.calls) {
        yield chunk(meta, {
          tool_calls: [
            {
              index: toolCallIndex++,
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: c.argumentsJson },
            },
          ],
        });
        emittedToolCalls = true;
      }
      buffer = "";
    }
    // Otherwise wait for more text
  }

  // Stream ended. Finalize.
  if (mode === "UNKNOWN") {
    const stripped = buffer.replace(/^\s+/, "");
    if (stripped.length > 0) {
      yield chunk(meta, { content: stripped });
    }
    yield chunk(meta, {}, "stop");
    return;
  }
  if (mode === "ANSWER") {
    yield chunk(meta, {}, "stop");
    return;
  }
  // mode === "TOOL"
  if (!emittedToolCalls) {
    yield chunk(meta, { content: buffer });
    yield chunk(meta, {}, "stop");
    return;
  }
  yield chunk(meta, {}, "tool_calls");
}

export type BufferedResult = {
  body: OpenAIChatCompletionResponse;
  sessionId: string | null;
  toolCallsEmitted: number;
  fullText: string;
};

export async function translateBuffered(
  events: AsyncIterable<StreamJsonEvent>,
  meta: Meta,
): Promise<BufferedResult> {
  let allText = "";
  let sessionId: string | null = null;
  for await (const ev of events) {
    const sid = extractSessionId(ev);
    if (sid && !sessionId) sessionId = sid;
    const text = extractText(ev);
    if (text) allText += text;
  }
  const parsed = parseClaudeResponse(allText);
  const body: OpenAIChatCompletionResponse = {
    id: meta.id,
    object: "chat.completion",
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        message:
          parsed.kind === "tool_calls"
            ? {
                role: "assistant",
                content: null,
                tool_calls: parsed.calls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.argumentsJson },
                })),
              }
            : { role: "assistant", content: parsed.text },
        finish_reason: parsed.kind === "tool_calls" ? "tool_calls" : "stop",
      },
    ],
  };
  return {
    body,
    sessionId,
    toolCallsEmitted: parsed.kind === "tool_calls" ? parsed.calls.length : 0,
    fullText: allText,
  };
}
