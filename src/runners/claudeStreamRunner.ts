import spawn from "cross-spawn";
import treeKill from "tree-kill";
import type { ClaudeStreamOptions } from "./types.js";

// ---- Stop-sequence cutter -------------------------------------------------

export interface StopSequenceMatch {
  matched: true;
  /** Index INTO the chunk passed to feed() where the match starts. */
  cutAt: number;
  matchedSequence: string;
  /**
   * What the matcher's internal tail buffer holds after this match. The
   * runner ignores it on a positive match (it kills the child anyway) but
   * the field is here to keep the public shape symmetrical for tests.
   */
  tailForNext: string;
}

export type StopSequenceFeedResult =
  | { matched: false }
  | StopSequenceMatch;

export interface StopSequenceMatcher {
  feed(chunk: string): StopSequenceFeedResult;
}

/**
 * Build a stateful matcher that tracks a rolling tail across feed() calls so
 * stop sequences split across chunk boundaries are still caught. Pure
 * factory — no side effects, no IO. Exported for direct unit testing.
 */
export function createStopSequenceMatcher(
  stopSequences: readonly string[]
): StopSequenceMatcher {
  const active = stopSequences.filter((s) => s.length > 0);
  const maxLen = active.reduce((m, s) => Math.max(m, s.length), 0);
  const tailSize = Math.max(0, maxLen - 1);
  let tail = "";

  return {
    feed(chunk: string): StopSequenceFeedResult {
      if (active.length === 0) {
        return { matched: false };
      }
      const haystack = tail + chunk;
      let earliest: { idx: number; seq: string } | null = null;
      for (const seq of active) {
        const idx = haystack.indexOf(seq);
        if (idx === -1) continue;
        if (earliest === null || idx < earliest.idx) {
          earliest = { idx, seq };
        }
      }
      if (earliest !== null) {
        // Translate haystack offset back into chunk offset.
        const cutInChunk = Math.max(0, earliest.idx - tail.length);
        tail = "";
        return {
          matched: true,
          cutAt: cutInChunk,
          matchedSequence: earliest.seq,
          tailForNext: ""
        };
      }
      // No match — retain the trailing (tailSize) chars of haystack for the
      // next call.
      tail = haystack.length > tailSize ? haystack.slice(-tailSize) : haystack;
      return { matched: false };
    }
  };
}

/**
 * Build argv for `claude -p ... --output-format stream-json`. Pure; no side effects.
 */
export function buildStreamArgs(opts: ClaudeStreamOptions): string[] {
  const args: string[] = [];
  if (opts.systemPrompt !== undefined) {
    args.push("--system-prompt", opts.systemPrompt);
  }
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }
  args.push("-p", opts.prompt);
  args.push("--output-format", "stream-json");
  // Required: as of recent Claude Code releases, stream-json emits only
  // hook/init system events unless --verbose is set. Without it the runner
  // never sees assistant/result events and returns empty content.
  args.push("--verbose");
  if (opts.tools && opts.tools.length > 0) {
    args.push("--tools", JSON.stringify(opts.tools));
  }
  if (opts.stopSequences && opts.stopSequences.length > 0) {
    args.push("--stop-sequences", JSON.stringify(opts.stopSequences));
  }
  if (opts.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else if (opts.allowedTools !== undefined) {
    args.push("--allowed-tools", opts.allowedTools);
  }
  return args;
}

function splitCommand(
  cmd: string | string[]
): [string, string[]] {
  if (Array.isArray(cmd)) {
    const [head, ...rest] = cmd;
    if (!head) throw new Error("claudeCommand array must be non-empty");
    return [head, rest];
  }
  return [cmd, []];
}

export async function* runClaudeStream(
  opts: ClaudeStreamOptions
): AsyncIterable<unknown> {
  const args = buildStreamArgs(opts);
  const [cmd, prefixArgs] = splitCommand(opts.claudeCommand);
  const child = spawn(cmd, [...prefixArgs, ...args], {
    cwd: opts.workDir,
    windowsHide: true
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) {
      treeKill(child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  }, opts.timeoutMs);

  const queue: unknown[] = [];
  let done = false;
  let spawnErrored = false;
  let waker: (() => void) | null = null;

  function wake(): void {
    if (waker) {
      const w = waker;
      waker = null;
      w();
    }
  }

  const matcher =
    opts.stopSequences && opts.stopSequences.length > 0
      ? createStopSequenceMatcher(opts.stopSequences)
      : null;

  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          // Stop-sequence sniff on assistant text content.
          if (matcher !== null && parsed["type"] === "assistant") {
            const message = parsed["message"] as
              | { content?: Array<{ type?: string; text?: string }> }
              | undefined;
            const content = message?.content;
            if (Array.isArray(content)) {
              let cutInfo: StopSequenceMatch | null = null;
              const newContent = content.map((block) => {
                if (cutInfo !== null) return block;
                if (block?.type === "text" && typeof block.text === "string") {
                  const r = matcher.feed(block.text);
                  if (r.matched) {
                    cutInfo = r;
                    return { ...block, text: block.text.slice(0, r.cutAt) };
                  }
                }
                return block;
              });
              if (cutInfo !== null) {
                const matched: StopSequenceMatch = cutInfo;
                // Push the truncated event, then the sentinel. Use a fresh
                // object so we don't mutate the caller's parsed view.
                queue.push({ ...parsed, message: { ...message, content: newContent } });
                queue.push({
                  type: "_internal",
                  subtype: "stop_sequence_match",
                  matchedSequence: matched.matchedSequence
                });
                done = true;
                if (child.pid !== undefined) treeKill(child.pid, "SIGKILL");
                else child.kill("SIGKILL");
                wake();
                return;
              }
            }
          }
          queue.push(parsed);
        } catch {
          // Malformed line — skip silently; caller just sees fewer events.
        }
      }
      nl = buffer.indexOf("\n");
    }
    wake();
  });

  child.on("error", () => {
    spawnErrored = true;
    wake();
  });

  child.on("close", () => {
    clearTimeout(timer);
    // Flush any residual buffered line that wasn't terminated with \n
    const trailing = buffer.trim();
    if (trailing.length > 0) {
      try {
        queue.push(JSON.parse(trailing));
      } catch {
        // ignore
      }
    }
    done = true;
    wake();
  });

  while (true) {
    if (queue.length > 0) {
      // Non-null assertion safe here because we just checked length > 0.
      // noUncheckedIndexedAccess widens Array#shift to T | undefined.
      yield queue.shift()!;
      continue;
    }
    if (done) break;
    if (timedOut || spawnErrored) break;
    await new Promise<void>((resolve) => {
      waker = resolve;
    });
  }
}
