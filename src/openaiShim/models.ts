import type { Request, RequestHandler, Response } from "express";
import { checkAuth, type AuthCarrier } from "../auth.js";
import type { BackendRegistry } from "../backends/registry.js";
import {
  authenticationError,
  internalServerError,
  notFoundError
} from "./errors.js";
import type {
  OpenAIModelEntry,
  OpenAIModelsListResponse
} from "./types.js";

export interface ModelsConfig {
  apiKey: string;
}

export interface ModelsDeps {
  registry: BackendRegistry;
  config: ModelsConfig;
}

// Curated fallback for entries that lack a known release date. Matches the
// Anthropic shim's PLACEHOLDER_CREATED_AT convention; the date is the start of
// the OpenAI shim's general availability window.
const DEFAULT_CREATED_EPOCH = 1735689600; // 2025-01-01T00:00:00Z

async function collectAllModels(
  registry: BackendRegistry
): Promise<OpenAIModelEntry[]> {
  const seen = new Set<string>();
  const out: OpenAIModelEntry[] = [];
  for (const backend of registry.enabledBackends()) {
    let models;
    try {
      models = await backend.listModels();
    } catch {
      continue;
    }
    for (const m of models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({
        id: m.id,
        object: "model",
        created: DEFAULT_CREATED_EPOCH,
        owned_by: backend.id
      });
    }
  }
  return out;
}

export interface OpenAIModelsHandlers {
  list: RequestHandler;
  get: RequestHandler;
}

export function createOpenAIModelsHandlers(
  deps: ModelsDeps
): OpenAIModelsHandlers {
  const list: RequestHandler = async (req: Request, res: Response) => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(authenticationError("Invalid or missing API key."));
      return;
    }
    try {
      const data = await collectAllModels(deps.registry);
      const body: OpenAIModelsListResponse = { object: "list", data };
      res.status(200).json(body);
    } catch (err) {
      res
        .status(500)
        .json(
          internalServerError(
            err instanceof Error ? err.message : "models list failed"
          )
        );
    }
  };

  const get: RequestHandler = async (req: Request, res: Response) => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(authenticationError("Invalid or missing API key."));
      return;
    }
    const id = req.params["id"];
    if (typeof id !== "string" || id.length === 0) {
      res.status(404).json(notFoundError("model id missing"));
      return;
    }
    try {
      const data = await collectAllModels(deps.registry);
      const entry = data.find((m) => m.id === id);
      if (!entry) {
        res.status(404).json(notFoundError(`The model \`${id}\` does not exist.`));
        return;
      }
      res.status(200).json(entry);
    } catch (err) {
      res
        .status(500)
        .json(
          internalServerError(
            err instanceof Error ? err.message : "model lookup failed"
          )
        );
    }
  };

  return { list, get };
}
