import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  buildStreamArgs,
  runGeminiStream
} from "../../../src/runners/geminiStreamRunner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_GEMINI = ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")];

describe("buildStreamArgs", () => {
  it("emits --prompt prompt and --output-format stream", () => {
    expect(
      buildStreamArgs({
        prompt: "hi",
        timeoutMs: 1000,
        geminiCommand: "gemini"
      })
    ).toEqual(["--prompt", "hi", "--output-format", "stream"]);
  });

  it("prepends --system when systemPrompt is set", () => {
    const args = buildStreamArgs({
      prompt: "hi",
      systemPrompt: "you are helpful",
      timeoutMs: 1000,
      geminiCommand: "gemini"
    });
    expect(args).toEqual([
      "--system",
      "you are helpful",
      "--prompt",
      "hi",
      "--output-format",
      "stream"
    ]);
  });

  it("inserts --model and --system before --prompt", () => {
    const args = buildStreamArgs({
      prompt: "hi",
      systemPrompt: "sys",
      model: "gemini-pro",
      timeoutMs: 1000,
      geminiCommand: "gemini"
    });
    expect(args).toEqual([
      "--system",
      "sys",
      "--model",
      "gemini-pro",
      "--prompt",
      "hi",
      "--output-format",
      "stream"
    ]);
  });

  it("appends sampling controls when set", () => {
    const args = buildStreamArgs({
      prompt: "hi",
      temperature: 0.7,
      topP: 0.95,
      topK: 64,
      timeoutMs: 1000,
      geminiCommand: "gemini"
    });
    expect(args).toContain("--temperature");
    expect(args[args.indexOf("--temperature") + 1]).toBe("0.7");
    expect(args).toContain("--top-p");
    expect(args).toContain("--top-k");
  });

  it("appends repeated --stop for each stop sequence", () => {
    const args = buildStreamArgs({
      prompt: "hi",
      stopSequences: ["END"],
      timeoutMs: 1000,
      geminiCommand: "gemini"
    });
    expect(args.filter((a) => a === "--stop").length).toBe(1);
  });
});

describe("runGeminiStream (against mock-gemini)", () => {
  async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const ev of stream) out.push(ev);
    return out;
  }

  it("yields candidates chunks in order, ending with finishReason STOP", async () => {
    const events = await collect(
      runGeminiStream({
        prompt: "hello",
        timeoutMs: 5000,
        geminiCommand: MOCK_GEMINI
      })
    );
    expect(events.length).toBeGreaterThanOrEqual(1);

    const last = events[events.length - 1] as {
      candidates?: Array<{ finishReason?: string }>;
    };
    expect(last.candidates?.[0]?.finishReason).toBe("STOP");
  });

  it("each non-final chunk carries a text part", async () => {
    const events = await collect(
      runGeminiStream({
        prompt: "hello",
        timeoutMs: 5000,
        geminiCommand: MOCK_GEMINI
      })
    );
    for (const ev of events) {
      const chunk = ev as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
      expect(typeof text).toBe("string");
    }
  });

  it("final chunk carries usageMetadata", async () => {
    const events = await collect(
      runGeminiStream({
        prompt: "hello",
        timeoutMs: 5000,
        geminiCommand: MOCK_GEMINI
      })
    );
    const last = events[events.length - 1] as { usageMetadata?: unknown };
    expect(last.usageMetadata).toBeDefined();
  });

  it("yields nothing extra when prompt triggers MOCK_INVALID_JSON (lines are skipped)", async () => {
    const events = await collect(
      runGeminiStream({
        prompt: "MOCK_INVALID_JSON",
        timeoutMs: 5000,
        geminiCommand: MOCK_GEMINI
      })
    );
    // mock-gemini emits a non-JSON line then exits. Stream runner silently
    // drops unparseable lines, so the iterator completes with zero events.
    expect(events).toEqual([]);
  });

  it("stops iterating after timeout kills the process", async () => {
    const events = await collect(
      runGeminiStream({
        prompt: "MOCK_SLEEP_FOREVER",
        timeoutMs: 250,
        geminiCommand: MOCK_GEMINI
      })
    );
    expect(events).toEqual([]);
  });
});
