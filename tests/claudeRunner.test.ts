import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runClaude, buildArgs } from "../src/claudeRunner.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-mcp-runner-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Writes a mock claude script that emits canned output and exits with a
 * given code. Returns the ["node", path] array form of claudeCommand.
 */
function makeMock(
  stdoutJson: string,
  stderr = "",
  exitCode = 0,
  delayMs = 0,
): [string, string] {
  const scriptPath = join(tmpDir, "mock-claude.mjs");
  writeFileSync(
    scriptPath,
    `
    const out = ${JSON.stringify(stdoutJson)};
    const err = ${JSON.stringify(stderr)};
    const delay = ${delayMs};
    setTimeout(() => {
      if (out) process.stdout.write(out);
      if (err) process.stderr.write(err);
      process.exit(${exitCode});
    }, delay);
    `,
    "utf8",
  );
  return ["node", scriptPath];
}

describe("buildArgs", () => {
  test("stateless with skip-permissions", () => {
    const args = buildArgs({
      prompt: "hello",
      dangerouslySkipPermissions: true,
      timeoutMs: 1000,
      claudeCommand: "claude",
    });
    expect(args).toEqual([
      "-p",
      "hello",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ]);
  });

  test("stateless with allowed-tools", () => {
    const args = buildArgs({
      prompt: "hello",
      allowedTools: "Read,Edit",
      dangerouslySkipPermissions: false,
      timeoutMs: 1000,
      claudeCommand: "claude",
    });
    expect(args).toEqual([
      "-p",
      "hello",
      "--output-format",
      "json",
      "--allowed-tools",
      "Read,Edit",
    ]);
  });

  test("resumes a session", () => {
    const args = buildArgs({
      prompt: "keep going",
      resumeSessionId: "sess-1",
      dangerouslySkipPermissions: true,
      timeoutMs: 1000,
      claudeCommand: "claude",
    });
    expect(args).toEqual([
      "--resume",
      "sess-1",
      "-p",
      "keep going",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ]);
  });

  test("empty allowed-tools still emits the flag (ask-style lock-down)", () => {
    const args = buildArgs({
      prompt: "h",
      allowedTools: "",
      dangerouslySkipPermissions: false,
      timeoutMs: 1000,
      claudeCommand: "claude",
    });
    expect(args).toContain("--allowed-tools");
    expect(args[args.indexOf("--allowed-tools") + 1]).toBe("");
  });
});

describe("runClaude", () => {
  test("parses sessionId from JSON output on success", async () => {
    const cmd = makeMock(
      JSON.stringify({ session_id: "sess-abc", result: "done" }),
    );
    const res = await runClaude({
      prompt: "p",
      dangerouslySkipPermissions: true,
      timeoutMs: 5000,
      claudeCommand: cmd,
    });
    expect(res.exitCode).toBe(0);
    expect(res.sessionId).toBe("sess-abc");
    expect(res.timedOut).toBe(false);
    expect(res.text).toContain("done");
  });

  test("prompts containing spaces and quotes survive unchanged", async () => {
    const cmd = makeMock(
      JSON.stringify({ session_id: "sid", result: "ok" }),
    );
    // If spawn's arg escaping is broken, a prompt with a space + quote
    // either explodes the mock's argv parsing or triggers a shell
    // injection. We just want it to run cleanly and exit 0.
    const res = await runClaude({
      prompt: `hello "world" with 'quotes' & pipes`,
      dangerouslySkipPermissions: true,
      timeoutMs: 5000,
      claudeCommand: cmd,
    });
    expect(res.exitCode).toBe(0);
    expect(res.sessionId).toBe("sid");
  });

  test("returns non-zero exit with stderr captured", async () => {
    const cmd = makeMock("", "boom", 7);
    const res = await runClaude({
      prompt: "p",
      dangerouslySkipPermissions: true,
      timeoutMs: 5000,
      claudeCommand: cmd,
    });
    expect(res.exitCode).toBe(7);
    expect(res.stderr).toContain("boom");
    expect(res.sessionId).toBe(null);
  });

  test("times out and kills the process", async () => {
    const cmd = makeMock(
      JSON.stringify({ session_id: "s", result: "late" }),
      "",
      0,
      1500,
    );
    const res = await runClaude({
      prompt: "p",
      dangerouslySkipPermissions: true,
      timeoutMs: 100,
      claudeCommand: cmd,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
  });

  test("reports a failure when the command is missing", async () => {
    const res = await runClaude({
      prompt: "p",
      dangerouslySkipPermissions: true,
      timeoutMs: 1000,
      claudeCommand: "definitely-not-a-real-binary-xyzzy",
    });
    // On Linux cross-spawn emits an 'error' event and runClaude returns
    // exit -1. On Windows a missing binary may return a non-zero exit
    // from the shim layer without the error event. Either counts as a
    // failure — we just need the caller to see something non-zero.
    expect(res.exitCode).not.toBe(0);
  });

  test("falls back to raw stdout when output is not JSON", async () => {
    const cmd = makeMock("plain text, not json");
    const res = await runClaude({
      prompt: "p",
      dangerouslySkipPermissions: true,
      timeoutMs: 5000,
      claudeCommand: cmd,
    });
    expect(res.exitCode).toBe(0);
    expect(res.sessionId).toBe(null);
    expect(res.text).toContain("plain text");
  });
});
