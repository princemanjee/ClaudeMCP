import type { Request, RequestHandler, Response } from "express";
import { checkAuth, type AuthCarrier } from "../auth.js";
import type { BackendRegistry } from "../backends/registry.js";
import type { Backend, BackendId } from "../backends/types.js";
import type { FileStore } from "../fileStore.js";
import { identifyBackend } from "../modelRouter.js";
import {
  internalError,
  invalidArgumentError,
  notFoundError,
  ShimRequestError,
  unauthenticatedError
} from "./errors.js";
import { geminiRequestToNormalized } from "./requestTranslator.js";
import {
  normalizedEventsToGeminiFinalResponse,
  normalizedEventsToGeminiSSE
} from "./responseTranslator.js";
import type { GeminiGenerateContentRequest } from "./types.js";

export interface GenerateContentHandlerConfig {
  apiKey: string;
  router: { defaultBackend: BackendId };
}

export interface GenerateContentHandlerDeps {
  registry: BackendRegistry;
  fileStore: FileStore;
  config: GenerateContentHandlerConfig;
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
  const found = registry.resolveModel(ident.remainingModel);
  if (found) return { backend: found, resolvedModel: ident.remainingModel };
  return { error: "not_found" };
}

interface MakeOptions {
  streaming: boolean;
}

function makeHandler(
  deps: GenerateContentHandlerDeps,
  opts: MakeOptions
): RequestHandler {
  return async (req: Request, res: Response) => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }

    // Route mounter strips `models/` prefix and parses `:method` so `req.params.model`
    // arrives as a bare model id by the time the handler runs.
    const model = req.params["model"];
    if (typeof model !== "string" || model.length === 0) {
      res.status(404).json(notFoundError("missing model in path"));
      return;
    }

    const body = req.body as GeminiGenerateContentRequest;
    let normalized;
    try {
      normalized = await geminiRequestToNormalized(body, model, deps.fileStore);
    } catch (e) {
      if (e instanceof ShimRequestError) {
        res.status(e.status).json(invalidArgumentError(e.message));
        return;
      }
      res
        .status(500)
        .json(internalError(e instanceof Error ? e.message : String(e)));
      return;
    }

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

    const meta = { model: normalized.model };

    try {
      const events = backend.invoke(normalized);

      if (opts.streaming) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        for await (const chunk of normalizedEventsToGeminiSSE(events, meta)) {
          res.write(chunk);
        }
        res.end();
      } else {
        const finalBody = await normalizedEventsToGeminiFinalResponse(events, meta);
        res.status(200).json(finalBody);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (res.headersSent) {
        res.end();
      } else {
        res.status(500).json(internalError(`backend error: ${msg}`));
      }
    }
  };
}

export interface GenerateContentHandlers {
  generate: RequestHandler;
  streamGenerate: RequestHandler;
}

export function createGenerateContentHandlers(
  deps: GenerateContentHandlerDeps
): GenerateContentHandlers {
  return {
    generate: makeHandler(deps, { streaming: false }),
    streamGenerate: makeHandler(deps, { streaming: true })
  };
}
