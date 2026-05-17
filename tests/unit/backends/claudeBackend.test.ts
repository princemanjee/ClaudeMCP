import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { ClaudeBackend } from "../../../src/backends/claudeBackend.js";
import type { NormalizedEvent } from "../../../src/backends/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  it("invoke streams: emits message_start, text_delta(s), message_stop in order", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    })) {
      events.push(ev);
    }

    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
    const deltas = events.filter((e) => e.kind === "text_delta");
    expect(deltas.length).toBeGreaterThan(0);
    // Concatenating all text_delta texts reproduces the assistant response.
    const joined = deltas.map((e) => (e.kind === "text_delta" ? e.text : "")).join("");
    expect(joined).toBe("echo: user: hello");
  });

  it("invoke forwards system prompt to the CLI via --system", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      system: "you are helpful",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    })) {
      events.push(ev);
    }

    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toContain("[system:");
  });

  it("invoke folds multi-turn message history into a single prompt", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "second" }] }
      ]
    })) {
      events.push(ev);
    }

    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    // The mock echoes back the prompt. The folded prompt should include all
    // three messages clearly delimited by role.
    expect(text).toContain("user: first");
    expect(text).toContain("assistant: ok");
    expect(text).toContain("user: second");
  });

  it("invoke throws on multimodal content (Plan 02 scope is text-only)", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });

    await expect(async () => {
      for await (const _ of backend.invoke({
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              { type: "image", mediaType: "image/png", data: "BASE64" }
            ]
          }
        ]
      })) {
        // no-op
      }
    }).rejects.toThrow(/multimodal/i);
  });

  it("invoke throws on tools array (Plan 02 scope is no-tools)", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });

    await expect(async () => {
      for await (const _ of backend.invoke({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "calc", inputSchema: {} }]
      })) {
        // no-op
      }
    }).rejects.toThrow(/tool/i);
  });
});
