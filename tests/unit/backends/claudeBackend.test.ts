import { describe, expect, it } from "vitest";
import { ClaudeBackend } from "../../../src/backends/claudeBackend.js";

describe("ClaudeBackend skeleton", () => {
  function makeBackend(): ClaudeBackend {
    return new ClaudeBackend({
      command: "claude",
      timeoutMs: 60000
    });
  }

  it("has id 'claude'", () => {
    expect(makeBackend().id).toBe("claude");
  });

  it("listModels returns the curated Claude model catalog", async () => {
    const models = await makeBackend().listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("claude-opus-4-7");
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("claude-haiku-4-5");
  });

  it("each ModelDescriptor exposes context window and capability flags", async () => {
    const models = await makeBackend().listModels();
    for (const m of models) {
      expect(typeof m.contextWindow).toBe("number");
      expect(typeof m.supportsTools).toBe("boolean");
      expect(typeof m.supportsVision).toBe("boolean");
    }
  });

  it("capabilitiesFor(model) returns claude CLI's actual surface", () => {
    const caps = makeBackend().capabilitiesFor("claude-sonnet-4-6");
    expect(caps.toolUse).toBe(true);             // landed in Plan 04
    expect(caps.multimodal).toBe(true);          // model-dependent; conservative true
    expect(caps.thinking).toBe(true);
    expect(caps.cacheControl).toBe("none");      // local-emulation lands via responseCache in Plan 05
    expect(caps.samplingParams).toEqual({
      temperature: false,
      topP: false,
      topK: false
    });
    expect(caps.stopSequences).toBe("server-side-cut");
    expect(caps.embeddings).toBe(false);
  });

  it("capabilitiesFor(haiku) reports the same surface (model-specific narrowing happens later)", () => {
    const caps = makeBackend().capabilitiesFor("claude-haiku-4-5");
    expect(caps.embeddings).toBe(false);
    expect(caps.samplingParams.temperature).toBe(false);
  });

  it("countTokens returns an estimate (char/4 fallback in Plan 02)", async () => {
    const tokens = await makeBackend().countTokens({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello world hello world" }]
        }
      ]
    });
    // char/4 fallback: "hello world hello world" = 23 chars → ceil(23/4) = 6
    expect(tokens).toBe(6);
  });

  it("countTokens sums across multiple text blocks and system", async () => {
    const tokens = await makeBackend().countTokens({
      model: "claude-sonnet-4-6",
      system: "you are helpful", // 15 chars → 4
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] }, // 5 → 2
        { role: "assistant", content: [{ type: "text", text: "ok" }] }, // 2 → 1
        { role: "user", content: [{ type: "text", text: "again" }] } // 5 → 2
      ]
    });
    expect(tokens).toBe(4 + 2 + 1 + 2);
  });

  it("invoke() throws — landed in Task 6", async () => {
    const backend = makeBackend();
    await expect(async () => {
      for await (const _ of backend.invoke({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      })) {
        // no-op
      }
    }).rejects.toThrow(/invoke/);
  });
});
