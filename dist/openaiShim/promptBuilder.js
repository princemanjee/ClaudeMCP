import { createHash } from "node:crypto";
const SYSTEM_PRELUDE = `You are a reasoning engine. A separate agent-orchestration system ("the harness") has delegated decision-making to you. You have NO direct access to files, shell, or the internet. The harness executes tools on your behalf.`;
const SYSTEM_FORMAT_RULES = `RESPONSE FORMAT — STRICT:

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
function canonicalJson(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value)) {
        return "[" + value.map(canonicalJson).join(",") + "]";
    }
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return ("{" +
        entries
            .map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v))
            .join(",") +
        "}");
}
export function computeExternalKey(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role === "assistant") {
            const payload = {
                content: m.content ?? null,
                tool_calls: m.tool_calls ?? null,
            };
            return createHash("sha256").update(canonicalJson(payload)).digest("hex");
        }
    }
    return null;
}
export function extractNewMessagesAfterLastAssistant(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "assistant") {
            return messages.slice(i + 1);
        }
    }
    return [...messages];
}
function serializeTools(tools) {
    if (tools.length === 0)
        return "AVAILABLE TOOLS: (none)";
    const lines = ["AVAILABLE TOOLS:"];
    for (const t of tools) {
        lines.push(`  - name: ${t.function.name}`);
        if (t.function.description) {
            lines.push(`    description: ${t.function.description}`);
        }
        lines.push(`    parameters (JSON Schema): ${JSON.stringify(t.function.parameters ?? {})}`);
    }
    return lines.join("\n");
}
function findCallerSystem(messages) {
    const first = messages[0];
    return first?.role === "system" ? first.content : null;
}
function safeJsonParse(s) {
    try {
        return JSON.parse(s);
    }
    catch {
        return s;
    }
}
function serializeAssistant(m) {
    if (m.tool_calls && m.tool_calls.length > 0) {
        const blocks = m.tool_calls
            .map((c) => `<tool_use>${JSON.stringify({
            name: c.function.name,
            arguments: c.function.arguments
                ? safeJsonParse(c.function.arguments)
                : {},
        })}</tool_use>`)
            .join("\n");
        return `<assistant_tool_use>\n${blocks}\n</assistant_tool_use>`;
    }
    return `<assistant>${m.content ?? ""}</assistant>`;
}
function serializeMessage(m) {
    switch (m.role) {
        case "system":
            return "";
        case "user":
            return `<user>${m.content}</user>`;
        case "assistant":
            return serializeAssistant(m);
        case "tool":
            return `<tool_result id="${m.tool_call_id}">${m.content}</tool_result>`;
    }
}
export function buildFreshPrompts(messages, tools) {
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
export function buildResumeUserPrompt(newMessages) {
    const body = newMessages
        .filter((m) => m.role !== "system")
        .map(serializeMessage)
        .filter((s) => s.length > 0)
        .join("\n");
    const nudge = "Produce your next response.";
    return body.length > 0 ? `${body}\n\n${nudge}` : nudge;
}
//# sourceMappingURL=promptBuilder.js.map