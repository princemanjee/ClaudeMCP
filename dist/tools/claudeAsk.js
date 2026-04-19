import { randomUUID } from "node:crypto";
import { z } from "zod";
import { containsQuestionHeuristic } from "../logger.js";
import { runClaude } from "../claudeRunner.js";
export function registerClaudeAsk(server, config, logger) {
    server.tool("claude_ask", {
        prompt: z.string().min(1),
        inReplyToLogId: z.string().uuid().optional(),
    }, async ({ prompt, inReplyToLogId }) => {
        const logId = randomUUID();
        const startIso = new Date().toISOString();
        const result = await runClaude({
            prompt,
            allowedTools: config.ask.allowedTools,
            dangerouslySkipPermissions: false,
            timeoutMs: config.ask.timeoutMs,
            claudeCommand: config.claudeCommand,
        });
        const status = result.timedOut
            ? "timeout"
            : result.exitCode === 0
                ? "success"
                : "error";
        const errorField = status === "success" ? undefined : result.stderr || "claude exited non-zero";
        await logger.log({
            timestamp: startIso,
            logId,
            ...(inReplyToLogId ? { inReplyToLogId } : {}),
            tool: "claude_ask",
            status,
            durationMs: result.durationMs,
            prompt,
            output: result.text,
            containsQuestion: containsQuestionHeuristic(result.text),
            exitCode: result.exitCode,
            ...(errorField ? { error: errorField } : {}),
        });
        const responseText = status === "success"
            ? result.text
            : `Error: ${errorField ?? "unknown"}`;
        return {
            content: [{ type: "text", text: responseText }],
            ...(status === "success" ? {} : { isError: true }),
            _meta: {
                logId,
                durationMs: result.durationMs,
            },
        };
    });
}
//# sourceMappingURL=claudeAsk.js.map