// TypeScript port of dist/openaiShim/responseParser.js. Walks a raw assistant
// text response and either returns it as plain content, or extracts the
// embedded <tool_use>...</tool_use> blocks as a list of tool_calls.
import { randomUUID } from "node:crypto";

export const TAG_OPEN = "<tool_use>";
export const TAG_CLOSE = "</tool_use>";

export interface ParsedToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export type ParsedResponse =
  | { kind: "content"; text: string }
  | { kind: "tool_calls"; calls: ParsedToolCall[] };

/**
 * Find the end index of the JSON object starting at `startIdx` via brace-
 * balancing. Returns -1 if no balanced close is found. Handles escaped
 * quotes inside string literals correctly.
 */
function findJsonEnd(s: string, startIdx: number): number {
  let depth = 0;
  let i = startIdx;
  let inString = false;
  let escape = false;
  while (i < s.length) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    i++;
  }
  return -1;
}

interface BlockParse {
  call: ParsedToolCall;
  nextIdx: number;
}

function parseToolUseBlock(text: string, openIdx: number): BlockParse | null {
  const jsonStart = openIdx + TAG_OPEN.length;
  let i = jsonStart;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  if (text[i] !== "{") return null;
  const jsonEnd = findJsonEnd(text, i);
  if (jsonEnd === -1) return null;
  const jsonSlice = text.slice(i, jsonEnd);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj["name"] !== "string" || obj["name"].length === 0) return null;
  const args =
    obj["arguments"] === undefined
      ? {}
      : typeof obj["arguments"] === "object" && obj["arguments"] !== null
        ? obj["arguments"]
        : null;
  if (args === null) return null;
  const closeIdx = text.indexOf(TAG_CLOSE, jsonEnd);
  if (closeIdx === -1) return null;
  return {
    call: {
      id: `call_${randomUUID()}`,
      name: obj["name"],
      argumentsJson: JSON.stringify(args)
    },
    nextIdx: closeIdx + TAG_CLOSE.length
  };
}

export function parseClaudeResponse(raw: string): ParsedResponse {
  const stripped = raw.replace(/^\s+/, "");
  if (!stripped.startsWith(TAG_OPEN)) {
    return { kind: "content", text: stripped };
  }
  const calls: ParsedToolCall[] = [];
  let cursor = 0;
  while (cursor < stripped.length) {
    while (cursor < stripped.length && /\s/.test(stripped[cursor] ?? "")) {
      cursor++;
    }
    if (cursor >= stripped.length) break;
    if (!stripped.startsWith(TAG_OPEN, cursor)) {
      // Trailing content after tool_use blocks is a format violation.
      // Conservative: fall back to content mode for the whole response.
      return { kind: "content", text: stripped };
    }
    const parsed = parseToolUseBlock(stripped, cursor);
    if (!parsed) {
      return { kind: "content", text: stripped };
    }
    calls.push(parsed.call);
    cursor = parsed.nextIdx;
  }
  if (calls.length === 0) {
    return { kind: "content", text: stripped };
  }
  return { kind: "tool_calls", calls };
}
