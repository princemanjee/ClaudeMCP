import type { Request, RequestHandler, Response } from "express";
import { checkAuth, type AuthCarrier } from "../auth.js";
import type { BackendRegistry } from "../backends/registry.js";
import type { ModelDescriptor } from "../backends/types.js";
import {
  authenticationError,
  internalServerError,
  notFoundError
} from "./errors.js";
import type {
  AnthropicModelEntry,
  AnthropicModelsListResponse
} from "./types.js";

export interface ModelsHandlerConfig {
  apiKey: string;
}

export interface ModelsHandlerDeps {
  registry: BackendRegistry;
  config: ModelsHandlerConfig;
}

/**
 * Single fixed created_at for entries that lack a known release date. The
 * Anthropic shim is required to surface this field, but the platform doesn't
 * have a per-model release-date catalog yet. Plan 09 (when the model registry
 * grows admin endpoints) can backfill real dates.
 */
const PLACEHOLDER_CREATED_AT = "2026-01-01T00:00:00Z";

function descriptorToEntry(desc: ModelDescriptor): AnthropicModelEntry {
  return {
    type: "model",
    id: desc.id,
    display_name: desc.description ?? desc.id,
    created_at: PLACEHOLDER_CREATED_AT
  };
}

async function gatherAllModels(
  registry: BackendRegistry
): Promise<AnthropicModelEntry[]> {
  const seen = new Set<string>();
  const out: AnthropicModelEntry[] = [];
  for (const backend of registry.enabledBackends()) {
    let models: ModelDescriptor[];
    try {
      models = await backend.listModels();
    } catch {
      // A failing backend shouldn't blank out the whole listing.
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

export interface ModelsHandlers {
  list: RequestHandler;
  get: RequestHandler;
}

export function createModelsHandlers(deps: ModelsHandlerDeps): ModelsHandlers {
  const list: RequestHandler = async (req: Request, res: Response) => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(authenticationError("invalid or missing API key"));
      return;
    }
    try {
      const entries = await gatherAllModels(deps.registry);
      const body: AnthropicModelsListResponse = {
        data: entries,
        has_more: false,
        first_id: entries[0]?.id ?? null,
        last_id: entries[entries.length - 1]?.id ?? null
      };
      res.status(200).json(body);
    } catch (e) {
      res
        .status(500)
        .json(internalServerError(e instanceof Error ? e.message : String(e)));
    }
  };

  const get: RequestHandler = async (req: Request, res: Response) => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(authenticationError("invalid or missing API key"));
      return;
    }
    const id = req.params["id"];
    if (typeof id !== "string" || id.length === 0) {
      res.status(404).json(notFoundError("missing model id"));
      return;
    }
    try {
      const entries = await gatherAllModels(deps.registry);
      const found = entries.find((e) => e.id === id);
      if (!found) {
        res.status(404).json(notFoundError(`model ${id} not found`));
        return;
      }
      res.status(200).json(found);
    } catch (e) {
      res
        .status(500)
        .json(internalServerError(e instanceof Error ? e.message : String(e)));
    }
  };

  return { list, get };
}
