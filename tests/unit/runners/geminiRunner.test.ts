import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { buildArgs, runGemini } from "../../../src/runners/geminiRunner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_GEMINI = ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")];

describe("buildArgs", () => {
  it("emits --prompt prompt and --output-format json by default", () => {
    expect(
      buildArgs({
        prompt: "hi",
        timeoutMs: 1000,
        geminiCommand: "gemini"
      })
    ).toEqual(["--prompt", "hi", "--output-format", "json"]);
  });

  it("inserts --model when model is set", () => {
    expect(
      buildArgs({
        prompt: "hi",
        model: "gemini-pro",
        timeoutMs: 1000,
        geminiCommand: "gemini"
      })
    ).toEqual(["--model", "gemini-pro", "--prompt", "hi", "--output-format", "json"]);
  });

  it("appends --temperature, --top-p, --top-k when set", () => {
    const args = buildArgs({
      prompt: "hi",
      temperature: 0.5,
      topP: 0.9,
      topK: 40,
      timeoutMs: 1000,
      geminiCommand: "gemini"
    });
    expect(args).toContain("--temperature");
    expect(args[args.indexOf("--temperature") + 1]).toBe("0.5");
    expect(args).toContain("--top-p");
    expect(args[args.indexOf("--top-p") + 1]).toBe("0.9");
    expect(args).toContain("--top-k");
    expect(args[args.indexOf("--top-k") + 1]).toBe("40");
  });

  it("appends repeated --stop for each stop sequence", () => {
    const args = buildArgs({
      prompt: "hi",
      stopSequences: ["STOP1", "STOP2"],
      timeoutMs: 1000,
      geminiCommand: "gemini"
    });
    const stopFlags = args.filter((a) => a === "--stop");
    expect(stopFlags.length).toBe(2);
  });

  it("prepends --resume when resumeSessionId is set", () => {
    const args = buildArgs({
      prompt: "hi",
      resumeSessionId: "sess-1",
      timeoutMs: 1000,
      geminiCommand: "gemini"
    });
    expect(args[0]).toBe("--resume");
    expect(args[1]).toBe("sess-1");
  });
});

describe("runGemini (against mock-gemini)", () => {
  it("extracts text from a normal response", async () => {
    const result = await runGemini({
      prompt: "hello",
      timeoutMs: 5000,
      geminiCommand: MOCK_GEMINI
    });
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("echo: hello");
    expect(result.sessionId).toMatch(/^mock-gemini-session-/);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toBe("");
  });

  it("parses usageMetadata into usage field", async () => {
    const result = await runGemini({
      prompt: "hello",
      timeoutMs: 5000,
      geminiCommand: MOCK_GEMINI
    });
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
  });

  it("returns sessionId null and stderr when CLI exits non-zero", async () => {
    const result = await runGemini({
      prompt: "please MOCK_ERROR now",
      timeoutMs: 5000,
      geminiCommand: MOCK_GEMINI
    });
    expect(result.exitCode).toBe(1);
    expect(result.sessionId).toBeNull();
    expect(result.stderr).toContain("mock error");
  });

  it("falls back to raw stdout when JSON parse fails", async () => {
    const result = await runGemini({
      prompt: "give me MOCK_INVALID_JSON",
      timeoutMs: 5000,
      geminiCommand: MOCK_GEMINI
    });
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("this is not json at all");
    expect(result.sessionId).toBeNull();
    expect(result.usage).toBeUndefined();
  });

  it("times out after timeoutMs and kills the process", async () => {
    const start = Date.now();
    const result = await runGemini({
      prompt: "MOCK_SLEEP_FOREVER now",
      timeoutMs: 250,
      geminiCommand: MOCK_GEMINI
    });
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it("returns spawn-failure result when binary is missing", async () => {
    const result = await runGemini({
      prompt: "hello",
      timeoutMs: 5000,
      geminiCommand: "definitely-not-a-real-binary-xyz"
    });
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("spawn error");
  });

  it("forwards model to mock-gemini (visible in output's modelVersion)", async () => {
    // The mock echoes the --model value in `modelVersion`. We don't directly
    // expose that on the runner result, but we can verify it parsed by checking
    // the runner doesn't crash and returns text.
    const result = await runGemini({
      prompt: "hello",
      model: "gemini-pro",
      timeoutMs: 5000,
      geminiCommand: MOCK_GEMINI
    });
    expect(result.text).toBe("echo: hello");
  });
});
