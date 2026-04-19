import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runClaudeStream } from "../src/claudeStreamRunner.js";
import type { StreamJsonEvent } from "../src/openaiShim/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-mcp-stream-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeStreamMock(lines: string[], exitCode = 0): [string, string] {
  const scriptPath = join(tmpDir, "mock-stream.mjs");
  writeFileSync(
    scriptPath,
    `
    const lines = ${JSON.stringify(lines)};
    let i = 0;
    function tick() {
      if (i < lines.length) {
        process.stdout.write(lines[i] + "\\n");
        i++;
        setTimeout(tick, 5);
      } else {
        process.exit(${exitCode});
      }
    }
    tick();
    `,
    "utf8",
  );
  return ["node", scriptPath];
}

async function collect(gen: AsyncIterable<StreamJsonEvent>): Promise<StreamJsonEvent[]> {
  const out: StreamJsonEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("runClaudeStream", () => {
  test("yields each JSON line in order", async () => {
    const cmd = makeStreamMock([
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", session_id: "s-1" }),
    ]);
    const events = await collect(
      runClaudeStream({
        prompt: "p",
        dangerouslySkipPermissions: false,
        allowedTools: "",
        timeoutMs: 5000,
        claudeCommand: cmd,
      }),
    );
    expect(events.length).toBe(3);
    expect(events[0]?.type).toBe("system");
    expect(events[1]?.type).toBe("assistant");
    expect(events[2]?.type).toBe("result");
  });

  test("skips malformed JSON lines but yields valid ones", async () => {
    const cmd = makeStreamMock([
      "{ not json",
      JSON.stringify({ type: "result", subtype: "success" }),
    ]);
    const events = await collect(
      runClaudeStream({
        prompt: "p",
        dangerouslySkipPermissions: false,
        allowedTools: "",
        timeoutMs: 5000,
        claudeCommand: cmd,
      }),
    );
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("result");
  });

  test("returns on non-zero exit", async () => {
    const cmd = makeStreamMock([], 4);
    const events = await collect(
      runClaudeStream({
        prompt: "p",
        dangerouslySkipPermissions: false,
        allowedTools: "",
        timeoutMs: 5000,
        claudeCommand: cmd,
      }),
    );
    expect(events.length).toBe(0);
  });

  test("times out and stops yielding", async () => {
    const scriptPath = join(tmpDir, "slow-stream.mjs");
    writeFileSync(
      scriptPath,
      `
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\\n");
      }, 2000);
      setTimeout(() => process.exit(0), 10000);
      `,
      "utf8",
    );
    const events = await collect(
      runClaudeStream({
        prompt: "p",
        dangerouslySkipPermissions: false,
        allowedTools: "",
        timeoutMs: 100,
        claudeCommand: ["node", scriptPath],
      }),
    );
    expect(events.length).toBe(0);
  });

  test("passes through resume session and system prompt flags", async () => {
    const scriptPath = join(tmpDir, "argv-echo.mjs");
    writeFileSync(
      scriptPath,
      `
      process.stderr.write(JSON.stringify(process.argv.slice(2)));
      process.exit(0);
      `,
      "utf8",
    );
    const events = await collect(
      runClaudeStream({
        prompt: "p",
        resumeSessionId: "sess-resume-1",
        systemPrompt: "SYS",
        dangerouslySkipPermissions: false,
        allowedTools: "",
        timeoutMs: 5000,
        claudeCommand: ["node", scriptPath],
      }),
    );
    expect(events.length).toBe(0);
  });
});
