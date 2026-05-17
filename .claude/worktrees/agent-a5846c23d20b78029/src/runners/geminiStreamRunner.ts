// Gemini streaming CLI invoker. Mirrors claudeStreamRunner.ts in shape; differs
// only in the argv (uses `--output-format stream`, not `stream-json`) and in
// caller expectations of the parsed object shape (Gemini emits
// `{candidates: [...]}` chunks, not Claude's `{type: "...", message: ...}`).

import spawn from "cross-spawn";
import treeKill from "tree-kill";
import type { GeminiStreamOptions } from "./types.js";

/**
 * Build argv for `gemini --prompt ... --output-format stream`. Pure; no side effects.
 */
export function buildStreamArgs(opts: GeminiStreamOptions): string[] {
  const args: string[] = [];
  if (opts.systemPrompt !== undefined) {
    args.push("--system", opts.systemPrompt);
  }
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }
  args.push("--prompt", opts.prompt);
  args.push("--output-format", "stream");
  if (opts.temperature !== undefined) {
    args.push("--temperature", String(opts.temperature));
  }
  if (opts.topP !== undefined) {
    args.push("--top-p", String(opts.topP));
  }
  if (opts.topK !== undefined) {
    args.push("--top-k", String(opts.topK));
  }
  if (opts.stopSequences) {
    for (const seq of opts.stopSequences) {
      args.push("--stop", seq);
    }
  }
  return args;
}

function splitCommand(cmd: string | string[]): [string, string[]] {
  if (Array.isArray(cmd)) {
    const [head, ...rest] = cmd;
    if (!head) throw new Error("geminiCommand array must be non-empty");
    return [head, rest];
  }
  return [cmd, []];
}

export async function* runGeminiStream(
  opts: GeminiStreamOptions
): AsyncIterable<unknown> {
  const args = buildStreamArgs(opts);
  const [cmd, prefixArgs] = splitCommand(opts.geminiCommand);
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

  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) {
        try {
          queue.push(JSON.parse(line));
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
      // Non-null assertion safe under noUncheckedIndexedAccess: the
      // `queue.length > 0` guard above guarantees a value is present.
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
