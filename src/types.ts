export type SessionMode = "stateless" | "session" | "auto-last";

/**
 * Command used to spawn Claude. Either a single binary name that's resolved
 * via PATH (e.g. "claude"), or an array whose first element is the binary
 * and subsequent elements are prefix args (e.g. ["node", "./mock.mjs"]).
 * The array form is required for tests and for launchers that need an
 * interpreter in front of a script.
 */
export type ClaudeCommand = string | string[];

export type Config = {
  port: number;
  host: string;
  logFile: string;
  sessionStoreFile: string;
  claudeCommand: ClaudeCommand;
  ask: {
    timeoutMs: number;
    allowedTools: string;
  };
  task: {
    defaultSessionMode: SessionMode;
    defaultWorkDir: string;
    timeoutMs: number;
    allowedTools: string;
    dangerouslySkipPermissions: boolean;
    sessionTtlMs: number;
  };
};

export type SessionMeta = {
  sessionId: string;
  workDir: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
};

export type ClaudeRunOptions = {
  prompt: string;
  workDir?: string;
  resumeSessionId?: string;
  allowedTools?: string;
  dangerouslySkipPermissions?: boolean;
  timeoutMs: number;
  claudeCommand: ClaudeCommand;
};

export type ClaudeRunResult = {
  text: string;
  sessionId: string | null;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  stderr: string;
};

export type LogEntry = {
  timestamp: string;
  logId: string;
  inReplyToLogId?: string;
  tool: "claude_ask" | "claude_task";
  status: "success" | "error" | "timeout";
  durationMs: number;
  sessionId?: string;
  prompt: string;
  workDir?: string;
  allowedTools?: string;
  sessionMode?: SessionMode;
  output: string;
  outputTruncated?: boolean;
  containsQuestion: boolean;
  exitCode: number;
  error?: string;
};
