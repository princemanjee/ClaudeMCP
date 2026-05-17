import type { Request, RequestHandler, Response } from "express";
import { randomUUID } from "node:crypto";
import { checkAuth, type AuthCarrier } from "../auth.js";
import type { Archive, ArchiveStatus } from "../archive.js";
import type { BackendRegistry } from "../backends/registry.js";
import type { Backend, BackendId } from "../backends/types.js";
import { identifyBackend } from "../modelRouter.js";
import { recordCompletion } from "../admin/recordCompletion.js";
import { estimateTokens } from "../tokenEstimator.js";
import {
  authenticationError,
  internalServerError,
  invalidRequestError,
  notFoundError
} from "./errors.js";
import type {
  OpenAIEmbeddingsItem,
  OpenAIEmbeddingsResponse
} from "./types.js";

export interface EmbeddingsConfig {
  apiKey: string;
  router: { defaultBackend: BackendId };
  embeddings: {
    legacyBackendUrl: string;
    legacyApiKey: string;
    legacyTimeoutMs: number;
  };
}

export interface EmbeddingsDeps {
  registry: BackendRegistry;
  config: EmbeddingsConfig;
  /** Optional — when omitted, archive writes are skipped. */
  archive?: Archive;
}

function encodeFloat32Base64(values: number[]): string {
  const arr = new Float32Array(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString(
    "base64"
  );
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
  }
  const found = registry.resolveModel(ident.remainingModel);
  if (found) return { backend: found, resolvedModel: ident.remainingModel };
  return { error: "not_found" };
}

async function legacyProxy(
  deps: EmbeddingsDeps,
  req: Request,
  res: Response
): Promise<void> {
  const url = `${deps.config.embeddings.legacyBackendUrl.replace(/\/+$/, "")}/v1/embeddings`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (deps.config.embeddings.legacyApiKey) {
    headers["Authorization"] = `Bearer ${deps.config.embeddings.legacyApiKey}`;
  }
  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(deps.config.embeddings.legacyTimeoutMs)
    });
    const text = await upstream.text();
    res.status(upstream.status);
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);
    res.send(text);
  } catch (err) {
    const e = err as Error;
    if (e.name === "AbortError" || e.name === "TimeoutError") {
      res.status(504).json(internalServerError("legacy embeddings proxy timeout"));
    } else {
      res
        .status(502)
        .json(internalServerError(`legacy embeddings proxy failed: ${e.message}`));
    }
  }
}

export function createEmbeddingsHandler(deps: EmbeddingsDeps): RequestHandler {
  return async (req: Request, res: Response) => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(authenticationError("Invalid or missing API key."));
      return;
    }

    // Legacy bypass wins over registry routing per spec Migration notes.
    const legacyUrl = deps.config.embeddings.legacyBackendUrl;
    if (typeof legacyUrl === "string" && legacyUrl.length > 0) {
      await legacyProxy(deps, req, res);
      return;
    }

    const body = req.body as
      | { model?: unknown; input?: unknown; encoding_format?: unknown }
      | undefined;
    if (!body || typeof body !== "object") {
      res.status(400).json(invalidRequestError("request body must be an object"));
      return;
    }
    if (typeof body.model !== "string" || body.model.length === 0) {
      res
        .status(400)
        .json(
          invalidRequestError("model must be a non-empty string", { param: "model" })
        );
      return;
    }
    const model = body.model;

    let input: string[];
    if (typeof body.input === "string") {
      input = [body.input];
    } else if (Array.isArray(body.input)) {
      if (body.input.some((s) => typeof s !== "string")) {
        res
          .status(400)
          .json(
            invalidRequestError("input must be string or string[]", {
              param: "input"
            })
          );
        return;
      }
      input = body.input as string[];
    } else {
      res
        .status(400)
        .json(invalidRequestError("input is required", { param: "input" }));
      return;
    }
    const encodingFormat = body.encoding_format === "base64" ? "base64" : "float";

    const resolved = resolveBackend(
      deps.registry,
      deps.config.router.defaultBackend,
      model
    );
    if ("error" in resolved) {
      res
        .status(404)
        .json(notFoundError(`The model \`${model}\` does not exist.`));
      return;
    }
    const { backend, resolvedModel } = resolved;
    if (typeof backend.embed !== "function") {
      res
        .status(400)
        .json(
          invalidRequestError("model does not support embeddings", {
            param: "model"
          })
        );
      return;
    }

    const startedAt = Date.now();
    let archivedBody: unknown = null;
    let archivedStatus: ArchiveStatus = "ok";
    const logId = `embd_${randomUUID().replace(/-/g, "")}`;

    try {
      const result = await backend.embed({ model: resolvedModel, input });
      const data: OpenAIEmbeddingsItem[] = result.embeddings.map((emb, index) => ({
        object: "embedding",
        embedding: encodingFormat === "base64" ? encodeFloat32Base64(emb) : emb,
        index
      }));
      // Real OpenAI service always populates `usage` on embeddings; some SDK
      // versions tighten this from optional to required. Approximate via the
      // existing char/4 token estimator. Embeddings have no completion tokens
      // so `total_tokens` == `prompt_tokens`.
      const promptTokens = input.reduce(
        (sum, s) => sum + estimateTokens(s),
        0
      );
      const respBody: OpenAIEmbeddingsResponse = {
        object: "list",
        data,
        model: result.model,
        usage: { prompt_tokens: promptTokens, total_tokens: promptTokens }
      };
      archivedBody = respBody;
      res.status(200).json(respBody);
    } catch (err) {
      const e = err as Error;
      archivedStatus = "error";
      archivedBody = { error: { message: e.message } };
      if (e.name === "AbortError" || e.name === "TimeoutError") {
        res.status(504).json(internalServerError("backend timeout"));
      } else {
        res
          .status(502)
          .json(internalServerError(`embeddings backend failed: ${e.message}`));
      }
    } finally {
      if (deps.archive) {
        recordCompletion(deps.archive, {
          endpoint: "/v1/embeddings",
          backend: backend.id,
          modelResolved: resolvedModel,
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
