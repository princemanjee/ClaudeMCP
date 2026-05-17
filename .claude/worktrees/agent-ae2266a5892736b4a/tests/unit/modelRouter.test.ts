import { describe, expect, it } from "vitest";
import { identifyBackend } from "../../src/modelRouter.js";

describe("identifyBackend", () => {
  it("routes claude- prefix to claude", () => {
    expect(identifyBackend("claude-opus-4-7", "claude")).toEqual({
      backend: "claude",
      remainingModel: "claude-opus-4-7",
      reason: "anthropic-id-prefix"
    });
  });

  it("routes short claude aliases to claude", () => {
    for (const alias of ["opus", "sonnet", "haiku"]) {
      expect(identifyBackend(alias, "gemini").backend).toBe("claude");
    }
  });

  it("routes gemini- prefix to gemini", () => {
    expect(identifyBackend("gemini-pro", "claude")).toEqual({
      backend: "gemini",
      remainingModel: "gemini-pro",
      reason: "google-id-prefix"
    });
  });

  it("routes short gemini aliases to gemini", () => {
    for (const alias of ["pro", "flash", "flash-lite"]) {
      expect(identifyBackend(alias, "claude").backend).toBe("gemini");
    }
  });

  it("honors explicit prefix override for lmstudio", () => {
    expect(identifyBackend("lmstudio/qwen3-coder-30b", "claude")).toEqual({
      backend: "lmstudio",
      remainingModel: "qwen3-coder-30b",
      reason: "prefix-override"
    });
  });

  it("honors explicit prefix override for ollama", () => {
    expect(identifyBackend("ollama/llama-3.3-70b", "claude")).toEqual({
      backend: "ollama",
      remainingModel: "llama-3.3-70b",
      reason: "prefix-override"
    });
  });

  it("honors explicit prefix override for claude even when alias would route gemini", () => {
    expect(identifyBackend("claude/pro", "gemini")).toEqual({
      backend: "claude",
      remainingModel: "pro",
      reason: "prefix-override"
    });
  });

  it("honors fully-qualified multi-instance prefix (lmstudio:work/model)", () => {
    expect(identifyBackend("lmstudio:work-server/qwen3-coder-30b", "claude")).toEqual({
      backend: "lmstudio",
      remainingModel: "qwen3-coder-30b",
      instance: "work-server",
      reason: "prefix-override"
    });
  });

  it("falls back to defaultBackend on 'auto' / empty / sentinel", () => {
    expect(identifyBackend("auto", "gemini").backend).toBe("gemini");
    expect(identifyBackend("", "claude").backend).toBe("claude");
    expect(identifyBackend(undefined, "lmstudio").backend).toBe("lmstudio");
  });

  it("'claude-code-cli' forces claude with cli-sentinel reason regardless of defaultBackend", () => {
    expect(identifyBackend("claude-code-cli", "gemini")).toEqual({
      backend: "claude",
      remainingModel: "claude-code-cli",
      reason: "cli-sentinel"
    });
  });

  it("'gemini-cli' forces gemini with cli-sentinel reason regardless of defaultBackend", () => {
    expect(identifyBackend("gemini-cli", "claude")).toEqual({
      backend: "gemini",
      remainingModel: "gemini-cli",
      reason: "cli-sentinel"
    });
  });

  it("returns unresolved-local for unknown bare names (registry will look up)", () => {
    expect(identifyBackend("qwen3-coder-30b", "claude")).toEqual({
      backend: null,
      remainingModel: "qwen3-coder-30b",
      reason: "needs-registry-lookup"
    });
  });
});
