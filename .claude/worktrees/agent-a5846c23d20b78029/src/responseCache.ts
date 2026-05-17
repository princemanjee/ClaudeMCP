import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync
} from "node:fs";
import { dirname } from "node:path";

// ---- Public types ---------------------------------------------------------

export interface CacheKeyParts {
  backendId: string;
  resolvedModel: string;
  system: string | undefined;
  cacheablePrefix: unknown;
  tail: unknown;
  tools?: unknown;
  toolChoice?: unknown;
}

export interface CachedResponse {
  body: Record<string, unknown>;
  metadata: {
    backendId: string;
    resolvedModel: string;
  };
}

interface InternalEntry {
  key: string;
  value: CachedResponse;
  createdAt: number;
  lastAccessedAt: number;
}

export interface ResponseCacheOptions {
  file: string;
  ttlMs: number;
  maxEntries: number;
}

// ---- Canonicalization -----------------------------------------------------

function nfcNormalize(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(nfcNormalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = nfcNormalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(nfcNormalize(value));
}

export function buildCacheKey(parts: CacheKeyParts): string {
  const canonical = canonicalJson(parts);
  return createHash("sha256").update(canonical).digest("hex");
}

// ---- Persistence ----------------------------------------------------------

function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

// ---- Cache ----------------------------------------------------------------

export class ResponseCache {
  private readonly opts: ResponseCacheOptions;
  private readonly entries = new Map<string, InternalEntry>();

  constructor(opts: ResponseCacheOptions) {
    this.opts = opts;
    this.loadFromDisk();
  }

  get(key: string): CachedResponse | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.opts.ttlMs) {
      this.entries.delete(key);
      this.persist();
      return undefined;
    }
    entry.lastAccessedAt = Date.now();
    return entry.value;
  }

  set(key: string, value: CachedResponse): void {
    const now = Date.now();
    this.entries.set(key, {
      key,
      value,
      createdAt: now,
      lastAccessedAt: now
    });
    this.evictIfNeeded();
    this.persist();
  }

  size(): number {
    return this.entries.size;
  }

  // ---- Internals --------------------------------------------------------

  private evictIfNeeded(): void {
    if (this.entries.size <= this.opts.maxEntries) return;
    // Sort by lastAccessedAt ascending; drop oldest until under cap.
    const sorted = [...this.entries.values()].sort(
      (a, b) => a.lastAccessedAt - b.lastAccessedAt
    );
    let overage = this.entries.size - this.opts.maxEntries;
    for (const e of sorted) {
      if (overage <= 0) break;
      this.entries.delete(e.key);
      overage--;
    }
  }

  private persist(): void {
    const lines = [...this.entries.values()].map((e) => JSON.stringify(e));
    atomicWrite(this.opts.file, lines.join("\n"));
  }

  private loadFromDisk(): void {
    if (!existsSync(this.opts.file)) return;
    const raw = readFileSync(this.opts.file, "utf8");
    if (!raw.trim()) return;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as InternalEntry;
        this.entries.set(parsed.key, parsed);
      } catch {
        // Corrupt line; skip. A future sweep can compact.
      }
    }
  }
}
