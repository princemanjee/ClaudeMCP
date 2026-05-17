export interface ClaudeRunOptions {
  /** Prompt body passed to claude via `-p`. */
  prompt: string;
  /** Working directory for the CLI process. Defaults to Node's CWD if omitted. */
  workDir?: string;
  /** Resume an existing Claude session by id (passed via `--resume`). */
  resumeSessionId?: string;
  /** Comma-separated allowed tools list (passed via `--allowed-tools`). */
  allowedTools?: string;
  /** When true, pass `--dangerously-skip-permissions` and omit `--allowed-tools`. */
  dangerouslySkipPermissions?: boolean;
  /** Kill the process tree after this many ms. */
  timeoutMs: number;
  /**
   * Either a single executable name/path or an array where the head is the
   * executable and the tail is a fixed prefix of arguments (useful for `wsl claude`).
   */
  claudeCommand: string | string[];
}

export interface ClaudeRunResult {
  /** Extracted text response from the CLI output. */
  text: string;
  /** Session id parsed from JSON output, or null on error / unparseable. */
  sessionId: string | null;
  /** Process exit code. -1 for spawn failure, 124 (or process code) for timeout. */
  exitCode: number;
  /** Wall-clock milliseconds from spawn to close. */
  durationMs: number;
  /** True if the run hit the configured timeout. */
  timedOut: boolean;
  /** Concatenated stderr output, including any "[spawn error]" annotations. */
  stderr: string;
}

import type { NormalizedToolDef } from "../backends/types.js";

export interface ClaudeStreamOptions extends Omit<ClaudeRunOptions, never> {
  /** Optional system prompt passed via `--system`. */
  systemPrompt?: string;
  /**
   * Tool definitions to expose to the CLI. When non-empty, serialized as JSON
   * and passed via `--tools <json>`. The CLI's expected flag and format is
   * documented as an OPEN QUESTION in the Plan 04 spec — the value may need
   * to be a file path, stdin, or a different flag name when verified against
   * the real CLI surface.
   */
  tools?: NormalizedToolDef[];
  /**
   * Stop sequences. Passed verbatim to the CLI via `--stop-sequences <json>`
   * AND used by the stream runner's local cutter for the server-side-cut
   * capability (see Task 4). Both layers are belt-and-braces: if the CLI
   * honors the flag natively, the cutter is a no-op; if it doesn't, the
   * cutter terminates the child on the first match.
   */
  stopSequences?: string[];
}
