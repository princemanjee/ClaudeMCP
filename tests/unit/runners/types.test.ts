import { describe, expect, it } from "vitest";
import type {
  ClaudeRunOptions,
  ClaudeRunResult,
  ClaudeStreamOptions,
  GeminiRunOptions,
  GeminiRunResult,
  GeminiStreamOptions
} from "../../../src/runners/types.js";

describe("runner types", () => {
  it("constructs a minimal ClaudeRunOptions", () => {
    const opts: ClaudeRunOptions = {
      prompt: "hello",
      timeoutMs: 60000,
      claudeCommand: "claude"
    };
    expect(opts.prompt).toBe("hello");
  });

  it("accepts string-array claudeCommand for shim prefixes (e.g. wsl)", () => {
    const opts: ClaudeRunOptions = {
      prompt: "hello",
      timeoutMs: 60000,
      claudeCommand: ["wsl", "claude"]
    };
    expect(Array.isArray(opts.claudeCommand)).toBe(true);
  });

  it("ClaudeRunResult carries every documented field", () => {
    const result: ClaudeRunResult = {
      text: "ok",
      sessionId: "s1",
      exitCode: 0,
      durationMs: 12,
      timedOut: false,
      stderr: ""
    };
    expect(result.sessionId).toBe("s1");
  });

  it("ClaudeRunResult.sessionId may be null", () => {
    const result: ClaudeRunResult = {
      text: "",
      sessionId: null,
      exitCode: -1,
      durationMs: 0,
      timedOut: false,
      stderr: "spawn error"
    };
    expect(result.sessionId).toBeNull();
  });

  it("ClaudeStreamOptions adds optional systemPrompt", () => {
    const opts: ClaudeStreamOptions = {
      prompt: "hello",
      systemPrompt: "you are helpful",
      timeoutMs: 60000,
      claudeCommand: "claude"
    };
    expect(opts.systemPrompt).toBe("you are helpful");
  });
});

describe("gemini runner types", () => {
  it("constructs a minimal GeminiRunOptions", () => {
    const opts: GeminiRunOptions = {
      prompt: "hello",
      timeoutMs: 60000,
      geminiCommand: "gemini"
    };
    expect(opts.prompt).toBe("hello");
  });

  it("accepts string-array geminiCommand for shim prefixes (e.g. wsl)", () => {
    const opts: GeminiRunOptions = {
      prompt: "hello",
      timeoutMs: 60000,
      geminiCommand: ["wsl", "gemini"]
    };
    expect(Array.isArray(opts.geminiCommand)).toBe(true);
  });

  it("GeminiRunOptions carries optional model and samplingParams", () => {
    const opts: GeminiRunOptions = {
      prompt: "hello",
      timeoutMs: 60000,
      geminiCommand: "gemini",
      model: "gemini-pro",
      temperature: 0.5,
      topP: 0.9,
      topK: 40
    };
    expect(opts.model).toBe("gemini-pro");
    expect(opts.temperature).toBe(0.5);
  });

  it("GeminiRunResult carries every documented field", () => {
    const result: GeminiRunResult = {
      text: "ok",
      sessionId: "s1",
      exitCode: 0,
      durationMs: 12,
      timedOut: false,
      stderr: "",
      usage: { inputTokens: 1, outputTokens: 2 }
    };
    expect(result.sessionId).toBe("s1");
    expect(result.usage?.inputTokens).toBe(1);
  });

  it("GeminiRunResult.sessionId and usage may be null/undefined", () => {
    const result: GeminiRunResult = {
      text: "",
      sessionId: null,
      exitCode: -1,
      durationMs: 0,
      timedOut: false,
      stderr: "spawn error"
    };
    expect(result.sessionId).toBeNull();
    expect(result.usage).toBeUndefined();
  });

  it("GeminiStreamOptions adds optional systemPrompt", () => {
    const opts: GeminiStreamOptions = {
      prompt: "hello",
      systemPrompt: "you are helpful",
      timeoutMs: 60000,
      geminiCommand: "gemini"
    };
    expect(opts.systemPrompt).toBe("you are helpful");
  });
});
