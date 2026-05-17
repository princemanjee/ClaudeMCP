import type { Request, RequestHandler, Response } from "express";
import { randomBytes } from "node:crypto";
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
import { anthropicRequestToNormalized } from "./requestTranslator.js";
import {
  normalizedEventsToFinalResponse,
  normalizedEventsToSSE
} from "./responseTranslator.js";
import type { AnthropicMessagesRequest } from "./types.js";

export interface MessagesHandlerConfig {
  apiKey: string;
  router: { defaultBackend: BackendId };
}

export interface MessagesHandlerDeps {
  registry: BackendRegistry;
  config: MessagesHandlerConfig;
}

function newMessageId(): string {
  return `msg_${randomBytes(12).toString("hex")}`;
}

function resolveBackend(
  registry: BackendRegistry,
  defaultBackend: BackendId,
  requestedModel: string
): { backend: Backend; resolvedModel: string } | { error: "not_found" } {
  const ident = identifyBackend(requestedModel, defaultBackend);
  if (ident.backend !== null) {
    const backend = registry.get(ident.backend);
    if (!backend) return { error: "not_found" };
    return { backend, resolvedModel: ident.remainingModel || requestedModel };
  }
  // Bare local model name — consult the registry's discovered model map.
  const found = registry.resolveModel(ident.remainingModel);
  if (found) return { backend: found, resolvedModel: ident.remainingModel };
  return { error: "not_found" };
}

export function createMessagesHandler(deps: MessagesHandlerDeps): RequestHandler {
  return async (req: Request, res: Response) => {
    // ---- Auth -----------------------------------------------------------
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(authenticationError("invalid or missing API key"));
      return;
    }

    // ---- Translate ------------------------------------------------------
    const body = req.body as AnthropicMessagesRequest;
    let normalized;
    try {
      normalized = await anthropicRequestToNormalized(body);
    } catch (e) {
      if (e instanceof ShimRequestError) {
        res.status(e.status).json(invalidRequestError(e.message));
        return;
      }
      res
        .status(500)
        .json(internalServerError(e instanceof Error ? e.message : String(e)));
      return;
    }

    // ---- Route ----------------------------------------------------------
    const resolved = resolveBackend(
      deps.registry,
      deps.config.router.defaultBackend,
      normalized.model
    );
    if ("error" in resolved) {
      res
        .status(404)
        .json(notFoundError(`model ${normalized.model} not found in any enabled backend`));
      return;
    }
    const { backend } = resolved;

    // ---- Invoke ---------------------------------------------------------
    const messageId = newMessageId();
    const meta = { messageId, model: normalized.model };
    const wantStream = body.stream === true;

    try {
      const events = backend.invoke(normalized);

      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        for await (const chunk of normalizedEventsToSSE(events, meta)) {
          res.write(chunk);
        }
        res.end();
      } else {
        const finalBody = await normalizedEventsToFinalResponse(events, meta);
        res.status(200).json(finalBody);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (res.headersSent) {
        // Streaming already started; we can't change the status code. The
        // only thing we can do is end the stream — Plan 11 will document
        // this corner in the admin/error logs.
        res.end();
      } else {
        res.status(500).json(internalServerError(`backend error: ${msg}`));
      }
    }
  };
}
