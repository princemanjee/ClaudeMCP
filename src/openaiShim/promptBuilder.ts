// TypeScript port of dist/openaiShim/promptBuilder.js. The byte-identical
// SYSTEM_PRELUDE and SYSTEM_FORMAT_RULES are preserved so the legacy and
// the new shim emit the same prompt to backends. Spec Non-goal: native
// tool_use in the OpenAI shim. The prompt-engineered <tool_use> envelope
// is the contract.
import { createHash } from "node:crypto";
import type {
  OpenAIChatMessage,
  OpenAIContentPart,
  OpenAIToolDefinition
} from "./types.js";

export const SYSTEM_PRELUDE = `You are a reasoning engine. A separate agent-orchestration system ("the harness") has delegated decision-making to you. You have NO direct access to files, shell, or the internet. The harness executes tools on your behalf.`;

export const SYSTEM_FORMAT_RULES = `RESPONSE FORMAT — STRICT:

Your response must be EITHER:

(A) One or more tool requests, each wrapped exactly like this:
<tool_use>
{"name": "tool_name_here", "arguments": {...}}
</tool_use>

For multiple tools in parallel, emit multiple <tool_use> blocks back-to-back with no text between them. The arguments object must be valid JSON matching the tool's parameter schema.

(B) A final plain-text answer to the user's request. No tags, no JSON wrapper, no code fences.

NEVER mix modes in one response. NEVER add commentary before or after <tool_use> blocks. NEVER use any tool not in the list above.

Examples:

  Good — tool request:
<tool_use>
{"name": "search", "arguments": {"query": "claude code pricing"}}
</tool_use>

  Good — parallel tool requests:
<tool_use>
{"name": "search", "arguments": {"query": "weather Paris"}}
</tool_use>
<tool_use>
{"name": "search", "arguments": {"query": "weather London"}}
</tool_use>

  Good — final answer:
The current Claude Max plan is $200/month.

  Bad — do not do this:
Here's what I found: <tool_use>...</tool_use> Let me know if you need more.`;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
  );
  return (
    "{" +
    entries
      .map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v))
      .join(",") +
    "}"
  );
}

/**
 * Legacy session-resolution helper. Currently unused by src/openaiShim — the
 * new shim is stateless. Ported for back-compat so a future spec can wire up
 * Claude session resumption without re-deriving the algorithm.
 */
export function computeExternalKey(messages: OpenAIChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") {
      const payload = {
        content: m.content ?? null,
        tool_calls: m.tool_calls ?? null
      };
      return createHash("sha256").update(canonicalJson(payload)).digest("hex");
    }
  }
  return null;
}

/**
 * Legacy resume helper. Currently unused; see computeExternalKey.
 */
export function extractNewMessagesAfterLastAssistant(
  messages: OpenAIChatMessage[]
): OpenAIChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      return messages.slice(i + 1);
    }
  }
  return [...messages];
}

function serializeTools(tools: OpenAIToolDefinition[]): string {
  if (tools.length === 0) return "AVAILABLE TOOLS: (none)";
  const lines = ["AVAILABLE TOOLS:"];
  for (const t of tools) {
    lines.push(`  - name: ${t.function.name}`);
    if (t.function.description) {
      lines.push(`    description: ${t.function.description}`);
    }
    lines.push(
      `    parameters (JSON Schema): ${JSON.stringify(t.function.parameters ?? {})}`
    );
  }
  return lines.join("\n");
}

/**
 * Normalize the OpenAI 2024+ content shape (string OR array of {type: "text",
 * text}) into a single string. Empty / null returns "".
 */
function contentToString(
  content: string | OpenAIContentPart[] | null | undefined
): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const part of content) {
      if (part && part.type === "text") out += part.text;
    }
    return out;
  }
  return "";
}

function findCallerSystem(messages: OpenAIChatMessage[]): string | null {
  const first = messages[0];
  if (!first || first.role !== "system") return null;
  return contentToString(first.content);
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function serializeAssistant(m: OpenAIChatMessage): string {
  if (m.tool_calls && m.tool_calls.length > 0) {
    const blocks = m.tool_calls
      .map(
        (c) =>
          `<tool_use>${JSON.stringify({
            name: c.function.name,
            arguments: c.function.arguments
              ? safeJsonParse(c.function.arguments)
              : {}
          })}</tool_use>`
      )
      .join("\n");
    return `<assistant_tool_use>\n${blocks}\n</assistant_tool_use>`;
  }
  return `<assistant>${contentToString(m.content)}</assistant>`;
}

function serializeMessage(m: OpenAIChatMessage): string {
  switch (m.role) {
    case "system":
      return "";
    case "user":
      return `<user>${contentToString(m.content)}</user>`;
    case "assistant":
      return serializeAssistant(m);
    case "tool": {
      const id = m.tool_call_id ?? "";
      return `<tool_result id="${id}">${contentToString(m.content)}</tool_result>`;
    }
    case "function": {
      // Legacy role:function maps to a tool_result; the function `name`
      // takes the id slot when no tool_call_id is supplied.
      const id = m.tool_call_id ?? m.name ?? "";
      return `<tool_result id="${id}">${contentToString(m.content)}</tool_result>`;
    }
    default:
      return "";
  }
}

export interface BuiltPrompts {
  systemPrompt: string;
  userPrompt: string;
}

export function buildFreshPrompts(
  messages: OpenAIChatMessage[],
  tools: OpenAIToolDefinition[]
): BuiltPrompts {
  if (messages.length === 0) {
    throw new Error("buildFreshPrompts requires at least one message");
  }
  const callerSystem = findCallerSystem(messages);
  const systemSections = [SYSTEM_PRELUDE];
  if (callerSystem) {
    systemSections.push(`[Caller's system message]:\n<<<\n${callerSystem}\n>>>`);
  }
  systemSections.push(serializeTools(tools));
  systemSections.push(SYSTEM_FORMAT_RULES);
  const systemPrompt = systemSections.join("\n\n");

  const body = messages
    .filter((m) => m.role !== "system")
    .map(serializeMessage)
    .filter((s) => s.length > 0)
    .join("\n");
  const userPrompt = `${body}\n\nProduce your next response.`;
  return { systemPrompt, userPrompt };
}

/**
 * Legacy resume helper used by dist/openaiShim. Currently unused.
 */
export function buildResumeUserPrompt(newMessages: OpenAIChatMessage[]): string {
  const body = newMessages
    .filter((m) => m.role !== "system")
    .map(serializeMessage)
    .filter((s) => s.length > 0)
    .join("\n");
  const nudge = "Produce your next response.";
  return body.length > 0 ? `${body}\n\n${nudge}` : nudge;
}
