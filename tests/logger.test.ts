import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Logger,
  containsQuestionHeuristic,
  truncateUtf8,
} from "../src/logger.js";

let tmpDir: string;
let logFile: string;
let logger: Logger;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-mcp-log-"));
  logFile = join(tmpDir, "a.log");
  logger = new Logger(logFile);
});

afterEach(async () => {
  await logger.flush();
  rmSync(tmpDir, { recursive: true, force: true });
});

function readLines(): Record<string, unknown>[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("Logger", () => {
  test("writes one JSON-lines entry with all fields", async () => {
    await logger.log({
      timestamp: "2026-04-18T00:00:00.000Z",
      logId: "id-1",
      tool: "claude_ask",
      status: "success",
      durationMs: 100,
      prompt: "hello",
      output: "hi",
      containsQuestion: false,
      exitCode: 0,
    });
    await logger.flush();
    const lines = readLines();
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({
      logId: "id-1",
      tool: "claude_ask",
      output: "hi",
    });
  });

  test("preserves order under concurrent writes", async () => {
    const count = 50;
    await Promise.all(
      Array.from({ length: count }).map((_, i) =>
        logger.log({
          timestamp: new Date().toISOString(),
          logId: `id-${i}`,
          tool: "claude_ask",
          status: "success",
          durationMs: 1,
          prompt: `p-${i}`,
          output: `o-${i}`,
          containsQuestion: false,
          exitCode: 0,
        }),
      ),
    );
    await logger.flush();
    const lines = readLines();
    expect(lines.length).toBe(count);
    for (let i = 0; i < count; i++) {
      expect(lines[i]?.logId).toBe(`id-${i}`);
    }
  });

  test("creates parent directory if missing", async () => {
    const nested = join(tmpDir, "nested", "deep", "a.log");
    const l = new Logger(nested);
    await l.log({
      timestamp: "t",
      logId: "x",
      tool: "claude_ask",
      status: "success",
      durationMs: 0,
      prompt: "",
      output: "",
      containsQuestion: false,
      exitCode: 0,
    });
    await l.flush();
    expect(existsSync(nested)).toBe(true);
  });
});

describe("truncateUtf8", () => {
  test("returns input unchanged when within limit", () => {
    const r = truncateUtf8("hello", 100);
    expect(r.text).toBe("hello");
    expect(r.truncated).toBe(false);
  });

  test("truncates long ascii to requested byte length", () => {
    const input = "a".repeat(5000);
    const r = truncateUtf8(input, 100);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(100);
  });

  test("does not split a multi-byte character", () => {
    // "😀" is 4 bytes in UTF-8. Truncating a 25-char run to 10 bytes
    // must not produce a partial code unit.
    const input = "😀".repeat(25);
    const r = truncateUtf8(input, 10);
    expect(r.truncated).toBe(true);
    // Decoded text must be valid UTF-8 (round-trips cleanly)
    const roundTrip = Buffer.from(r.text, "utf8").toString("utf8");
    expect(roundTrip).toBe(r.text);
    // Must contain only whole emoji characters, no replacement chars
    expect(r.text).not.toContain("\uFFFD");
  });
});

describe("containsQuestionHeuristic", () => {
  test("trimmed output ending with '?' counts as question", () => {
    expect(containsQuestionHeuristic("Which file?  ")).toBe(true);
    expect(containsQuestionHeuristic("done.")).toBe(false);
  });

  test("recognizes documented phrases case-insensitively", () => {
    for (const p of [
      "which do you want to use",
      "Should I proceed.",
      "do you want me to continue",
      "Please clarify what you mean",
      "can you tell me more",
    ]) {
      expect(containsQuestionHeuristic(p)).toBe(true);
    }
  });

  test("ignores question-like phrases inside unrelated sentences", () => {
    expect(containsQuestionHeuristic("Refactored auth module")).toBe(false);
    expect(containsQuestionHeuristic("")).toBe(false);
  });
});
