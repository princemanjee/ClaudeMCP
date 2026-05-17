import { describe, expect, it } from "vitest";
import type {
  ClaudeRunOptions,
  ClaudeRunResult,
  ClaudeStreamOptions
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
