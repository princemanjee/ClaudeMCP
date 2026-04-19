import spawn from "cross-spawn";
import treeKill from "tree-kill";
import type {
  ClaudeCommand,
  StreamJsonEvent,
} from "./openaiShim/types.js";

export type StreamRunOptions = {
  prompt: string;
  workDir?: string;
  resumeSessionId?: string;
  systemPrompt?: string;
  allowedTools?: string;
  dangerouslySkipPermissions: boolean;
  timeoutMs: number;
  claudeCommand: ClaudeCommand;
};

function buildStreamArgs(opts: StreamRunOptions): string[] {
  const args: string[] = [];
  if (opts.systemPrompt !== undefined) {
    args.push("--system", opts.systemPrompt);
  }
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }
  args.push("-p", opts.prompt);
  args.push("--output-format", "stream-json");
  if (opts.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else if (opts.allowedTools !== undefined) {
    args.push("--allowed-tools", opts.allowedTools);
  }
  return args;
}

function splitCommand(cmd: ClaudeCommand): [string, string[]] {
  if (Array.isArray(cmd)) {
    const [head, ...rest] = cmd;
    if (!head) throw new Error("claudeCommand array must be non-empty");
    return [head, rest];
  }
  return [cmd, []];
}

export async function* runClaudeStream(
  opts: StreamRunOptions,
): AsyncGenerator<StreamJsonEvent> {
  const args = buildStreamArgs(opts);
  const [cmd, prefixArgs] = splitCommand(opts.claudeCommand);
  const child = spawn(cmd, [...prefixArgs, ...args], {
    cwd: opts.workDir,
    windowsHide: true,
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

  const queue: StreamJsonEvent[] = [];
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
          const parsed = JSON.parse(line) as StreamJsonEvent;
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
  });

  child.on("close", () => {
    clearTimeout(timer);
    // Flush any residual buffered line that wasn't terminated with \n
    const trailing = buffer.trim();
    if (trailing.length > 0) {
      try {
        queue.push(JSON.parse(trailing) as StreamJsonEvent);
      } catch {
        // ignore
      }
    }
    done = true;
    wake();
  });

  while (true) {
    if (queue.length > 0) {
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
