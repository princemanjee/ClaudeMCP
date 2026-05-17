import type { Request, RequestHandler, Response } from "express";
import { randomUUID } from "node:crypto";
import { checkAuth, type AuthCarrier } from "../auth.js";
import type { Archive, ArchiveStatus } from "../archive.js";
import type { BackendRegistry } from "../backends/registry.js";
import type { Backend, BackendId, NormalizedEvent } from "../backends/types.js";
import { identifyBackend } from "../modelRouter.js";
import { recordCompletion } from "../admin/recordCompletion.js";
import {
  authenticationError,
  internalServerError,
  invalidRequestError,
  notFoundError,
  ShimRequestError
} from "./errors.js";
import { openaiRequestToNormalized } from "./requestTranslator.js";
import {
  normalizedEventsToOpenAIFinalResponse,
  normalizedEventsToOpenAISSE
} from "./responseTranslator.js";
import type { OpenAIChunkMeta } from "./types.js";

export interface ChatCompletionsConfig {
  apiKey: string;
  router: { defaultBackend: BackendId };
}

export interface ChatCompletionsDeps {
  registry: BackendRegistry;
  config: ChatCompletionsConfig;
  /**
   * Optional — when omitted, the handler still works but skips archive
   * writes. `buildApp` always provides one in production.
   */
  archive?: Archive;
}

function resolveBackend(
  registry: BackendRegistry,
  defaultBackend: BackendId,
  requestedModel: string
): { backend: Backend; resolvedModel: string } | { error: "not_found" } {
  const ident = identifyBackend(requestedModel, defaultBackend);
  if (ident.backend !== null) {
    const backend = registry.get(ident.backend);
    if (backend) {
      return { backend, resolvedModel: ident.remainingModel || requestedModel };
    }
    // Identified by alias/prefix but the backend isn't registered — fall
    // through to the registry's discovered-model map.
  }
  const found = registry.resolveModel(ident.remainingModel);
  if (found) return { backend: found, resolvedModel: ident.remainingModel };
  return { error: "not_found" };
}

function newMessageId(): string {
  return `chatcmpl-${randomUUID().replace(/-/g, "")}`;
}

export function createChatCompletionsHandler(
  deps: ChatCompletionsDeps
): RequestHandler {
  return async (req: Request, res: Response) => {
    // ---- Auth ----------------------------------------------------------
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(authenticationError("Invalid or missing API key."));
      return;
    }

    // ---- Translate -----------------------------------------------------
    let normalized;
    try {
      normalized = openaiRequestToNormalized(req.body);
    } catch (err) {
      if (err instanceof ShimRequestError) {
        const opts: { param?: string; code?: string } = {};
        if (err.param !== undefined) opts.param = err.param;
        if (err.code !== undefined) opts.code = err.code;
        res.status(err.status).json(invalidRequestError(err.message, opts));
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json(invalidRequestError(msg));
      return;
    }

    // ---- Route ---------------------------------------------------------
    const resolved = resolveBackend(
      deps.registry,
      deps.config.router.defaultBackend,
      normalized.model
    );
    if ("error" in resolved) {
      res
        .status(404)
        .json(notFoundError(`The model \`${normalized.model}\` does not exist.`));
      return;
    }
    const { backend, resolvedModel } = resolved;

    // Use the prefix-stripped model id when invoking the backend.
    const reqForBackend = { ...normalized, model: resolvedModel };

    const messageId = newMessageId();
    const created = Math.floor(Date.now() / 1000);
    const meta: OpenAIChunkMeta = {
      id: messageId,
      model: resolvedModel,
      created
    };

    const wantStream = Boolean(
      (req.body as { stream?: unknown } | undefined)?.stream
    );

    const startedAt = Date.now();
    let archivedBody: unknown = null;
    let archivedStatus: ArchiveStatus = "ok";

    const finalize = (): void => {
      if (!deps.archive) return;
      recordCompletion(deps.archive, {
        endpoint: "/v1/chat/completions",
        backend: backend.id,
        modelResolved: resolvedModel,
        logId: messageId,
        startedAtMs: startedAt,
        durationMs: Date.now() - startedAt,
        status: archivedStatus,
        requestBody: req.body as unknown,
        responseBody: archivedBody
      });
    };

    if (wantStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      try {
        // Tee events through both the SSE encoder and a buffer that the
        // archive helper can serialize into a final response shape.
        const collected: NormalizedEvent[] = [];
        const teed: AsyncIterable<NormalizedEvent> = (async function* () {
          for await (const ev of backend.invoke(reqForBackend)) {
            collected.push(ev);
            yield ev;
          }
        })();
        for await (const chunk of normalizedEventsToOpenAISSE(teed, meta)) {
          res.write(chunk);
        }
        res.write("data: [DONE]\n\n");
        res.end();
        try {
          const { body } = await normalizedEventsToOpenAIFinalResponse(
            (async function* () {
              for (const ev of collected) yield ev;
            })(),
            meta
          );
          archivedBody = body;
        } catch (err) {
          archivedStatus = "error";
          archivedBody = {
            error: { message: err instanceof Error ? err.message : String(err) }
          };
        }
      } catch (err) {
        archivedStatus = "error";
        archivedBody = {
          error: { message: err instanceof Error ? err.message : String(err) }
        };
        // Headers are already flushed; gracefully terminate.
        try {
          res.write("data: [DONE]\n\n");
          res.end();
        } catch {
          // ignore
        }
      } finally {
        finalize();
      }
      return;
    }

    try {
      const { body } = await normalizedEventsToOpenAIFinalResponse(
        backend.invoke(reqForBackend),
        meta
      );
      archivedBody = body;
      res.status(200).json(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      archivedStatus = "error";
      archivedBody = { error: { message: msg } };
      res
        .status(502)
        .json(internalServerError(`Claude pipeline failed: ${msg}`));
    } finally {
      finalize();
    }
  };
}
