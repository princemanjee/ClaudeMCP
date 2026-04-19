import { randomUUID } from "node:crypto";
import { containsQuestionHeuristic } from "../logger.js";
import { runClaudeStream } from "../claudeStreamRunner.js";
import { buildFreshPrompts, buildResumeUserPrompt, computeExternalKey, extractNewMessagesAfterLastAssistant, } from "./promptBuilder.js";
import { parseClaudeResponse } from "./responseParser.js";
import { translateBuffered, translateStream, } from "./streamTranslator.js";
const MODEL_LABEL = "claude-code-cli";
function sendError(res, status, body) {
    if (!res.headersSent) {
        res.status(status).json(body);
    }
}
function authOk(req, required) {
    if (!required)
        return true;
    return req.headers.authorization === required;
}
export function createOpenAIHandler(config, logger, store) {
    return async (req, res) => {
        const logId = randomUUID();
        const startIso = new Date().toISOString();
        const startMs = Date.now();
        if (!authOk(req, config.openai.requireAuthHeader)) {
            sendError(res, 401, {
                error: {
                    message: "Invalid or missing Authorization header.",
                    type: "authentication_error",
                    code: "invalid_api_key",
                },
            });
            return;
        }
        const body = req.body;
        if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
            sendError(res, 400, {
                error: {
                    message: "Request must include a non-empty 'messages' array.",
                    type: "invalid_request_error",
                },
            });
            return;
        }
        const tools = body.tools ?? [];
        const wantStream = body.stream === true;
        // Session resolution
        const externalKey = computeExternalKey(body.messages);
        let resumeSessionId;
        let openaiMode = "fresh";
        if (externalKey !== null) {
            const existing = store.findByExternalKey(externalKey);
            if (existing) {
                resumeSessionId = existing.sessionId;
                openaiMode = "resumed";
            }
            else {
                openaiMode = "session-miss";
            }
        }
        // Prompt construction
        let systemPrompt;
        let userPrompt;
        if (resumeSessionId) {
            const newMsgs = extractNewMessagesAfterLastAssistant(body.messages);
            userPrompt = buildResumeUserPrompt(newMsgs);
        }
        else {
            const built = buildFreshPrompts(body.messages, tools);
            systemPrompt = built.systemPrompt;
            userPrompt = built.userPrompt;
        }
        const workDir = resumeSessionId
            ? store.get(resumeSessionId)?.workDir ?? config.task.defaultWorkDir
            : config.task.defaultWorkDir;
        const meta = {
            id: `chatcmpl-${logId}`,
            model: body.model ?? MODEL_LABEL,
            created: Math.floor(Date.now() / 1000),
        };
        const streamOpts = {
            prompt: userPrompt,
            systemPrompt,
            workDir,
            resumeSessionId,
            allowedTools: "",
            dangerouslySkipPermissions: false,
            timeoutMs: config.openai.timeoutMs,
            claudeCommand: config.claudeCommand,
        };
        // Tee the event stream: capture session_id and raw text as events flow through
        const events = runClaudeStream(streamOpts);
        let capturedSessionId = null;
        let capturedAllText = "";
        async function* teed() {
            for await (const e of events) {
                if (e.type === "system" &&
                    e.subtype === "init") {
                    const sid = e.session_id;
                    if (typeof sid === "string")
                        capturedSessionId = sid;
                }
                if (e.type === "assistant") {
                    const msg = e.message;
                    if (msg && Array.isArray(msg.content)) {
                        for (const item of msg.content) {
                            if (item &&
                                typeof item === "object" &&
                                item.type === "text") {
                                capturedAllText += item.text;
                            }
                        }
                    }
                }
                yield e;
            }
        }
        let toolCallsEmitted = 0;
        let statusForLog = "success";
        // For non-streaming: buffer the response body and send after side-effects
        // so that the client only receives the response once logging is complete.
        // This ensures integration-test log reads always see all entries.
        let bufferedResp = null;
        try {
            if (wantStream) {
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                res.flushHeaders?.();
                const chunks = translateStream(teed(), meta);
                for await (const c of chunks) {
                    res.write(`data: ${JSON.stringify(c)}\n\n`);
                    const deltaCalls = c.choices[0]?.delta.tool_calls;
                    if (deltaCalls && deltaCalls.length > 0) {
                        toolCallsEmitted += deltaCalls.length;
                    }
                }
                res.write("data: [DONE]\n\n");
                res.end();
            }
            else {
                const { body: resp, toolCallsEmitted: tce } = await translateBuffered(teed(), meta);
                toolCallsEmitted = tce;
                bufferedResp = resp;
            }
        }
        catch (err) {
            statusForLog = "error";
            const msg = err.message ?? "unknown error";
            if (!res.headersSent) {
                sendError(res, 502, {
                    error: { message: `Claude pipeline failed: ${msg}`, type: "api_error" },
                });
            }
            else {
                try {
                    res.write("data: [DONE]\n\n");
                    res.end();
                }
                catch {
                    // ignore
                }
            }
        }
        // Session store updates
        if (capturedSessionId) {
            try {
                if (openaiMode === "resumed" && resumeSessionId) {
                    await store.update(resumeSessionId);
                }
                else {
                    if (externalKey !== null) {
                        await store.createWithExternalKey(capturedSessionId, workDir, externalKey);
                    }
                    else {
                        await store.create(capturedSessionId, workDir);
                    }
                }
                // Compute the external key for OUR reply so the NEXT call can find
                // this session. Shape the reply as an OpenAI assistant message first.
                if (capturedAllText.length > 0) {
                    const parsed = parseClaudeResponse(capturedAllText);
                    const replyMessage = parsed.kind === "tool_calls"
                        ? {
                            role: "assistant",
                            tool_calls: parsed.calls.map((c) => ({
                                id: c.id,
                                type: "function",
                                function: { name: c.name, arguments: c.argumentsJson },
                            })),
                        }
                        : { role: "assistant", content: parsed.text };
                    const replyKey = computeExternalKey([replyMessage]);
                    if (replyKey) {
                        await store.setExternalKey(capturedSessionId, replyKey);
                    }
                }
            }
            catch (err) {
                console.warn("[openaiShim] session persist failed:", err.message);
            }
        }
        const durationMs = Date.now() - startMs;
        await logger.log({
            timestamp: startIso,
            logId,
            tool: "openai_completion",
            status: statusForLog,
            durationMs,
            sessionId: capturedSessionId ?? undefined,
            prompt: userPrompt,
            output: capturedAllText,
            containsQuestion: containsQuestionHeuristic(capturedAllText),
            exitCode: statusForLog === "success" ? 0 : 1,
            openaiMode,
            toolCallsEmitted,
            externalKey: externalKey ?? undefined,
        });
        // Send the buffered non-streaming response AFTER all side-effects complete.
        if (bufferedResp !== null && !res.headersSent) {
            res.status(200).json(bufferedResp);
        }
    };
}
//# sourceMappingURL=handler.js.map