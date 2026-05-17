import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  buildStreamArgs,
  runClaudeStream
} from "../../../src/runners/claudeStreamRunner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_CLAUDE = ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")];

describe("buildStreamArgs", () => {
  it("emits -p prompt and --output-format stream-json", () => {
    expect(
      buildStreamArgs({
        prompt: "hi",
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).toEqual(["-p", "hi", "--output-format", "stream-json"]);
  });

  it("prepends --system when systemPrompt is set", () => {
    const args = buildStreamArgs({
      prompt: "hi",
      systemPrompt: "you are helpful",
      timeoutMs: 1000,
      claudeCommand: "claude"
    });
    expect(args).toEqual([
      "--system",
      "you are helpful",
      "-p",
      "hi",
      "--output-format",
      "stream-json"
    ]);
  });

  it("inserts --resume between --system and -p", () => {
    const args = buildStreamArgs({
      prompt: "hi",
      systemPrompt: "sys",
      resumeSessionId: "sess-1",
      timeoutMs: 1000,
      claudeCommand: "claude"
    });
    expect(args).toEqual([
      "--system",
      "sys",
      "--resume",
      "sess-1",
      "-p",
      "hi",
      "--output-format",
      "stream-json"
    ]);
  });

  it("appends --dangerously-skip-permissions when requested", () => {
    expect(
      buildStreamArgs({
        prompt: "hi",
        dangerouslySkipPermissions: true,
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).toContain("--dangerously-skip-permissions");
  });
});

describe("runClaudeStream (against mock-claude)", () => {
  async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const ev of stream) out.push(ev);
    return out;
  }

  it("yields system init, assistant chunks, and result events in order", async () => {
    const events = await collect(
      runClaudeStream({
        prompt: "hello",
        timeoutMs: 5000,
        claudeCommand: MOCK_CLAUDE
      })
    );
    expect(events.length).toBeGreaterThanOrEqual(3);

    const first = events[0] as { type: string; subtype?: string };
    expect(first.type).toBe("system");
    expect(first.subtype).toBe("init");

    const last = events[events.length - 1] as { type: string };
    expect(last.type).toBe("result");
  });

  it("yields nothing extra when prompt triggers MOCK_INVALID_JSON (lines are skipped)", async () => {
    const events = await collect(
      runClaudeStream({
        prompt: "MOCK_INVALID_JSON",
        timeoutMs: 5000,
        claudeCommand: MOCK_CLAUDE
      })
    );
    // mock-claude emits a non-JSON line then exits. Stream runner silently
    // drops unparseable lines, so the iterator completes with zero events.
    expect(events).toEqual([]);
  });

  it("stops iterating after timeout kills the process", async () => {
    const events = await collect(
      runClaudeStream({
        prompt: "MOCK_SLEEP_FOREVER",
        timeoutMs: 250,
        claudeCommand: MOCK_CLAUDE
      })
    );
    // No events emitted before kill.
    expect(events).toEqual([]);
  });
});
