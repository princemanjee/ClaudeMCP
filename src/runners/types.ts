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

export interface ClaudeStreamOptions extends Omit<ClaudeRunOptions, never> {
  /** Optional system prompt passed via `--system`. */
  systemPrompt?: string;
}

// ---- Gemini CLI runner types ---------------------------------------------

export interface GeminiRunOptions {
  /** Prompt body passed to gemini via `--prompt` (assumption — verify against the CLI). */
  prompt: string;
  /** Working directory for the CLI process. Defaults to Node's CWD if omitted. */
  workDir?: string;
  /** Optional Gemini model id (e.g. "gemini-pro", "gemini-flash"). Passed via `--model`. */
  model?: string;
  /** Resume an existing Gemini conversation by id (if the CLI supports it; see open question). */
  resumeSessionId?: string;
  /** Sampling controls passed through to the CLI when set. */
  temperature?: number;
  topP?: number;
  topK?: number;
  /** Native stop sequences (Gemini supports these per the capability matrix). */
  stopSequences?: string[];
  /** Kill the process tree after this many ms. */
  timeoutMs: number;
  /**
   * Either a single executable name/path or an array where the head is the
   * executable and the tail is a fixed prefix of arguments (useful for `wsl gemini`).
   */
  geminiCommand: string | string[];
}

export interface GeminiRunResult {
  /** Extracted text response from the CLI output. */
  text: string;
  /** Session id parsed from JSON output, or null on error / unparseable / absent. */
  sessionId: string | null;
  /** Process exit code. -1 for spawn failure, 124 (or process code) for timeout. */
  exitCode: number;
  /** Wall-clock milliseconds from spawn to close. */
  durationMs: number;
  /** True if the run hit the configured timeout. */
  timedOut: boolean;
  /** Concatenated stderr output, including any "[spawn error]" annotations. */
  stderr: string;
  /** Token usage parsed from `usageMetadata` in the JSON output, if present. */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface GeminiStreamOptions extends Omit<GeminiRunOptions, never> {
  /** Optional system instruction passed via `--system` (assumption — verify against the CLI). */
  systemPrompt?: string;
}
