// Gemini one-shot CLI invoker. Mirrors claudeRunner.ts structurally; differs
// only in the argv shape and the output-parsing path (Gemini puts text under
// `candidates[0].content.parts[*].text`, not under a top-level `result` field).
//
// Flag-name assumptions (verify against `gemini --help` at implementation time;
// update both this file AND `tests/fixtures/mock-gemini/index.mjs` in lockstep
// if reality differs):
//   --prompt <text>            prompt body
//   --output-format json       force JSON output
//   --model <id>               select model
//   --system <text>            system instruction
//   --resume <sessionId>       resume conversation (see open question)
//   --temperature <float>      sampling temperature
//   --top-p <float>            nucleus sampling
//   --top-k <int>              top-k sampling
//   --stop <seq>               native stop sequence (repeat for multiple)

import spawn from "cross-spawn";
import treeKill from "tree-kill";
import type { GeminiRunOptions, GeminiRunResult } from "./types.js";

/**
 * Build the argv array for `gemini --prompt ...`. Pure; no side effects.
 * Exported for unit testing without spawning the CLI.
 */
export function buildArgs(opts: GeminiRunOptions): string[] {
  const args: string[] = [];
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }
  args.push("--prompt", opts.prompt);
  args.push("--output-format", "json");
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

interface ParsedOutput {
  text: string;
  sessionId: string | null;
  usage?: { inputTokens: number; outputTokens: number };
}

function parseGeminiOutput(stdout: string): ParsedOutput {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: "", sessionId: null };
  try {
    const parsed = JSON.parse(trimmed) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
      sessionId?: string;
      session_id?: string;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      };
    };
    const parts = parsed.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
    const sid = parsed.sessionId ?? parsed.session_id ?? null;
    const usage = parsed.usageMetadata
      ? {
          inputTokens: parsed.usageMetadata.promptTokenCount ?? 0,
          outputTokens: parsed.usageMetadata.candidatesTokenCount ?? 0
        }
      : undefined;
    return { text, sessionId: typeof sid === "string" ? sid : null, usage };
  } catch {
    // Not JSON — error paths emit plain text. Return raw stdout, no session id.
    return { text: trimmed, sessionId: null };
  }
}

export function runGemini(opts: GeminiRunOptions): Promise<GeminiRunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const args = buildArgs(opts);
    const [cmd, prefixArgs] = splitCommand(opts.geminiCommand);
    const child = spawn(cmd, [...prefixArgs, ...args], {
      cwd: opts.workDir,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnErrored = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        treeKill(child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs);

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      spawnErrored = true;
      stderr += `\n[spawn error] ${err.message}`;
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const exitCode = spawnErrored
        ? -1
        : timedOut
          ? (code ?? 124)
          : (code ?? 0);
      const parsed =
        exitCode === 0 ? parseGeminiOutput(stdout) : { text: stdout.trim(), sessionId: null };
      resolve({
        text: parsed.text,
        sessionId: exitCode === 0 ? parsed.sessionId : null,
        exitCode,
        durationMs,
        timedOut,
        stderr,
        usage: exitCode === 0 ? parsed.usage : undefined
      });
    });
  });
}
