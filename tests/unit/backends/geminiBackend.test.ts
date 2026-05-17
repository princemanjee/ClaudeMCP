import { describe, expect, it } from "vitest";
import { GeminiBackend } from "../../../src/backends/geminiBackend.js";

describe("GeminiBackend skeleton", () => {
  function makeBackend(): GeminiBackend {
    return new GeminiBackend({
      command: "gemini",
      timeoutMs: 60000
    });
  }

  it("has id 'gemini'", () => {
    expect(makeBackend().id).toBe("gemini");
  });

  it("listModels returns the curated Gemini model catalog", async () => {
    const models = await makeBackend().listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("gemini-pro");
    expect(ids).toContain("gemini-flash");
    expect(ids).toContain("gemini-flash-lite");
    // Dotted-version variants for callers pinning exact versions.
    expect(ids).toContain("gemini-2.5-pro");
    expect(ids).toContain("gemini-2.5-flash");
    expect(ids).toContain("gemini-2.5-flash-lite");
  });

  it("each ModelDescriptor exposes context window and capability flags", async () => {
    const models = await makeBackend().listModels();
    for (const m of models) {
      expect(typeof m.contextWindow).toBe("number");
      expect(typeof m.supportsTools).toBe("boolean");
      expect(typeof m.supportsVision).toBe("boolean");
    }
  });

  it("capabilitiesFor(model) returns Gemini CLI's actual surface", () => {
    const caps = makeBackend().capabilitiesFor("gemini-pro");
    // Plan 06 baseline: toolUse stays false; Plan 07 wires it on.
    expect(caps.toolUse).toBe(false);
    expect(caps.multimodal).toBe(true);            // model-dependent, conservative true
    expect(caps.thinking).toBe(false);             // Gemini 2.5 thinking-mode lands later
    expect(caps.cacheControl).toBe("none");        // Plan-05 local response cache works regardless
    // Critical contrast vs Claude: Gemini supports all three natively.
    expect(caps.samplingParams).toEqual({
      temperature: true,
      topP: true,
      topK: true
    });
    expect(caps.stopSequences).toBe("native");     // Gemini CLI supports stop sequences natively
    expect(caps.embeddings).toBe(false);           // Gemini text-embedding-004 deferred (open question)
  });

  it("capabilitiesFor(flash-lite) reports the same surface (per-model narrowing happens later)", () => {
    const caps = makeBackend().capabilitiesFor("gemini-flash-lite");
    expect(caps.samplingParams.temperature).toBe(true);
    expect(caps.embeddings).toBe(false);
  });

  it("countTokens returns an estimate (char/4 fallback in Plan 06)", async () => {
    const tokens = await makeBackend().countTokens({
      model: "gemini-flash",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello world hello world" }]
        }
      ]
    });
    // char/4 fallback: 23 chars → ceil(23/4) = 6
    expect(tokens).toBe(6);
  });

  it("countTokens sums across multiple text blocks and system", async () => {
    const tokens = await makeBackend().countTokens({
      model: "gemini-flash",
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
        model: "gemini-flash",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      })) {
        // no-op
      }
    }).rejects.toThrow(/invoke/);
  });
});
