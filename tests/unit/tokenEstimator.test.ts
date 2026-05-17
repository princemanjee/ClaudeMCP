import { describe, expect, it } from "vitest";
import {
  estimateRequestTokens,
  estimateTokens
} from "../../src/tokenEstimator.js";
import type { NormalizedRequest } from "../../src/backends/types.js";

describe("estimateTokens (char/4)", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns ceil(length/4) for ASCII text", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("hello world")).toBe(3); // 11 chars → 3
  });

  it("counts each code unit (not grapheme cluster)", () => {
    // Multi-byte char: char length is the unit of measure here.
    expect(estimateTokens("é")).toBe(1); // 1 code unit
    expect(estimateTokens("éééé")).toBe(1);
  });
});

describe("estimateRequestTokens", () => {
  it("sums text from a single user message", () => {
    const req: NormalizedRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello world hello world" }] }
      ]
    };
    // 23 chars → ceil(23/4) = 6
    expect(estimateRequestTokens(req)).toBe(6);
  });

  it("includes the system prompt", () => {
    const req: NormalizedRequest = {
      model: "claude-sonnet-4-6",
      system: "you are helpful", // 15 → 4
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] // 2 → 1
    };
    expect(estimateRequestTokens(req)).toBe(5);
  });

  it("walks every message and every text block", () => {
    const req: NormalizedRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] }, // 5 → 2
        { role: "assistant", content: [{ type: "text", text: "ok" }] }, // 2 → 1
        {
          role: "user",
          content: [
            { type: "text", text: "second" }, // 6 → 2
            { type: "text", text: "third" } // 5 → 2
          ]
        }
      ]
    };
    expect(estimateRequestTokens(req)).toBe(7);
  });

  it("approximates image blocks with a fixed placeholder cost", () => {
    const req: NormalizedRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" }, // 8 → 2
            { type: "image", mediaType: "image/png", data: "BASE64" } // placeholder cost: 258
          ]
        }
      ]
    };
    expect(estimateRequestTokens(req)).toBe(2 + 258);
  });

  it("approximates document blocks with a per-byte cost", () => {
    const req: NormalizedRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            // 64 bytes of base64 → ~48 raw bytes → ceil(48/4) = 12
            { type: "document", mediaType: "application/pdf", data: "A".repeat(64) }
          ]
        }
      ]
    };
    expect(estimateRequestTokens(req)).toBe(12);
  });

  it("includes serialized tool_use input and tool_result content", () => {
    const req: NormalizedRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "calc", input: { x: 1, y: 2 } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "t1", content: "3" }
          ]
        }
      ]
    };
    // JSON.stringify({x:1,y:2}) = 13 chars → 4
    // "3" → 1
    expect(estimateRequestTokens(req)).toBe(4 + 1);
  });

  it("returns 0 for an empty messages array with no system prompt", () => {
    const req: NormalizedRequest = {
      model: "claude-sonnet-4-6",
      messages: []
    };
    expect(estimateRequestTokens(req)).toBe(0);
  });
});
