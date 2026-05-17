import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from "node:fs";
import { join } from "node:path";
import type { NormalizedContentBlock } from "./backends/types.js";

// ---- Public types ---------------------------------------------------------

export interface FileStoreOptions {
  dir: string;
  ttlMs: number;
  maxTotalBytes: number;
  /**
   * How often the background sweep runs. Defaults to 5 minutes — matches the
   * spec's "shared timer with session sweep" note. Set to 0 to disable for
   * tests; call `runEviction()` directly instead.
   */
  sweepIntervalMs?: number;
}

export interface FileMetadata {
  id: string; // file_<24hex>
  filename: string;
  mime: string;
  size: number;
  createdAt: string; // ISO-8601
  lastAccessedAt: string; // ISO-8601
}

export interface FileListPage {
  data: FileMetadata[];
  has_more: boolean;
}

export class FileNotFoundError extends Error {
  override readonly name = "FileNotFoundError";
  constructor(public readonly id: string) {
    super(`file not found: ${id}`);
  }
}

// ---- Internal helpers -----------------------------------------------------

function shortHash(fullHex: string): string {
  return fullHex.slice(0, 24);
}

function idFromBytes(bytes: Buffer): string {
  const full = createHash("sha256").update(bytes).digest("hex");
  return `file_${shortHash(full)}`;
}

function hashFromId(id: string): string {
  return id.slice("file_".length);
}

function isFileId(id: string): boolean {
  return /^file_[0-9a-f]{24}$/.test(id);
}

function atomicWrite(path: string, contents: Buffer | string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    if (typeof contents === "string") {
      writeSync(fd, contents);
    } else {
      writeSync(fd, contents);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

// ---- FileStore ------------------------------------------------------------

const SWEEP_DEFAULT_MS = 5 * 60 * 1000;

export class FileStore {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly maxTotalBytes: number;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(opts: FileStoreOptions) {
    this.dir = opts.dir;
    this.ttlMs = opts.ttlMs;
    this.maxTotalBytes = opts.maxTotalBytes;
    mkdirSync(this.dir, { recursive: true });

    const sweepMs = opts.sweepIntervalMs ?? SWEEP_DEFAULT_MS;
    if (sweepMs > 0) {
      this.sweepTimer = setInterval(() => {
        try {
          this.runEviction();
        } catch (err) {
          // Sweep failures are logged but never thrown — eviction is best-effort.
          // eslint-disable-next-line no-console
          console.warn("FileStore sweep failed:", err);
        }
      }, sweepMs);
      this.sweepTimer.unref?.();
    }
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  async upload(
    bytes: Buffer,
    filename: string,
    mime: string
  ): Promise<FileMetadata> {
    const id = idFromBytes(bytes);
    const hash = hashFromId(id);
    const contentPath = join(this.dir, hash);
    const sidecarPath = join(this.dir, `${hash}.json`);

    if (existsSync(sidecarPath)) {
      // Dedup hit — preserve existing filename/createdAt, bump lastAccessedAt.
      const existing = this.readSidecar(sidecarPath);
      const updated: FileMetadata = {
        ...existing,
        lastAccessedAt: new Date().toISOString()
      };
      atomicWrite(sidecarPath, JSON.stringify(updated));
      return updated;
    }

    atomicWrite(contentPath, bytes);
    const now = new Date().toISOString();
    const meta: FileMetadata = {
      id,
      filename,
      mime,
      size: bytes.length,
      createdAt: now,
      lastAccessedAt: now
    };
    atomicWrite(sidecarPath, JSON.stringify(meta));
    return meta;
  }

  async get(id: string): Promise<{ bytes: Buffer; metadata: FileMetadata }> {
    if (!isFileId(id)) throw new FileNotFoundError(id);
    const hash = hashFromId(id);
    const contentPath = join(this.dir, hash);
    const sidecarPath = join(this.dir, `${hash}.json`);
    if (!existsSync(contentPath) || !existsSync(sidecarPath)) {
      throw new FileNotFoundError(id);
    }
    const bytes = readFileSync(contentPath);
    const meta = this.readSidecar(sidecarPath);
    const updated: FileMetadata = {
      ...meta,
      lastAccessedAt: new Date().toISOString()
    };
    atomicWrite(sidecarPath, JSON.stringify(updated));
    return { bytes, metadata: updated };
  }

  async list(opts: {
    limit: number;
    offset: number;
  }): Promise<FileListPage> {
    const all = this.allSidecars();
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const page = all.slice(opts.offset, opts.offset + opts.limit);
    return { data: page, has_more: opts.offset + opts.limit < all.length };
  }

  async delete(id: string): Promise<void> {
    if (!isFileId(id)) return;
    const hash = hashFromId(id);
    const contentPath = join(this.dir, hash);
    const sidecarPath = join(this.dir, `${hash}.json`);
    if (existsSync(contentPath)) rmSync(contentPath, { force: true });
    if (existsSync(sidecarPath)) rmSync(sidecarPath, { force: true });
  }

  /**
   * Resolve a `file_*` id into a normalized inline content block. Called by
   * `requestTranslator.ts` when it encounters a `source.type === "file"`
   * reference in an image/document block.
   */
  async resolveForInline(
    id: string,
    expectedKind: "image" | "document"
  ): Promise<NormalizedContentBlock> {
    const { bytes, metadata } = await this.get(id);
    return {
      type: expectedKind,
      mediaType: metadata.mime,
      data: bytes.toString("base64")
    };
  }

  /**
   * Run the TTL pass then the max-total-bytes LRU pass. Idempotent; safe to
   * call from tests. Wired into the periodic sweep timer.
   */
  runEviction(): void {
    const now = Date.now();
    const survivors: FileMetadata[] = [];

    for (const meta of this.allSidecars()) {
      const last = new Date(meta.lastAccessedAt).getTime();
      if (now - last > this.ttlMs) {
        void this.delete(meta.id);
      } else {
        survivors.push(meta);
      }
    }

    let totalBytes = survivors.reduce((sum, m) => sum + m.size, 0);
    if (totalBytes <= this.maxTotalBytes) return;

    // LRU: sort oldest-access first; evict until under cap.
    survivors.sort((a, b) => a.lastAccessedAt.localeCompare(b.lastAccessedAt));
    for (const victim of survivors) {
      if (totalBytes <= this.maxTotalBytes) break;
      void this.delete(victim.id);
      totalBytes -= victim.size;
    }
  }

  // ---- Internal helpers --------------------------------------------------

  private readSidecar(path: string): FileMetadata {
    return JSON.parse(readFileSync(path, "utf8")) as FileMetadata;
  }

  private allSidecars(): FileMetadata[] {
    const out: FileMetadata[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        out.push(this.readSidecar(join(this.dir, name)));
      } catch {
        // Skip unreadable sidecars — they'll be cleaned up by a future sweep
        // once we have a "stale temp" detector.
      }
    }
    return out;
  }
}
