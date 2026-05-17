import type { Request, RequestHandler, Response } from "express";
import Busboy from "busboy";
import { checkAuth, type AuthCarrier } from "../auth.js";
import {
  authenticationError,
  internalServerError,
  invalidRequestError,
  notFoundError
} from "./errors.js";
import {
  FileNotFoundError,
  type FileMetadata,
  type FileStore
} from "../fileStore.js";

export interface FilesHandlerConfig {
  apiKey: string;
}

export interface FilesHandlerDeps {
  fileStore: FileStore;
  config: FilesHandlerConfig;
}

interface FilesHandlerSet {
  upload: RequestHandler;
  list: RequestHandler;
  getMetadata: RequestHandler;
  download: RequestHandler;
  delete: RequestHandler;
}

function toEnvelope(meta: FileMetadata): Record<string, unknown> {
  return {
    id: meta.id,
    type: "file",
    filename: meta.filename,
    mime_type: meta.mime,
    size_bytes: meta.size,
    created_at: meta.createdAt
  };
}

function parseLimit(raw: unknown, fallback = 20): number {
  if (typeof raw !== "string") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 1000);
}

function parseOffset(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

async function readMultipart(req: Request): Promise<{
  filename: string;
  mime: string;
  bytes: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const ct = req.headers["content-type"];
    if (typeof ct !== "string" || !ct.includes("multipart/form-data")) {
      reject(new Error("expected multipart/form-data"));
      return;
    }
    let resolved = false;
    const bb = Busboy({ headers: req.headers });
    bb.on("file", (_field, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        if (resolved) return;
        resolved = true;
        resolve({
          filename: info.filename ?? "upload.bin",
          mime: info.mimeType ?? "application/octet-stream",
          bytes: Buffer.concat(chunks)
        });
      });
      stream.on("error", (err) => {
        if (resolved) return;
        resolved = true;
        reject(err);
      });
    });
    bb.on("error", (err: unknown) => {
      if (resolved) return;
      resolved = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    bb.on("finish", () => {
      if (resolved) return;
      resolved = true;
      reject(new Error("multipart body contained no file field"));
    });
    req.pipe(bb);
  });
}

export function createFilesHandlers(deps: FilesHandlerDeps): FilesHandlerSet {
  const auth = (req: Request, res: Response): boolean => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(authenticationError("invalid or missing API key"));
      return false;
    }
    return true;
  };

  const upload: RequestHandler = async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const { filename, mime, bytes } = await readMultipart(req);
      if (bytes.length === 0) {
        res.status(400).json(invalidRequestError("uploaded file is empty"));
        return;
      }
      const meta = await deps.fileStore.upload(bytes, filename, mime);
      res.status(200).json(toEnvelope(meta));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("multipart")) {
        res.status(400).json(invalidRequestError(msg));
      } else {
        res.status(500).json(internalServerError(msg));
      }
    }
  };

  const list: RequestHandler = async (req, res) => {
    if (!auth(req, res)) return;
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);
    const page = await deps.fileStore.list({ limit, offset });
    res.status(200).json({
      data: page.data.map(toEnvelope),
      has_more: page.has_more
    });
  };

  const getMetadata: RequestHandler = async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const { metadata } = await deps.fileStore.get(req.params.id ?? "");
      res.status(200).json(toEnvelope(metadata));
    } catch (err) {
      if (err instanceof FileNotFoundError) {
        res.status(404).json(notFoundError(err.message));
      } else {
        res
          .status(500)
          .json(internalServerError(err instanceof Error ? err.message : String(err)));
      }
    }
  };

  const download: RequestHandler = async (req, res) => {
    if (!auth(req, res)) return;
    try {
      const { bytes, metadata } = await deps.fileStore.get(req.params.id ?? "");
      res.setHeader("Content-Type", metadata.mime);
      res.setHeader("Content-Length", String(metadata.size));
      res.status(200).end(bytes);
    } catch (err) {
      if (err instanceof FileNotFoundError) {
        res.status(404).json(notFoundError(err.message));
      } else {
        res
          .status(500)
          .json(internalServerError(err instanceof Error ? err.message : String(err)));
      }
    }
  };

  const del: RequestHandler = async (req, res) => {
    if (!auth(req, res)) return;
    const id = req.params.id ?? "";
    await deps.fileStore.delete(id);
    res.status(200).json({ id, type: "file_deleted" });
  };

  return { upload, list, getMetadata, download, delete: del };
}
