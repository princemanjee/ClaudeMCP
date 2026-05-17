import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { GeminiBackend } from "../../../src/backends/geminiBackend.js";
import type { NormalizedEvent } from "../../../src/backends/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    // Plan 07 flipped this on (was false in Plan 06 baseline).
    expect(caps.toolUse).toBe(true);
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

  it("invoke streams: emits message_start, text_delta(s), message_stop in order", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-flash",
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
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-flash",
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
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-flash",
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
    expect(text).toContain("user: first");
    expect(text).toContain("assistant: ok");
    expect(text).toContain("user: second");
  });

  it("invoke forwards samplingParams to the CLI (Gemini honors them natively)", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    // mock-gemini doesn't check sampling values, but we verify the invoke path
    // doesn't throw when they are set, unlike Claude which ignores them per
    // capability matrix.
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      samplingParams: { temperature: 0.7, topP: 0.9, topK: 40 }
    })) {
      events.push(ev);
    }
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke surfaces usage from the final chunk's usageMetadata", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    })) {
      events.push(ev);
    }
    const stop = events[events.length - 1];
    if (stop?.kind === "message_stop") {
      expect(stop.usage).toBeDefined();
      expect(stop.usage?.inputTokens).toBeGreaterThan(0);
      expect(stop.usage?.outputTokens).toBeGreaterThan(0);
    } else {
      throw new Error("expected message_stop as last event");
    }
  });

  it("invoke accepts tools array without throwing (Plan 07)", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-pro",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "calc", inputSchema: { type: "object" } }]
    })) {
      events.push(ev);
    }
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke accepts stopSequences array without throwing (Plan 07)", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-pro",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      stopSequences: ["END"]
    })) {
      events.push(ev);
    }
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke accepts multimodal content blocks without throwing (Plan 07)", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-pro",
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
      events.push(ev);
    }
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke emits tool_use_start + tool_use_delta + tool_use_stop for Gemini functionCall parts", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-pro",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: 'MOCK_FUNCTION_CALL(calc|{"x":1,"y":2})' }]
        }
      ],
      tools: [{ name: "calc", inputSchema: { type: "object" } }]
    })) {
      events.push(ev);
    }

    const starts = events.filter((e) => e.kind === "tool_use_start");
    const deltas = events.filter((e) => e.kind === "tool_use_delta");
    const stops = events.filter((e) => e.kind === "tool_use_stop");
    expect(starts.length).toBe(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(stops.length).toBe(1);

    if (starts[0]?.kind === "tool_use_start") {
      expect(starts[0].name).toBe("calc");
    }
    if (deltas[0]?.kind === "tool_use_delta") {
      // Concatenated partials should parse to the original args.
      const joined = deltas.map((d) => (d.kind === "tool_use_delta" ? d.partialJson : "")).join("");
      expect(JSON.parse(joined)).toEqual({ x: 1, y: 2 });
    }
  });
});
