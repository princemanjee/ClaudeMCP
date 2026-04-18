import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config, SessionMode } from "../types.js";
import type { Logger } from "../logger.js";
import { containsQuestionHeuristic } from "../logger.js";
import type { SessionStore } from "../sessionStore.js";
import { runClaude } from "../claudeRunner.js";

type TaskInput = {
  prompt: string;
  workDir?: string;
  sessionMode?: SessionMode;
  sessionId?: string;
  allowedTools?: string;
  inReplyToLogId?: string;
};

export function registerClaudeTask(
  server: McpServer,
  config: Config,
  logger: Logger,
  store: SessionStore,
): void {
  server.tool(
    "claude_task",
    {
      prompt: z.string().min(1),
      workDir: z.string().optional(),
      sessionMode: z.enum(["stateless", "session", "auto-last"]).optional(),
      sessionId: z.string().optional(),
      allowedTools: z.string().optional(),
      inReplyToLogId: z.string().uuid().optional(),
    },
    async (input: TaskInput) => {
      const logId = randomUUID();
      const startIso = new Date().toISOString();
      const sessionMode: SessionMode =
        input.sessionMode ?? config.task.defaultSessionMode;
      const workDir = input.workDir ?? config.task.defaultWorkDir;

      // Warn on mis-matched sessionId usage (kept in the returned text on error? no,
      // just log it; callers shouldn't be punished for a harmless override)
      const warnings: string[] = [];
      if (
        input.sessionId &&
        (sessionMode === "stateless" || sessionMode === "auto-last")
      ) {
        warnings.push(
          `sessionId ignored because sessionMode is "${sessionMode}"`,
        );
      }

      // Resolve the effective resume ID based on mode
      let resumeSessionId: string | undefined;
      if (sessionMode === "session" && input.sessionId) {
        resumeSessionId = input.sessionId;
        if (!store.get(input.sessionId)) {
          warnings.push(
            `sessionId ${input.sessionId} not in local store; passing to claude anyway`,
          );
        }
      } else if (sessionMode === "auto-last") {
        const latest = store.getMostRecent();
        if (latest) resumeSessionId = latest.sessionId;
      }
      const mode: "stateless" | "fresh" | "resumed" =
        sessionMode === "stateless"
          ? "stateless"
          : resumeSessionId
            ? "resumed"
            : "fresh";

      // Permission flag precedence
      const skipPerms = config.task.dangerouslySkipPermissions;
      const requestedAllowed = input.allowedTools ?? config.task.allowedTools;
      if (skipPerms && input.allowedTools && input.allowedTools.length > 0) {
        warnings.push(
          "allowedTools ignored because dangerouslySkipPermissions is true",
        );
      }

      const lockKey = resumeSessionId ?? `__fresh_${logId}`;
      const result = await store.withLock(lockKey, () =>
        runClaude({
          prompt: input.prompt,
          workDir,
          resumeSessionId,
          allowedTools: skipPerms ? undefined : requestedAllowed,
          dangerouslySkipPermissions: skipPerms,
          timeoutMs: config.task.timeoutMs,
          claudeCommand: config.claudeCommand,
        }),
      );

      // Determine the sessionId to report out and persist
      let reportedSessionId: string | null = null;
      if (sessionMode !== "stateless") {
        if (resumeSessionId) {
          reportedSessionId = resumeSessionId;
          if (result.exitCode === 0) await store.update(resumeSessionId);
        } else if (result.sessionId && result.exitCode === 0) {
          reportedSessionId = result.sessionId;
          await store.create(result.sessionId, workDir);
        }
      }

      const status = result.timedOut
        ? "timeout"
        : result.exitCode === 0
          ? "success"
          : "error";
      const errorField =
        status === "success"
          ? undefined
          : [result.stderr, ...warnings].filter(Boolean).join("\n").trim() ||
            "claude exited non-zero";

      await logger.log({
        timestamp: startIso,
        logId,
        ...(input.inReplyToLogId ? { inReplyToLogId: input.inReplyToLogId } : {}),
        tool: "claude_task",
        status,
        durationMs: result.durationMs,
        ...(reportedSessionId ? { sessionId: reportedSessionId } : {}),
        prompt: input.prompt,
        workDir,
        allowedTools: skipPerms ? undefined : requestedAllowed,
        sessionMode,
        output: result.text,
        containsQuestion: containsQuestionHeuristic(result.text),
        exitCode: result.exitCode,
        ...(errorField ? { error: errorField } : {}),
      });

      const responseText =
        status === "success"
          ? result.text
          : `Error: ${errorField ?? "unknown"}`;

      return {
        content: [{ type: "text" as const, text: responseText }],
        ...(status === "success" ? {} : { isError: true }),
        _meta: {
          sessionId: reportedSessionId,
          mode,
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          logId,
        },
      };
    },
  );
}
