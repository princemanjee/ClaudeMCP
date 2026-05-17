import spawn from "cross-spawn";
import treeKill from "tree-kill";
import type { ClaudeStreamOptions } from "./types.js";

/**
 * Build argv for `claude -p ... --output-format stream-json`. Pure; no side effects.
 */
export function buildStreamArgs(opts: ClaudeStreamOptions): string[] {
  const args: string[] = [];
  if (opts.systemPrompt !== undefined) {
    args.push("--system", opts.systemPrompt);
  }
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }
  args.push("-p", opts.prompt);
  args.push("--output-format", "stream-json");
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
