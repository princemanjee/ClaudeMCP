import type { Request, RequestHandler, Response } from "express";
import { checkAuth, type AuthCarrier } from "../auth.js";
import type { BackendRegistry } from "../backends/registry.js";
import type { ModelDescriptor } from "../backends/types.js";
import {
  internalError,
  notFoundError,
  unauthenticatedError
} from "./errors.js";
import { stripModelsPrefix } from "./modelPath.js";
import type {
  GeminiModelEntry,
  GeminiModelsListResponse
} from "./types.js";

export interface ModelsHandlerConfig {
  apiKey: string;
}

export interface GeminiModelsHandlerDeps {
  registry: BackendRegistry;
  config: ModelsHandlerConfig;
}

const SUPPORTED_METHODS = [
  "generateContent",
  "streamGenerateContent",
  "countTokens"
];

function descriptorToEntry(desc: ModelDescriptor): GeminiModelEntry {
  return {
    name: `models/${desc.id}`,
    displayName: desc.description ?? desc.id,
    description: desc.description ?? desc.id,
    ...(typeof desc.contextWindow === "number"
      ? { inputTokenLimit: desc.contextWindow, outputTokenLimit: 8192 }
      : {}),
    supportedGenerationMethods: SUPPORTED_METHODS
  };
}

async function gatherAllModels(
  registry: BackendRegistry
): Promise<GeminiModelEntry[]> {
  const seen = new Set<string>();
  const out: GeminiModelEntry[] = [];
  for (const backend of registry.enabledBackends()) {
    let models: ModelDescriptor[];
    try {
      models = await backend.listModels();
    } catch {
      continue;
    }
    for (const m of models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(descriptorToEntry(m));
    }
  }
  return out;
}

export interface GeminiModelsHandlers {
  list: RequestHandler;
  get: RequestHandler;
}

export function createGeminiModelsHandlers(
  deps: GeminiModelsHandlerDeps
): GeminiModelsHandlers {
  const list: RequestHandler = async (req: Request, res: Response) => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }
    try {
      const entries = await gatherAllModels(deps.registry);
      const body: GeminiModelsListResponse = { models: entries };
      res.status(200).json(body);
    } catch (e) {
      res.status(500).json(internalError(e instanceof Error ? e.message : String(e)));
    }
  };

  const get: RequestHandler = async (req: Request, res: Response) => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }
    const rawId = req.params["id"];
    if (typeof rawId !== "string" || rawId.length === 0) {
      res.status(404).json(notFoundError("missing model id"));
      return;
    }
    const id = stripModelsPrefix(rawId);
    try {
      const entries = await gatherAllModels(deps.registry);
      const found = entries.find((e) => e.name === `models/${id}`);
      if (!found) {
        res.status(404).json(notFoundError(`model ${id} not found`));
        return;
      }
      res.status(200).json(found);
    } catch (e) {
      res.status(500).json(internalError(e instanceof Error ? e.message : String(e)));
    }
  };

  return { list, get };
}
