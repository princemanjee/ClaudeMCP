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

  it("invoke forwards tools to the CLI via --tools flag", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: [{ type: "text", text: "MOCK_VISION_REQUEST" }] }],
      tools: [
        {
          name: "calculator",
          description: "Adds two numbers",
          inputSchema: { type: "object" }
        }
      ]
    })) {
      events.push(ev);
    }
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke inlines an image content block into the folded prompt", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    // The mock echoes the inbound prompt back. Confirm the envelope made it
    // through.
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image", mediaType: "image/png", data: "AAAAAA" }
          ]
        }
      ]
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toContain("[image:image/png;base64,AAAAAA]");
  });

  it("invoke inlines a document content block into the folded prompt", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "document", mediaType: "application/pdf", data: "JVBERi0=" }
          ]
        }
      ]
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toContain("[document:application/pdf;base64,JVBERi0=]");
  });

  it("invoke re-inlines a tool_result block into the folded prompt", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: [{ type: "text", text: "compute" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "calc", input: { x: 1, y: 2 } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "t1", content: "3" },
            { type: "text", text: "MOCK_TOOL_RESULT_ECHO" }
          ]
        }
      ]
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toContain("echo[tool_result:t1]=3");
  });

  it("invoke appends tool_choice 'any' directive to system prompt", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      system: "be precise",
      toolChoice: "any",
      tools: [{ name: "calc", inputSchema: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    // The mock echoes the system prompt prefix when set.
    expect(text).toContain("[system: be precise");
    expect(text).toMatch(/must call exactly one tool/i);
  });

  it("invoke appends tool_choice 'none' directive", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      system: "be terse",
      toolChoice: "none",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toMatch(/do not call any tools/i);
  });

  it("invoke appends tool_choice named-tool directive", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      system: "go",
      toolChoice: { type: "tool", name: "calculator" },
      tools: [{ name: "calculator", inputSchema: {} }, { name: "search", inputSchema: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toMatch(/only call ['`]?calculator['`]?/i);
  });

  it("invoke for tool_choice 'auto' does NOT append any directive", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      system: "verbatim-system-prompt-marker",
      toolChoice: "auto",
      tools: [{ name: "calc", inputSchema: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toContain("verbatim-system-prompt-marker");
    // No additional sentences after the user system text.
    expect(text).not.toMatch(/(must call|do not call|only call)/i);
  });

  it("invoke emits message_stop with stopReason 'stop_sequence' when matched", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 10000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: [{ type: "text", text: "MOCK_STOP_SEQUENCE_AT(STOP-NOW)" }] }
      ],
      stopSequences: ["STOP-NOW"]
    })) {
      events.push(ev);
    }
    const stop = events[events.length - 1];
    expect(stop?.kind).toBe("message_stop");
    if (stop?.kind === "message_stop") {
      expect(stop.stopReason).toBe("stop_sequence");
    }
    // Text accumulated before the cut should NOT contain the sequence itself.
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).not.toContain("STOP-NOW");
    expect(text).not.toContain("AFTER-SHOULD-BE-DROPPED");
  });
});
