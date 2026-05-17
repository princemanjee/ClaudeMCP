import type { Request, RequestHandler, Response } from "express";
import { randomUUID } from "node:crypto";
import { checkAuth, type AuthCarrier } from "../auth.js";
import type { BackendRegistry } from "../backends/registry.js";
import type { Backend, BackendId } from "../backends/types.js";
import { identifyBackend } from "../modelRouter.js";
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

    if (wantStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      try {
        for await (const chunk of normalizedEventsToOpenAISSE(
          backend.invoke(reqForBackend),
          meta
        )) {
          res.write(chunk);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      } catch {
        // Headers are already flushed; gracefully terminate.
        try {
          res.write("data: [DONE]\n\n");
          res.end();
        } catch {
          // ignore
        }
      }
      return;
    }

    try {
      const { body } = await normalizedEventsToOpenAIFinalResponse(
        backend.invoke(reqForBackend),
        meta
      );
      res.status(200).json(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res
        .status(502)
        .json(internalServerError(`Claude pipeline failed: ${msg}`));
    }
  };
}
