import type { Request, RequestHandler, Response } from "express";
import Busboy from "busboy";
import { Buffer } from "node:buffer";
import { checkAuth, type AuthCarrier } from "../auth.js";
import {
  FileNotFoundError,
  FileStore,
  normalizeFileId,
  toGeminiFileId,
  type FileMetadata
} from "../fileStore.js";
import {
  internalError,
  invalidArgumentError,
  notFoundError,
  unauthenticatedError
} from "./errors.js";
import type {
  GeminiFileResource,
  GeminiFilesListResponse
} from "./types.js";

export interface FilesHandlerConfig {
  apiKey: string;
}

export interface FilesHandlerDeps {
  fileStore: FileStore;
  config: FilesHandlerConfig;
}

export interface FilesHandlers {
  upload: RequestHandler;
  list: RequestHandler;
  getMetadata: RequestHandler;
  download: RequestHandler;
  delete: RequestHandler;
}

function makeUri(req: Request, geminiId: string): string {
  const host = req.get("host") ?? "127.0.0.1";
  const proto =
    req.protocol === "https" || req.protocol === "http" ? req.protocol : "http";
  return `${proto}://${host}/v1beta/${geminiId}:download`;
}

function toGeminiFileResource(req: Request, meta: FileMetadata): GeminiFileResource {
  const geminiId = toGeminiFileId(meta.id);
  return {
    name: geminiId,
    displayName: meta.filename,
    mimeType: meta.mime,
    sizeBytes: String(meta.size),
    createTime: meta.createdAt,
    updateTime: meta.lastAccessedAt,
    state: "ACTIVE",
    uri: makeUri(req, geminiId)
  };
}

function decodePageToken(token: string | undefined): number {
  if (!token) return 0;
  try {
    const n = Number.parseInt(Buffer.from(token, "base64url").toString("utf8"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function encodePageToken(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
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

function resolveIdFromParam(idParam: string | undefined): {
  normalized: string | null;
  raw: string;
} {
  const raw = idParam ?? "";
  // Accept bare hex hash (Gemini route style), `files/<hash>` (already
  // prefixed), or `file_<hash>` (Anthropic format used by cross-shim callers).
  let candidate = raw;
  if (!raw.startsWith("file_") && !raw.startsWith("files/")) {
    candidate = `files/${raw}`;
  }
  const normalized = normalizeFileId(candidate);
  return { normalized, raw };
}

export function createFilesHandlers(deps: FilesHandlerDeps): FilesHandlers {
  const upload: RequestHandler = async (req, res) => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }
    try {
      const { filename, mime, bytes } = await readMultipart(req);
      if (bytes.length === 0) {
        res.status(400).json(invalidArgumentError("uploaded file is empty"));
        return;
      }
      const meta = await deps.fileStore.upload(bytes, filename, mime);
      res.status(200).json({ file: toGeminiFileResource(req, meta) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("multipart")) {
        res.status(400).json(invalidArgumentError(msg));
      } else {
        res.status(500).json(internalError(msg));
      }
    }
  };

  const list: RequestHandler = async (req, res) => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }
    const limit = Math.max(
      1,
      Math.min(100, Number.parseInt(String(req.query["pageSize"] ?? "20"), 10) || 20)
    );
    const offset = decodePageToken(
      typeof req.query["pageToken"] === "string" ? (req.query["pageToken"] as string) : undefined
    );
    try {
      const page = await deps.fileStore.list({ limit, offset });
      const body: GeminiFilesListResponse = {
        files: page.data.map((m) => toGeminiFileResource(req, m)),
        ...(page.has_more ? { nextPageToken: encodePageToken(offset + limit) } : {})
      };
      res.status(200).json(body);
    } catch (e) {
      res.status(500).json(internalError(e instanceof Error ? e.message : String(e)));
    }
  };

  const getMetadata: RequestHandler = async (req, res) => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }
    const { normalized, raw } = resolveIdFromParam(req.params["id"]);
    if (!normalized) {
      res.status(404).json(notFoundError(`file ${raw} not found`));
      return;
    }
    try {
      const { metadata } = await deps.fileStore.resolveById(normalized);
      res.status(200).json(toGeminiFileResource(req, metadata));
    } catch (e) {
      if (e instanceof FileNotFoundError) {
        res.status(404).json(notFoundError(`file ${raw} not found`));
        return;
      }
      res.status(500).json(internalError(e instanceof Error ? e.message : String(e)));
    }
  };

  const download: RequestHandler = async (req, res) => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }
    const { normalized, raw } = resolveIdFromParam(req.params["id"]);
    if (!normalized) {
      res.status(404).json(notFoundError(`file ${raw} not found`));
      return;
    }
    try {
      const { bytes, metadata } = await deps.fileStore.resolveById(normalized);
      res.setHeader("Content-Type", metadata.mime);
      res.setHeader("Content-Length", String(bytes.length));
      res.status(200).end(bytes);
    } catch (e) {
      if (e instanceof FileNotFoundError) {
        res.status(404).json(notFoundError(`file ${raw} not found`));
        return;
      }
      res.status(500).json(internalError(e instanceof Error ? e.message : String(e)));
    }
  };

  const deleteHandler: RequestHandler = async (req, res: Response) => {
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }
    const { normalized, raw } = resolveIdFromParam(req.params["id"]);
    if (!normalized) {
      res.status(404).json(notFoundError(`file ${raw} not found`));
      return;
    }
    try {
      await deps.fileStore.delete(normalized);
      res.status(200).json({});
    } catch (e) {
      res.status(500).json(internalError(e instanceof Error ? e.message : String(e)));
    }
  };

  return {
    upload,
    list,
    getMetadata,
    download,
    delete: deleteHandler
  };
}
