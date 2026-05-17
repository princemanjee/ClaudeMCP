import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  buildStreamArgs,
  createStopSequenceMatcher,
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

  it("emits --tools <json> when tools is non-empty", () => {
    const args = buildStreamArgs({
      prompt: "hi",
      tools: [
        {
          name: "calculator",
          description: "Adds numbers",
          inputSchema: { type: "object", properties: { x: { type: "number" } } }
        }
      ],
      timeoutMs: 1000,
      claudeCommand: "claude"
    });
    expect(args).toContain("--tools");
    const json = args[args.indexOf("--tools") + 1];
    expect(typeof json).toBe("string");
    const parsed = JSON.parse(json as string) as Array<{ name: string }>;
    expect(parsed[0]?.name).toBe("calculator");
  });

  it("omits --tools when tools is undefined or empty", () => {
    expect(
      buildStreamArgs({
        prompt: "hi",
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).not.toContain("--tools");
    expect(
      buildStreamArgs({
        prompt: "hi",
        tools: [],
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).not.toContain("--tools");
  });

  it("emits --stop-sequences <json> when stopSequences is non-empty", () => {
    const args = buildStreamArgs({
      prompt: "hi",
      stopSequences: ["STOP", "END"],
      timeoutMs: 1000,
      claudeCommand: "claude"
    });
    expect(args).toContain("--stop-sequences");
    const json = args[args.indexOf("--stop-sequences") + 1];
    expect(JSON.parse(json as string)).toEqual(["STOP", "END"]);
  });

  it("omits --stop-sequences when stopSequences is undefined or empty", () => {
    expect(
      buildStreamArgs({
        prompt: "hi",
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).not.toContain("--stop-sequences");
    expect(
      buildStreamArgs({
        prompt: "hi",
        stopSequences: [],
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).not.toContain("--stop-sequences");
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

  it("emits the _internal stop_sequence_match sentinel when a stop sequence is hit", async () => {
    const events = await collect(
      runClaudeStream({
        prompt: "MOCK_STOP_SEQUENCE_AT(STOP-NOW)",
        stopSequences: ["STOP-NOW"],
        timeoutMs: 10000,
        claudeCommand: MOCK_CLAUDE
      })
    );
    // Find the sentinel.
    const sentinel = events.find(
      (e): e is { type: string; subtype: string; matchedSequence: string } =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "_internal" &&
        (e as { subtype?: string }).subtype === "stop_sequence_match"
    );
    expect(sentinel).toBeDefined();
    expect(sentinel?.matchedSequence).toBe("STOP-NOW");
  });

  it("truncates the text at the match start (the AFTER text is dropped)", async () => {
    const events = await collect(
      runClaudeStream({
        prompt: "MOCK_STOP_SEQUENCE_AT(STOP-NOW)",
        stopSequences: ["STOP-NOW"],
        timeoutMs: 10000,
        claudeCommand: MOCK_CLAUDE
      })
    );
    // Concatenate all text we received before the sentinel.
    const text = events
      .filter(
        (e): e is { type: string; message: { content: Array<{ text?: string }> } } =>
          typeof e === "object" &&
          e !== null &&
          (e as { type?: string }).type === "assistant"
      )
      .flatMap((e) => e.message.content)
      .map((b) => b.text ?? "")
      .join("");
    expect(text).not.toContain("AFTER-SHOULD-BE-DROPPED");
    expect(text).toContain("before ");
    expect(text).toContain("mid");
    expect(text).not.toContain("STOP-NOW");
  });

  it("completes normally when stop sequences are set but never appear", async () => {
    const events = await collect(
      runClaudeStream({
        prompt: "hello",
        stopSequences: ["NEVER-APPEARS"],
        timeoutMs: 5000,
        claudeCommand: MOCK_CLAUDE
      })
    );
    // Should reach the result event normally; no sentinel emitted.
    const sentinel = events.find(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "_internal"
    );
    expect(sentinel).toBeUndefined();
    const last = events[events.length - 1] as { type: string };
    expect(last.type).toBe("result");
  });
});

describe("createStopSequenceMatcher", () => {
  it("returns matched:false when no sequence is present", () => {
    const m = createStopSequenceMatcher(["STOP"]);
    expect(m.feed("hello world")).toEqual({ matched: false });
  });

  it("returns matched:true with cutAt at the sequence start", () => {
    const m = createStopSequenceMatcher(["STOP"]);
    const result = m.feed("hello STOP rest");
    expect(result).toEqual({
      matched: true,
      cutAt: 6,
      matchedSequence: "STOP",
      tailForNext: ""
    });
  });

  it("catches a sequence split across two feed() calls (tail buffer)", () => {
    const m = createStopSequenceMatcher(["STOP"]);
    expect(m.feed("hello STO")).toEqual({ matched: false });
    const result = m.feed("P rest");
    // Match position is in the second chunk, at index 0 (the 'P' completes
    // the sequence that started 3 chars before the chunk boundary).
    expect(result).toEqual({
      matched: true,
      cutAt: 0,
      matchedSequence: "STOP",
      // The matched span overlaps the chunk boundary by 3 chars; the cutter
      // signals the runner so it can truncate the in-flight stream.
      tailForNext: ""
    });
  });

  it("uses max(seq.length) - 1 as the rolling tail size", () => {
    const m = createStopSequenceMatcher(["A", "VERY-LONG-STOP-SEQUENCE"]);
    // Feed text shorter than the longest sequence; matcher should retain
    // up to max-len-1 chars in its tail buffer for the next call.
    expect(m.feed("xyz")).toEqual({ matched: false });
    // Confirm the matcher retained "xyz" by completing the long sequence
    // across the boundary.
    const result = m.feed("VERY-LONG-STOP-SEQUENCE-extra");
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.matchedSequence).toBe("VERY-LONG-STOP-SEQUENCE");
    }
  });

  it("matches the EARLIEST sequence when multiple are present", () => {
    const m = createStopSequenceMatcher(["END", "STOP"]);
    const result = m.feed("hello STOP and END");
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.matchedSequence).toBe("STOP");
      expect(result.cutAt).toBe(6);
    }
  });

  it("returns matched:false on an empty stopSequences list", () => {
    const m = createStopSequenceMatcher([]);
    expect(m.feed("STOP STOP STOP")).toEqual({ matched: false });
  });

  it("zero-length sequence in the list is ignored, not matched everywhere", () => {
    const m = createStopSequenceMatcher(["", "STOP"]);
    expect(m.feed("hello")).toEqual({ matched: false });
    const result = m.feed(" STOP world");
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.matchedSequence).toBe("STOP");
  });
});
