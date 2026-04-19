import { describe, test, expect } from "vitest";
import { parseClaudeResponse } from "../../src/openaiShim/responseParser.js";

describe("parseClaudeResponse", () => {
  test("returns content for plain text", () => {
    const r = parseClaudeResponse("Hello world.");
    expect(r.kind).toBe("content");
    if (r.kind === "content") expect(r.text).toBe("Hello world.");
  });

  test("strips leading whitespace for classification but preserves it in content", () => {
    const r = parseClaudeResponse("   Hello.");
    expect(r.kind).toBe("content");
    if (r.kind === "content") expect(r.text).toBe("Hello.");
  });

  test("parses a single tool_use block", () => {
    const input =
      '<tool_use>{"name":"search","arguments":{"q":"foo"}}</tool_use>';
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("tool_calls");
    if (r.kind === "tool_calls") {
      expect(r.calls.length).toBe(1);
      expect(r.calls[0]?.name).toBe("search");
      expect(r.calls[0]?.argumentsJson).toBe('{"q":"foo"}');
      expect(r.calls[0]?.id).toMatch(/^call_/);
    }
  });

  test("parses parallel tool_use blocks", () => {
    const input = `<tool_use>{"name":"a","arguments":{}}</tool_use>
<tool_use>{"name":"b","arguments":{"x":1}}</tool_use>`;
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("tool_calls");
    if (r.kind === "tool_calls") {
      expect(r.calls.length).toBe(2);
      expect(r.calls[0]?.name).toBe("a");
      expect(r.calls[1]?.name).toBe("b");
    }
  });

  test("defaults arguments to {} when omitted", () => {
    const input = '<tool_use>{"name":"ping"}</tool_use>';
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("tool_calls");
    if (r.kind === "tool_calls") {
      expect(r.calls[0]?.argumentsJson).toBe("{}");
    }
  });

  test("handles nested braces in arguments via brace balancing", () => {
    const input =
      '<tool_use>{"name":"q","arguments":{"nested":{"a":1}}}</tool_use>';
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("tool_calls");
    if (r.kind === "tool_calls") {
      expect(r.calls[0]?.argumentsJson).toBe('{"nested":{"a":1}}');
    }
  });

  test("falls back to content on malformed JSON inside tag", () => {
    const input = '<tool_use>{not json}</tool_use>';
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("content");
  });

  test("falls back to content on unclosed tag", () => {
    const input = '<tool_use>{"name":"x"';
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("content");
  });

  test("falls back to content when tool_use has prose around it", () => {
    const input = 'I will search. <tool_use>{"name":"s","arguments":{}}</tool_use>';
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("content");
  });

  test("falls back to content on code-fenced JSON", () => {
    const input = '```json\n{"name":"s","arguments":{}}\n```';
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("content");
  });

  test("tool call missing 'name' falls back to content", () => {
    const input = '<tool_use>{"arguments":{"x":1}}</tool_use>';
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("content");
  });
});
