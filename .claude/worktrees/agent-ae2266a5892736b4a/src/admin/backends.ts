import type { Request, RequestHandler, Response } from "express";
import { checkAuth, type AuthCarrier } from "../auth.js";
import type { BackendRegistry } from "../backends/registry.js";
import type {
  BackendCapabilities,
  BackendId,
  ModelDescriptor
} from "../backends/types.js";
import {
  authenticationError,
  internalServerError,
  invalidRequestError
} from "../anthropicShim/errors.js";

export interface AdminBackendsConfig {
  apiKey: string;
}

export interface AdminBackendsDeps {
  registry: BackendRegistry;
  config: AdminBackendsConfig;
}

export interface AdminBackendsHandlerSet {
  list: RequestHandler;
  reprobe: RequestHandler;
  test: RequestHandler;
}

interface BackendListEntry {
  id: BackendId;
  models: ModelDescriptor[];
  capabilities: Record<string, BackendCapabilities>;
  lastProbe:
    | { ok: boolean; at: string; error?: string }
    | null;
  reachable: boolean;
}

async function listBackends(registry: BackendRegistry): Promise<BackendListEntry[]> {
  const out: BackendListEntry[] = [];
  for (const backend of registry.enabledBackends()) {
    let models: ModelDescriptor[] = [];
    try {
      models = await backend.listModels();
    } catch {
      // listModels can throw if the backend is unreachable; surface as empty.
      models = [];
    }
    const capabilities: Record<string, BackendCapabilities> = {};
    for (const m of models) capabilities[m.id] = backend.capabilitiesFor(m.id);
    const status = registry.lastProbeStatus(backend.id);
    const entry: BackendListEntry = {
      id: backend.id,
      models,
      capabilities,
      lastProbe: status
        ? {
            ok: status.ok,
            at: status.lastProbedAt.toISOString(),
            ...(status.error ? { error: status.error } : {})
          }
        : null,
      reachable: status?.ok === true
    };
    out.push(entry);
  }
  return out;
}

interface TestBody {
  baseUrl: string;
  apiKey?: string;
  useNativeApi?: boolean;
}

function parseTestBody(raw: unknown): TestBody | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "body must be a JSON object" };
  const body = raw as Record<string, unknown>;
  if (typeof body.baseUrl !== "string" || body.baseUrl.length === 0) {
    return { error: "baseUrl is required" };
  }
  const out: TestBody = { baseUrl: body.baseUrl };
  if (typeof body.apiKey === "string") out.apiKey = body.apiKey;
  if (typeof body.useNativeApi === "boolean") out.useNativeApi = body.useNativeApi;
  return out;
}

async function performConnectivityTest(body: TestBody): Promise<{
  ok: boolean;
  models?: string[];
  error?: string;
  latencyMs: number;
}> {
  const path = body.useNativeApi ? "/api/tags" : "/v1/models";
  const url = `${body.baseUrl.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body.apiKey) headers["Authorization"] = `Bearer ${body.apiKey}`;
  const start = Date.now();
  try {
    const res = await fetch(url, { headers });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, latencyMs };
    }
    const json = (await res.json()) as Record<string, unknown>;
    const models = extractModelIds(json, body.useNativeApi === true);
    return { ok: true, models, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, latencyMs };
  }
}

function extractModelIds(json: Record<string, unknown>, native: boolean): string[] {
  if (native) {
    const arr = json.models;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((m) =>
        m && typeof m === "object" && typeof (m as Record<string, unknown>).name === "string"
          ? ((m as Record<string, unknown>).name as string)
          : null
      )
      .filter((s): s is string => s !== null);
  }
  const arr = json.data;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((m) =>
      m && typeof m === "object" && typeof (m as Record<string, unknown>).id === "string"
        ? ((m as Record<string, unknown>).id as string)
        : null
    )
    .filter((s): s is string => s !== null);
}

export function createAdminBackendsHandlers(
  deps: AdminBackendsDeps
): AdminBackendsHandlerSet {
  const auth = (req: Request, res: Response): boolean => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(authenticationError("invalid or missing API key"));
      return false;
    }
    return true;
  };

  const list: RequestHandler = async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const data = await listBackends(deps.registry);
      res.status(200).json({ data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json(internalServerError(`failed to list backends: ${message}`));
    }
  };

  const reprobe: RequestHandler = async (req, res) => {
    if (!auth(req, res)) return;
    const requestedInstance =
      typeof req.query.instance === "string" ? req.query.instance : undefined;
    if (requestedInstance) {
      const known = deps.registry.enabledBackends().map((b) => b.id);
      const matched =
        known.includes(requestedInstance as BackendId) ||
        // tolerate the "<backend>:<instance-name>" form even though the registry
        // does not currently disambiguate.
        known.some((id) => requestedInstance.startsWith(`${id}:`));
      if (!matched) {
        res.status(400).json(
          invalidRequestError(
            `unknown instance: ${requestedInstance}; known backends: ${known.join(", ")}`
          )
        );
        return;
      }
    }
    try {
      await deps.registry.probe();
      const data = await listBackends(deps.registry);
      const meta: Record<string, string> = { reprobeScope: "all" };
      if (requestedInstance) meta.requestedInstance = requestedInstance;
      res.status(200).json({ data, _meta: meta });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json(internalServerError(`reprobe failed: ${message}`));
    }
  };

  const test: RequestHandler = async (req, res) => {
    if (!auth(req, res)) return;
    const parsed = parseTestBody(req.body);
    if ("error" in parsed) {
      res.status(400).json(invalidRequestError(parsed.error));
      return;
    }
    const result = await performConnectivityTest(parsed);
    res.status(200).json(result);
  };

  return { list, reprobe, test };
}
