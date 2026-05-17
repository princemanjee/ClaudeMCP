import type { Request, RequestHandler, Response } from "express";
import { checkAuth, type AuthCarrier } from "../auth.js";
import type { Archive, ArchiveStatus } from "../archive.js";
import {
  authenticationError,
  invalidRequestError,
  notFoundError
} from "../anthropicShim/errors.js";

export interface AdminArchiveConfig {
  apiKey: string;
}

export interface AdminArchiveDeps {
  archive: Archive;
  config: AdminArchiveConfig;
}

export interface AdminArchiveHandlerSet {
  list: RequestHandler;
  search: RequestHandler;
  getById: RequestHandler;
}

function parseLimit(raw: unknown): number {
  if (typeof raw !== "string") return 20;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(n, 200);
}

function parseOffset(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function maybeStatus(raw: unknown): ArchiveStatus | undefined {
  if (raw === "ok" || raw === "error" || raw === "timeout") return raw;
  return undefined;
}

function pickStringQuery(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export function createAdminArchiveHandlers(
  deps: AdminArchiveDeps
): AdminArchiveHandlerSet {
  const auth = (req: Request, res: Response): boolean => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(authenticationError("invalid or missing API key"));
      return false;
    }
    return true;
  };

  const list: RequestHandler = (req, res) => {
    if (!auth(req, res)) return;
    const filters: Parameters<typeof deps.archive.list>[0] = {
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    };
    const backend = pickStringQuery(req.query.backend);
    if (backend) filters.backend = backend;
    const sessionId = pickStringQuery(req.query.session);
    if (sessionId) filters.sessionId = sessionId;
    const model = pickStringQuery(req.query.model);
    if (model) filters.model = model;
    const since = pickStringQuery(req.query.since);
    if (since) filters.since = since;
    const until = pickStringQuery(req.query.until);
    if (until) filters.until = until;
    const status = maybeStatus(req.query.status);
    if (status) filters.status = status;
    const page = deps.archive.list(filters);
    res.status(200).json(page);
  };

  const search: RequestHandler = (req, res) => {
    if (!auth(req, res)) return;
    const q = pickStringQuery(req.query.q);
    if (!q) {
      res.status(400).json(invalidRequestError("missing required query param: q"));
      return;
    }
    const page = deps.archive.searchText(q, {
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });
    res.status(200).json(page);
  };

  const getById: RequestHandler = (req, res) => {
    if (!auth(req, res)) return;
    const idRaw = req.params.id ?? "";
    const id = Number.parseInt(idRaw, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json(invalidRequestError(`invalid archive id: ${idRaw}`));
      return;
    }
    const entry = deps.archive.getById(id);
    if (!entry) {
      res.status(404).json(notFoundError(`archive entry ${id} not found`));
      return;
    }
    res.status(200).json(entry);
  };

  return { list, search, getById };
}
