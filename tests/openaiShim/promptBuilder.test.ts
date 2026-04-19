import { describe, test, expect } from "vitest";
import {
  computeExternalKey,
  buildFreshPrompts,
  buildResumeUserPrompt,
  extractNewMessagesAfterLastAssistant,
} from "../../src/openaiShim/promptBuilder.js";
import type { OpenAIMessage, OpenAIToolDefinition } from "../../src/openaiShim/types.js";

describe("computeExternalKey", () => {
  test("returns null when no assistant message exists", () => {
    const msgs: OpenAIMessage[] = [
      { role: "user", content: "hi" },
    ];
    expect(computeExternalKey(msgs)).toBe(null);
  });

  test("produces a deterministic hash for identical assistant content", () => {
    const a: OpenAIMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const b: OpenAIMessage[] = [
      { role: "user", content: "different" },
      { role: "assistant", content: "hello" },
    ];
    expect(computeExternalKey(a)).toBe(computeExternalKey(b));
    expect(typeof computeExternalKey(a)).toBe("string");
    expect(computeExternalKey(a)!.length).toBeGreaterThan(16);
  });

  test("whitespace change in assistant content changes the hash", () => {
    const a: OpenAIMessage[] = [{ role: "assistant", content: "hello" }];
    const b: OpenAIMessage[] = [{ role: "assistant", content: "hello " }];
    expect(computeExternalKey(a)).not.toBe(computeExternalKey(b));
  });

  test("tool_calls content is included in the hash", () => {
    const a: OpenAIMessage[] = [
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "search", arguments: "{}" } },
        ],
      },
    ];
    const b: OpenAIMessage[] = [
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } },
        ],
      },
    ];
    expect(computeExternalKey(a)).not.toBe(computeExternalKey(b));
  });

  test("tool_calls reordering changes the hash", () => {
    const a: OpenAIMessage[] = [
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
        ],
      },
    ];
    const b: OpenAIMessage[] = [
      {
        role: "assistant",
        tool_calls: [
          { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
          { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
        ],
      },
    ];
    expect(computeExternalKey(a)).not.toBe(computeExternalKey(b));
  });
});

describe("extractNewMessagesAfterLastAssistant", () => {
  test("returns all messages when none are assistant", () => {
    const msgs: OpenAIMessage[] = [{ role: "user", content: "a" }];
    expect(extractNewMessagesAfterLastAssistant(msgs)).toEqual(msgs);
  });

  test("returns messages after the last assistant", () => {
    const msgs: OpenAIMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "tool", tool_call_id: "c1", content: "result" },
      { role: "user", content: "c" },
    ];
    const after = extractNewMessagesAfterLastAssistant(msgs);
    expect(after).toEqual([
      { role: "tool", tool_call_id: "c1", content: "result" },
      { role: "user", content: "c" },
    ]);
  });

  test("uses the LAST assistant, not the first", () => {
    const msgs: OpenAIMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "first" },
      { role: "user", content: "b" },
      { role: "assistant", content: "second" },
      { role: "user", content: "c" },
    ];
    const after = extractNewMessagesAfterLastAssistant(msgs);
    expect(after).toEqual([{ role: "user", content: "c" }]);
  });
});

describe("buildFreshPrompts", () => {
  test("system prompt embeds caller's system message and tool list", () => {
    const msgs: OpenAIMessage[] = [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hi" },
    ];
    const tools: OpenAIToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "search",
          description: "Search the web",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    ];
    const { systemPrompt, userPrompt } = buildFreshPrompts(msgs, tools);
    expect(systemPrompt).toContain("reasoning engine");
    expect(systemPrompt).toContain("Be concise.");
    expect(systemPrompt).toContain("search");
    expect(systemPrompt).toContain("Search the web");
    expect(systemPrompt).toContain("<tool_use>");
    expect(userPrompt).toContain("<user>Hi</user>");
  });

  test("omits caller system block when none is present", () => {
    const msgs: OpenAIMessage[] = [{ role: "user", content: "Hi" }];
    const { systemPrompt } = buildFreshPrompts(msgs, []);
    expect(systemPrompt).not.toContain("<<<");
    expect(systemPrompt).toContain("reasoning engine");
  });

  test("serializes assistant history and tool results", () => {
    const msgs: OpenAIMessage[] = [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "search", arguments: '{"q":"weather"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "sunny" },
    ];
    const { userPrompt } = buildFreshPrompts(msgs, []);
    expect(userPrompt).toContain("<user>weather?</user>");
    expect(userPrompt).toContain("<assistant_tool_use>");
    expect(userPrompt).toContain('"name":"search"');
    expect(userPrompt).toContain('<tool_result id="c1">sunny</tool_result>');
    expect(userPrompt).toMatch(/Produce your next response\./);
  });

  test("throws on empty messages", () => {
    expect(() => buildFreshPrompts([], [])).toThrow(/at least one/);
  });
});

describe("buildResumeUserPrompt", () => {
  test("serializes tool_result and user messages", () => {
    const newMsgs: OpenAIMessage[] = [
      { role: "tool", tool_call_id: "c1", content: "42" },
      { role: "user", content: "continue" },
    ];
    const p = buildResumeUserPrompt(newMsgs);
    expect(p).toContain('<tool_result id="c1">42</tool_result>');
    expect(p).toContain("<user>continue</user>");
    expect(p).toMatch(/Produce your next response\./);
  });

  test("empty new messages still produces a valid continuation nudge", () => {
    const p = buildResumeUserPrompt([]);
    expect(p).toMatch(/Produce your next response\./);
  });
});
