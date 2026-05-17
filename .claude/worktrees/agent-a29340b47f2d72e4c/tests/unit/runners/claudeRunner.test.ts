import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { buildArgs, runClaude } from "../../../src/runners/claudeRunner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_CLAUDE = ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")];

describe("buildArgs", () => {
  it("emits -p prompt and --output-format json by default", () => {
    expect(
      buildArgs({
        prompt: "hi",
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).toEqual(["-p", "hi", "--output-format", "json"]);
  });

  it("prepends --resume when resumeSessionId is set", () => {
    expect(
      buildArgs({
        prompt: "hi",
        resumeSessionId: "sess-1",
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).toEqual(["--resume", "sess-1", "-p", "hi", "--output-format", "json"]);
  });

  it("appends --dangerously-skip-permissions when requested", () => {
    expect(
      buildArgs({
        prompt: "hi",
        dangerouslySkipPermissions: true,
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).toContain("--dangerously-skip-permissions");
  });

  it("appends --allowed-tools when given and not dangerouslySkip", () => {
    const args = buildArgs({
      prompt: "hi",
      allowedTools: "Read,Edit",
      timeoutMs: 1000,
      claudeCommand: "claude"
    });
    expect(args).toContain("--allowed-tools");
    expect(args[args.indexOf("--allowed-tools") + 1]).toBe("Read,Edit");
  });

  it("dangerouslySkipPermissions wins over allowedTools", () => {
    const args = buildArgs({
      prompt: "hi",
      allowedTools: "Read",
      dangerouslySkipPermissions: true,
      timeoutMs: 1000,
      claudeCommand: "claude"
    });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allowed-tools");
  });
});

describe("runClaude (against mock-claude)", () => {
  it("extracts text from a normal response", async () => {
    const result = await runClaude({
      prompt: "hello",
      timeoutMs: 5000,
      claudeCommand: MOCK_CLAUDE
    });
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("echo: hello");
    expect(result.sessionId).toMatch(/^mock-session-/);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toBe("");
  });

  it("returns sessionId null and stderr when CLI exits non-zero", async () => {
    const result = await runClaude({
      prompt: "please MOCK_ERROR now",
      timeoutMs: 5000,
      claudeCommand: MOCK_CLAUDE
    });
    expect(result.exitCode).toBe(1);
    expect(result.sessionId).toBeNull();
    expect(result.stderr).toContain("mock error");
  });

  it("falls back to raw stdout when JSON parse fails", async () => {
    const result = await runClaude({
      prompt: "give me MOCK_INVALID_JSON",
      timeoutMs: 5000,
      claudeCommand: MOCK_CLAUDE
    });
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("this is not json at all");
    expect(result.sessionId).toBeNull();
  });

  it("times out after timeoutMs and kills the process", async () => {
    const start = Date.now();
    const result = await runClaude({
      prompt: "MOCK_SLEEP_FOREVER now",
      timeoutMs: 250,
      claudeCommand: MOCK_CLAUDE
    });
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it("returns spawn-failure result when binary is missing", async () => {
    const result = await runClaude({
      prompt: "hello",
      timeoutMs: 5000,
      claudeCommand: "definitely-not-a-real-binary-xyz"
    });
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("spawn error");
  });
});
