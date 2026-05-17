import type { Request, RequestHandler, Response } from "express";
import { randomUUID } from "node:crypto";
import { checkAuth, type AuthCarrier } from "../auth.js";
import type { Archive, ArchiveStatus } from "../archive.js";
import type { BackendRegistry } from "../backends/registry.js";
import type { Backend, BackendId } from "../backends/types.js";
import type { FileStore } from "../fileStore.js";
import { identifyBackend } from "../modelRouter.js";
import { recordCompletion } from "../admin/recordCompletion.js";
import {
  internalError,
  invalidArgumentError,
  notFoundError,
  ShimRequestError,
  unauthenticatedError
} from "./errors.js";
import { geminiRequestToNormalized } from "./requestTranslator.js";
import type {
  GeminiCountTokensResponse,
  GeminiGenerateContentRequest
} from "./types.js";

export interface CountTokensHandlerConfig {
  apiKey: string;
  router: { defaultBackend: BackendId };
}

export interface CountTokensHandlerDeps {
  registry: BackendRegistry;
  fileStore: FileStore;
  config: CountTokensHandlerConfig;
  /** Optional — when omitted, archive writes are skipped. */
  archive?: Archive;
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
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }

    const model = req.params["model"];
    if (typeof model !== "string" || model.length === 0) {
      res.status(404).json(notFoundError("missing model in path"));
      return;
    }

    // Google SDK (@google/generative-ai) wraps countTokens requests as
    // `{generateContentRequest: {contents: [...]}}`. The REST API and direct
    // curl users send the bare `{contents: [...]}` shape. Unwrap one level
    // when the wrapper is present and the bare form is absent — keeping the
    // existing translator pathway unchanged.
    const rawBody = req.body as
      | (GeminiGenerateContentRequest & {
          generateContentRequest?: GeminiGenerateContentRequest;
        })
      | undefined;
    const body =
      rawBody &&
      typeof rawBody === "object" &&
      rawBody.contents === undefined &&
      rawBody.generateContentRequest !== undefined
        ? rawBody.generateContentRequest
        : (rawBody as GeminiGenerateContentRequest);
    let normalized;
    try {
      normalized = await geminiRequestToNormalized(body, model, deps.fileStore);
    } catch (e) {
      if (e instanceof ShimRequestError) {
        res.status(e.status).json(invalidArgumentError(e.message));
        return;
      }
      res.status(500).json(internalError(e instanceof Error ? e.message : String(e)));
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

    const startedAt = Date.now();
    const endpoint = `/v1beta/models/${model}:countTokens`;
    const logId = `ct_${randomUUID().replace(/-/g, "")}`;
    let archivedBody: unknown = null;
    let archivedStatus: ArchiveStatus = "ok";

    try {
      const totalTokens = await backend.countTokens(normalized);
      const out: GeminiCountTokensResponse = { totalTokens };
      archivedBody = out;
      res.status(200).json(out);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      archivedStatus = "error";
      archivedBody = { error: { message: msg } };
      res.status(500).json(internalError(msg));
    } finally {
      if (deps.archive) {
        recordCompletion(deps.archive, {
          endpoint,
          backend: backend.id,
          modelResolved: normalized.model,
          logId,
          startedAtMs: startedAt,
          durationMs: Date.now() - startedAt,
          status: archivedStatus,
          requestBody: req.body as unknown,
          responseBody: archivedBody
        });
      }
    }
  };
}
