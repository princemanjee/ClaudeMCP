import type { Request, RequestHandler, Response } from "express";
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
import type {
  AnthropicCountTokensResponse,
  AnthropicMessagesRequest
} from "./types.js";

export interface CountTokensHandlerConfig {
  apiKey: string;
  router: { defaultBackend: BackendId };
}

export interface CountTokensHandlerDeps {
  registry: BackendRegistry;
  config: CountTokensHandlerConfig;
}

function resolveBackend(
  registry: BackendRegistry,
  defaultBackend: BackendId,
  requestedModel: string
): Backend | undefined {
  const ident = identifyBackend(requestedModel, defaultBackend);
  if (ident.backend !== null) return registry.get(ident.backend);
  return registry.resolveModel(ident.remainingModel);
}

export function createCountTokensHandler(
  deps: CountTokensHandlerDeps
): RequestHandler {
  return async (req: Request, res: Response) => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(authenticationError("invalid or missing API key"));
      return;
    }

    const body = req.body as AnthropicMessagesRequest;
    let normalized;
    try {
      normalized = anthropicRequestToNormalized(body);
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

    const backend = resolveBackend(
      deps.registry,
      deps.config.router.defaultBackend,
      normalized.model
    );
    if (!backend) {
      res
        .status(404)
        .json(notFoundError(`model ${normalized.model} not found in any enabled backend`));
      return;
    }

    try {
      const inputTokens = await backend.countTokens(normalized);
      const out: AnthropicCountTokensResponse = { input_tokens: inputTokens };
      res.status(200).json(out);
    } catch (e) {
      res
        .status(500)
        .json(internalServerError(e instanceof Error ? e.message : String(e)));
    }
  };
}
