import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { Config, LogEntry } from "../types.js";
import type { Logger } from "../logger.js";
import { containsQuestionHeuristic } from "../logger.js";
import type { SessionStore } from "../sessionStore.js";
import { runClaudeStream } from "../claudeStreamRunner.js";
import {
  buildFreshPrompts,
  buildResumeUserPrompt,
  computeExternalKey,
  extractNewMessagesAfterLastAssistant,
} from "./promptBuilder.js";
import { parseClaudeResponse } from "./responseParser.js";
import {
  translateBuffered,
  translateStream,
} from "./streamTranslator.js";
import type {
  OpenAIChatCompletionRequest,
  OpenAIErrorBody,
  OpenAIMessage,
  StreamJsonEvent,
} from "./types.js";

const MODEL_LABEL = "claude-code-cli";

function sendError(
  res: Response,
  status: number,
  body: OpenAIErrorBody,
): void {
  if (!res.headersSent) {
    res.status(status).json(body);
  }
}

function authOk(req: Request, required: string | null): boolean {
  if (!required) return true;
  return req.headers.authorization === required;
}

export function createOpenAIHandler(
  config: Config,
  logger: Logger,
  store: SessionStore,
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response) => {
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

    const body = req.body as OpenAIChatCompletionRequest | undefined;
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
    let resumeSessionId: string | undefined;
    let openaiMode: LogEntry["openaiMode"] = "fresh";
    if (externalKey !== null) {
      const existing = store.findByExternalKey(externalKey);
      if (existing) {
        resumeSessionId = existing.sessionId;
        openaiMode = "resumed";
      } else {
        openaiMode = "session-miss";
      }
    }

    // Prompt construction
    let systemPrompt: string | undefined;
    let userPrompt: string;
    if (resumeSessionId) {
      const newMsgs = extractNewMessagesAfterLastAssistant(body.messages);
      userPrompt = buildResumeUserPrompt(newMsgs);
    } else {
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
    let capturedSessionId: string | null = null;
    let capturedAllText = "";
    async function* teed(): AsyncGenerator<StreamJsonEvent> {
      for await (const e of events) {
        if (
          e.type === "system" &&
          (e as { subtype?: string }).subtype === "init"
        ) {
          const sid = (e as { session_id?: string }).session_id;
          if (typeof sid === "string") capturedSessionId = sid;
        }
        if (e.type === "assistant") {
          const msg = (e as { message?: { content?: unknown } }).message;
          if (msg && Array.isArray(msg.content)) {
            for (const item of msg.content) {
              if (
                item &&
                typeof item === "object" &&
                (item as { type?: string }).type === "text"
              ) {
                capturedAllText += (item as { text: string }).text;
              }
            }
          }
        }
        yield e;
      }
    }

    let toolCallsEmitted = 0;
    let statusForLog: LogEntry["status"] = "success";

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
      } else {
        const { body: resp, toolCallsEmitted: tce } = await translateBuffered(
          teed(),
          meta,
        );
        toolCallsEmitted = tce;
        res.status(200).json(resp);
      }
    } catch (err) {
      statusForLog = "error";
      const msg = (err as Error).message ?? "unknown error";
      if (!res.headersSent) {
        sendError(res, 502, {
          error: { message: `Claude pipeline failed: ${msg}`, type: "api_error" },
        });
      } else {
        try {
          res.write("data: [DONE]\n\n");
          res.end();
        } catch {
          // ignore
        }
      }
    }

    // Session store updates
    if (capturedSessionId) {
      try {
        if (openaiMode === "resumed" && resumeSessionId) {
          await store.update(resumeSessionId);
        } else {
          if (externalKey !== null) {
            await store.createWithExternalKey(
              capturedSessionId,
              workDir,
              externalKey,
            );
          } else {
            await store.create(capturedSessionId, workDir);
          }
        }
        // Compute the external key for OUR reply so the NEXT call can find
        // this session. Shape the reply as an OpenAI assistant message first.
        if (capturedAllText.length > 0) {
          const parsed = parseClaudeResponse(capturedAllText);
          const replyMessage: OpenAIMessage =
            parsed.kind === "tool_calls"
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
      } catch (err) {
        console.warn("[openaiShim] session persist failed:", (err as Error).message);
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
  };
}
