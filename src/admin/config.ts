import type { Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";
import { checkAuth, type AuthCarrier } from "../auth.js";
import {
  authenticationError,
  internalServerError,
  invalidRequestError
} from "../anthropicShim/errors.js";
import { type Config } from "../config.js";
import type { ConfigSnapshotStore } from "./configSnapshot.js";
import { parseConfig } from "./configValidate.js";

export interface AdminConfigDeps {
  snapshot: ConfigSnapshotStore;
}

export interface AdminConfigHandlerSet {
  get: RequestHandler;
  put: RequestHandler;
  patch: RequestHandler;
}

const REDACTED = "***";

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * RFC 7396 JSON-merge-patch. Arrays are treated as atomic (full replacement),
 * `null` in the patch deletes the target key, objects are recursively merged.
 */
function mergePatch<T extends Record<string, unknown>>(
  target: T,
  patch: Record<string, unknown>
): T {
  const out = { ...target } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof out[key] === "object" &&
      out[key] !== null &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergePatch(
        out[key] as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/**
 * Strip `null` values recursively, including inside arrays. RFC 7396 says
 * `null` at any object key means "remove this key". Our top-level mergePatch
 * already handles object-level deletion; this pass extends that semantic to
 * array elements (each array element that is an object has its null-valued
 * keys removed). Without this, a PATCH containing `instances: [{ apiKey: null,
 * ... }]` would land a literal `null` in the merged value that Zod rejects.
 *
 * This is a small extension of RFC 7396's array-as-atomic rule: we keep the
 * array atomic (no element-level merging into the existing array) but apply
 * null-deletion to the replacement elements before Zod validation, so Zod
 * defaults can re-populate the removed fields.
 */
function stripNullsInArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((el) => stripNullsInArrays(el));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null) continue;
      out[k] = stripNullsInArrays(v);
    }
    return out;
  }
  return value;
}

function redactForGet(cfg: Config): Record<string, unknown> {
  const clone = deepClone(cfg) as unknown as Record<string, unknown>;
  clone.apiKey = REDACTED;
  // Redact per-instance apiKey for HTTP backends.
  for (const key of ["lmstudio", "ollama"] as const) {
    const block = clone[key] as Record<string, unknown> | undefined;
    if (!block) continue;
    const instances = block.instances as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(instances)) continue;
    for (const inst of instances) {
      if (typeof inst.apiKey === "string" && inst.apiKey.length > 0) {
        inst.apiKey = REDACTED;
      }
    }
  }
  return clone;
}

function zodErrorToMessage(err: ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function rejectRedactedApiKey(body: Record<string, unknown>): string | null {
  if (body.apiKey === REDACTED) {
    return "apiKey is the redacted placeholder ***; supply the real key or use PATCH to update other fields without touching apiKey";
  }
  return null;
}

export function createAdminConfigHandlers(
  deps: AdminConfigDeps
): AdminConfigHandlerSet {
  const auth = (req: Request, res: Response): boolean => {
    const cfg = deps.snapshot.current();
    if (!checkAuth(req as unknown as AuthCarrier, cfg.apiKey)) {
      res.status(401).json(authenticationError("invalid or missing API key"));
      return false;
    }
    return true;
  };

  const get: RequestHandler = (req, res) => {
    if (!auth(req, res)) return;
    res.status(200).json(redactForGet(deps.snapshot.current()));
  };

  const put: RequestHandler = (req, res) => {
    if (!auth(req, res)) return;
    if (!req.body || typeof req.body !== "object") {
      res.status(400).json(invalidRequestError("body must be a JSON object"));
      return;
    }
    const redactedReject = rejectRedactedApiKey(req.body as Record<string, unknown>);
    if (redactedReject) {
      res.status(400).json(invalidRequestError(redactedReject));
      return;
    }
    let validated: Config;
    try {
      validated = parseConfig(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json(invalidRequestError(zodErrorToMessage(err)));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json(invalidRequestError(message));
      return;
    }
    try {
      const replaced = deps.snapshot.replace(validated);
      res.status(200).json(redactForGet(replaced));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .json(internalServerError(`failed to persist config: ${message}`));
    }
  };

  const patch: RequestHandler = (req, res) => {
    if (!auth(req, res)) return;
    if (!req.body || typeof req.body !== "object") {
      res.status(400).json(invalidRequestError("body must be a JSON object"));
      return;
    }
    const redactedReject = rejectRedactedApiKey(req.body as Record<string, unknown>);
    if (redactedReject) {
      res.status(400).json(invalidRequestError(redactedReject));
      return;
    }
    const merged = mergePatch(
      deepClone(deps.snapshot.current()) as unknown as Record<string, unknown>,
      req.body as Record<string, unknown>
    );
    const cleaned = stripNullsInArrays(merged);
    let validated: Config;
    try {
      validated = parseConfig(cleaned);
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json(invalidRequestError(zodErrorToMessage(err)));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json(invalidRequestError(message));
      return;
    }
    try {
      const replaced = deps.snapshot.replace(validated);
      res.status(200).json(redactForGet(replaced));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .json(internalServerError(`failed to persist config: ${message}`));
    }
  };

  return { get, put, patch };
}
