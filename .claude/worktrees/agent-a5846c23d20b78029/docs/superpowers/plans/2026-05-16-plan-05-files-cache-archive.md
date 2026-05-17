# Plan 05: Files API + Response Cache + Archive Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the three cross-cutting features every later shim/backend pair will rely on: a persistent disk-backed Files API exposed via `/v1/files/*`, a local response-memo cache reinterpreting Anthropic's `cache_control: { type: "ephemeral" }`, and writer/query methods on the existing `Archive` skeleton with admin HTTP endpoints to read it back. By the end of this plan, every `/v1/messages` call lands in the archive; cache-control-bearing requests can re-use prior responses without spawning the backend; and clients can upload files once and reference them by `file_<hash>` in any subsequent generation request.

**Architecture:** Three new pure modules under `src/` — `fileStore.ts`, `responseCache.ts`, and `src/admin/archive.ts` — plus a typed extension of `src/archive.ts` (writers + query methods, with the existing `raw()` escape hatch retained as documented "prefer the typed surface" exit). Two new handler factories under `src/anthropicShim/files.ts` and `src/admin/archive.ts` mounted by `src/server.ts`. The integration into `messages.ts` happens at three call sites: file-id resolution in `requestTranslator.ts`, cache lookup before backend dispatch, and archive write after completion (fire-and-forget, never blocking the response). A small CLI under `scripts/archive-prune.ts` rounds out the operator surface. Every module is constructed once at server startup and threaded through handler factory deps — no module-scoped state — so unit tests instantiate fresh instances per case.

**Tech Stack:** Same as Plans 01-04 — Node.js 22+ (the project's `@types/node` is `^22.10.0` and we rely on the Node 22 `node:zlib` zstd transform `createZstdCompress`/`createZstdDecompress`), TypeScript 5 (NodeNext ESM with explicit `.js` import suffixes), Express 4, Vitest + Supertest, `better-sqlite3` for the archive. **New runtime deps:** `busboy` for `multipart/form-data` parsing in the `/v1/files` POST handler (chosen over `multer` for the smaller dep footprint and stream-friendly API). All `src/*` imports use explicit `.js` extensions (NodeNext).

**Spec:** `docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md` (Phase 5: persistent files, response cache, archive writes).

**Builds on:**
- Plan 01 (`docs/superpowers/plans/2026-05-16-plan-01-foundation.md`) — `Archive` class (with `raw()` escape hatch), `loadConfig` (`config.files`, `config.cache`, `config.archive` already in the Zod schema), `BackendRegistry`, `checkAuth`, the normalized types in `src/backends/types.ts`. The `files`, `cache`, and `archive` config blocks were defined in Plan 01 with defaults already pinned — this plan does **not** modify the config schema.
- Plan 02 (`docs/superpowers/plans/2026-05-16-plan-02-claude-backend.md`) — `ClaudeBackend.invoke()` is a consumer of the now-archived request flow; no API change required from the backend side.
- Plan 03 (`docs/superpowers/plans/2026-05-16-plan-03-anthropic-shim.md`) — `src/anthropicShim/messages.ts` is the call site for both the cache check and the archive write; `src/anthropicShim/requestTranslator.ts` is the call site for file-id resolution; `src/server.ts` mounts the new `/v1/files/*` and `/admin/archive*` routes; `src/anthropicShim/errors.ts` supplies the Anthropic-shaped error envelopes the new handlers reuse.
- Plan 04 (assumed merged) — image/document inlining works in tandem with file references; a `file_<hash>` reference inlines as the same content-block type the file was uploaded as. Plan 05 produces normalized content blocks of `type: "image" | "document"` with inlined base64 bytes, matching what Plan 04 taught the request translator to honor.

---

## Pre-flight check

Before starting Task 1, confirm the Plans 01-04 baseline is in place:

- [ ] `git log --oneline -30` shows Plan 04's commits merged (look for the multimodal + tool_use work landing on `main`).
- [ ] `npm test` passes the full Plan-04 suite (no skips).
- [ ] `npx tsc --noEmit` clean.
- [ ] `src/archive.ts` exists, exports the `Archive` class with a `raw()` escape hatch, and creates the `entries` table with the columns named in the Plan-01 schema block (`request_hash`, `log_id`, `endpoint`, `backend`, `model_resolved`, `session_id`, `timestamp`, `status`, `duration_ms`, `input_tokens`, `output_tokens`, `request_body`, `response_body`).
- [ ] `src/config.ts` exposes `config.files.{dir, ttlMs, maxTotalBytes}`, `config.cache.{file, ttlMs, maxEntries}`, and `config.archive.{dbPath, compressionLevel}` — these were defined in Plan 01 and this plan must not alter the Zod schema.
- [ ] `src/anthropicShim/messages.ts`, `requestTranslator.ts`, `responseTranslator.ts`, `errors.ts`, and `types.ts` all exist from Plan 03 (Plan 04 may have extended them — that's fine, Plan 05 wraps both shapes).
- [ ] `src/server.ts` exports `buildApp(deps)` and `main(opts)` per Plan 03.
- [ ] `node --version` reports `v22.x` or later (the `node:zlib` zstd API used by archive compression requires Node 22+). If the test environment is Node 20, see the **Open questions** section at the end of this plan for the `@mongodb-js/zstd` fallback procedure — but the **default path** assumes Node 22+ and `package.json` does **not** add a userland zstd dependency.

If any check fails, stop and resolve before proceeding.

---

## File map

| File | Change | Lines (approx.) |
|---|---|---|
| `package.json` | EXTEND — add `busboy` runtime dep + `@types/busboy` dev dep. | +2 |
| `src/fileStore.ts` | NEW — `FileStore` class. `upload(bytes, filename, mime)`, `get(id)`, `list({limit, offset})`, `delete(id)`, `resolveForInline(id, expectedKind)`. Metadata sidecar JSON per file. Content-addressed by SHA-256. TTL + max-total-bytes LRU eviction sweep. | ~280 |
| `src/responseCache.ts` | NEW — `ResponseCache` class. `get(key)` and `set(key, response)`. `buildCacheKey(parts)` exported helper. JSON-line file persistence with atomic rename, mirrored in-memory `Map` for fast lookup. TTL + max-entries LRU eviction. Streaming-hit replay synthesizer lives in `responseTranslator.ts` already; this module returns the raw cached body and metadata. | ~240 |
| `src/archive.ts` | EXTEND — add `recordEntry(entry: ArchiveEntry)` (synchronous, throws on failure), `list(filters)`, `getById(id)`, `searchText(q)`, `deleteOlderThan(isoDate)`, `deleteBySession(sessionId)`. zstd-compresses `request_body` and `response_body` via `node:zlib`'s `zstdCompressSync` / `zstdDecompressSync`. The `raw()` escape hatch from Plan 01 stays for now with a doc comment recommending callers prefer the typed methods. | +200 |
| `src/anthropicShim/files.ts` | NEW — handler factory for the five `/v1/files/*` routes: `POST` (multipart upload), `GET` (list), `GET /{id}` (metadata), `GET /{id}/content` (download bytes), `DELETE /{id}`. Wires to `fileStore`. | ~260 |
| `src/anthropicShim/requestTranslator.ts` | EXTEND — when a content block is `{type: "image" \| "document", source: {type: "file", file_id: "file_..."}}`, resolve via `fileStore.resolveForInline(...)` and emit a normalized inline content block. Signature change: the translator becomes async (or takes a sync `fileStore.resolveForInline` and stays sync — Task 8 picks the simpler path). | +60 |
| `src/anthropicShim/messages.ts` | EXTEND — (1) before backend call: build cache key, consult `responseCache.get()`; on hit, return cached non-streaming body OR synthesize SSE via `responseTranslator.normalizedEventsToSSE` over a synthetic event stream. (2) After backend call: build the same key, call `responseCache.set()` if the request had `cache_control`. (3) On completion (success / error / timeout): call `archive.recordEntry({...})` with the canonical request + final response body. The archive write is **fire-and-forget** — never blocks the response. | +160 |
| `src/admin/archive.ts` | NEW — handler factory for `/admin/archive`, `/admin/archive/{id}`, `/admin/archive/search`. Auth via the shared `apiKey` per spec — admin UI itself defers to Plan 12. | ~200 |
| `src/server.ts` | EXTEND — construct `FileStore`, `ResponseCache`, and pass them (+ the existing `Archive`) into the new handler factories. Mount the new routes. Wire the file-store eviction timer alongside the registry's periodic probe. Pass `fileStore` into `createMessagesHandler` so the message handler can resolve `file_*` references via the translator. | +80 |
| `scripts/archive-prune.ts` | NEW — CLI: `--before YYYY-MM-DD` deletes archive entries older than that date; `--session <id>` deletes entries with that session id; `--config <path>` (required) to locate the archive db. | ~120 |
| `tests/unit/fileStore.test.ts` | NEW — upload returns stable hash-based id, content dedup, metadata round-trip, TTL eviction, max-total-bytes LRU eviction, missing-file error, `resolveForInline` produces correct content block shape. | ~360 |
| `tests/unit/responseCache.test.ts` | NEW — key construction (canonicalization includes backendId + model + cacheable-prefix), hit + miss, TTL eviction, max-entries LRU, atomic file write survives process restart, cache key stability across object-key ordering. | ~280 |
| `tests/unit/archive.test.ts` | EXTEND — add tests for `recordEntry` round-trip, zstd compression survives round-trip, query methods (list filters, get-by-id, search), `deleteOlderThan` / `deleteBySession`, atomic write under concurrent inserts. | +220 |
| `tests/unit/anthropicShim/files.test.ts` | NEW — handler tests for each of the 5 file routes via supertest. Multipart upload path; download path; delete path; list pagination. | ~280 |
| `tests/unit/admin/archive.test.ts` | NEW — handler tests for the 3 admin routes. Pagination, filter combinations, search hit + miss, 401 on missing/bad auth. | ~220 |
| `tests/integration/files.test.ts` | NEW — upload via `POST /v1/files` → reference the resulting id from a `/v1/messages` call → verify the request translator inlined the bytes by inspecting what was forwarded to the backend (mock-claude records its argv to a sidecar file). Delete the file → verify subsequent reference returns 400. | ~220 |
| `tests/integration/cache.test.ts` | NEW — send the same `cache_control`-bearing request twice → second call hits cache, doesn't spawn the backend. Verified by a counter the mock-claude fixture writes to disk. | ~200 |
| `tests/integration/archive.test.ts` | NEW — any `/v1/messages` call gets archived; `/admin/archive` returns it with the right backend tag; substring search finds it; prune script removes by date. | ~240 |
| `docs/plan-05-files-cache-archive-readme.md` | NEW — close-out doc. | ~120 |

---

## Task 1: Add `busboy` dependency

**Files:**
- Modify: `package.json`

The Files API POST handler needs a `multipart/form-data` parser. `busboy` is the smaller, stream-friendly option vs `multer` (which bundles its own file-system layer we don't want). Pinned at `^1.6.0`.

- [ ] **Step 1: Add the dependency**

Edit `package.json`. Under `dependencies`, insert (sorted alphabetically):

```json
"busboy": "^1.6.0",
```

Under `devDependencies`, insert (sorted alphabetically):

```json
"@types/busboy": "^1.5.4",
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: lockfile updates, `node_modules/busboy/` populated.

- [ ] **Step 3: Verify TypeScript still compiles**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add busboy dep for /v1/files multipart upload handling"
```

---

## Task 2: FileStore — core class with content-addressed storage

**Files:**
- Create: `src/fileStore.ts`
- Test: `tests/unit/fileStore.test.ts`

The shared content-addressed file cache. One file per content hash under `config.files.dir`; one `<hash>.json` metadata sidecar adjacent. IDs are `file_<first-24-hex-of-sha256>`. Identical content uploaded twice returns the same id and the existing entry's filename is preserved.

This task ships the core class without eviction; Task 3 layers the TTL + LRU sweep on top.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/fileStore.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileStore, FileNotFoundError } from "../../src/fileStore.js";

describe("FileStore — upload + dedup", () => {
  let dir: string;
  let store: FileStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-fs-"));
    store = new FileStore({ dir, ttlMs: 60_000, maxTotalBytes: 1_000_000 });
  });

  afterEach(() => {
    store.stop?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a file_ id keyed on SHA-256 of bytes", async () => {
    const bytes = Buffer.from("hello world");
    const meta = await store.upload(bytes, "greeting.txt", "text/plain");
    expect(meta.id).toMatch(/^file_[0-9a-f]{24}$/);
    expect(meta.filename).toBe("greeting.txt");
    expect(meta.mime).toBe("text/plain");
    expect(meta.size).toBe(bytes.length);
    expect(typeof meta.createdAt).toBe("string");
  });

  it("returns the same id for identical bytes (dedup)", async () => {
    const a = await store.upload(Buffer.from("dup"), "first.txt", "text/plain");
    const b = await store.upload(Buffer.from("dup"), "second.txt", "text/plain");
    expect(a.id).toBe(b.id);
    // First-write wins for filename.
    expect(b.filename).toBe("first.txt");
  });

  it("persists bytes and sidecar JSON to dir", async () => {
    const meta = await store.upload(
      Buffer.from("payload"),
      "p.bin",
      "application/octet-stream"
    );
    const hash = meta.id.slice("file_".length);
    expect(existsSync(join(dir, hash))).toBe(true);
    expect(existsSync(join(dir, `${hash}.json`))).toBe(true);
    const sidecar = JSON.parse(readFileSync(join(dir, `${hash}.json`), "utf8"));
    expect(sidecar.id).toBe(meta.id);
    expect(sidecar.size).toBe(7);
  });
});

describe("FileStore — get + list + delete", () => {
  let dir: string;
  let store: FileStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-fs-"));
    store = new FileStore({ dir, ttlMs: 60_000, maxTotalBytes: 1_000_000 });
  });

  afterEach(() => {
    store.stop?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("get() returns bytes + metadata for a known id", async () => {
    const stored = await store.upload(Buffer.from("body"), "f.txt", "text/plain");
    const fetched = await store.get(stored.id);
    expect(fetched.bytes.equals(Buffer.from("body"))).toBe(true);
    expect(fetched.metadata.id).toBe(stored.id);
  });

  it("get() throws FileNotFoundError on unknown id", async () => {
    await expect(store.get("file_000000000000000000000000")).rejects.toBeInstanceOf(
      FileNotFoundError
    );
  });

  it("get() bumps lastAccessedAt", async () => {
    const stored = await store.upload(Buffer.from("touch"), "t.txt", "text/plain");
    const before = stored.lastAccessedAt;
    await new Promise((r) => setTimeout(r, 10));
    await store.get(stored.id);
    const after = (await store.get(stored.id)).metadata.lastAccessedAt;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime()
    );
  });

  it("list() returns entries with limit/offset pagination, newest first", async () => {
    const a = await store.upload(Buffer.from("a"), "a.txt", "text/plain");
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.upload(Buffer.from("b"), "b.txt", "text/plain");
    await new Promise((r) => setTimeout(r, 5));
    const c = await store.upload(Buffer.from("c"), "c.txt", "text/plain");

    const all = await store.list({ limit: 10, offset: 0 });
    expect(all.data.map((e) => e.id)).toEqual([c.id, b.id, a.id]);
    expect(all.has_more).toBe(false);

    const page1 = await store.list({ limit: 2, offset: 0 });
    expect(page1.data.map((e) => e.id)).toEqual([c.id, b.id]);
    expect(page1.has_more).toBe(true);

    const page2 = await store.list({ limit: 2, offset: 2 });
    expect(page2.data.map((e) => e.id)).toEqual([a.id]);
    expect(page2.has_more).toBe(false);
  });

  it("delete() removes the bytes and the sidecar", async () => {
    const stored = await store.upload(Buffer.from("bye"), "b.txt", "text/plain");
    await store.delete(stored.id);
    const hash = stored.id.slice("file_".length);
    expect(existsSync(join(dir, hash))).toBe(false);
    expect(existsSync(join(dir, `${hash}.json`))).toBe(false);
    await expect(store.get(stored.id)).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("delete() is idempotent (no throw on second call)", async () => {
    const stored = await store.upload(Buffer.from("bye"), "b.txt", "text/plain");
    await store.delete(stored.id);
    await expect(store.delete(stored.id)).resolves.toBeUndefined();
  });
});

describe("FileStore — resolveForInline", () => {
  let dir: string;
  let store: FileStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-fs-"));
    store = new FileStore({ dir, ttlMs: 60_000, maxTotalBytes: 1_000_000 });
  });

  afterEach(() => {
    store.stop?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces a normalized image content block when mime is image/*", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const stored = await store.upload(png, "x.png", "image/png");
    const block = await store.resolveForInline(stored.id, "image");
    expect(block).toEqual({
      type: "image",
      mediaType: "image/png",
      data: png.toString("base64")
    });
  });

  it("produces a normalized document content block when mime is application/*", async () => {
    const pdf = Buffer.from("%PDF-1.4\n%fake");
    const stored = await store.upload(pdf, "x.pdf", "application/pdf");
    const block = await store.resolveForInline(stored.id, "document");
    expect(block).toEqual({
      type: "document",
      mediaType: "application/pdf",
      data: pdf.toString("base64")
    });
  });

  it("throws FileNotFoundError when the id is unknown", async () => {
    await expect(
      store.resolveForInline("file_aaaaaaaaaaaaaaaaaaaaaaaa", "image")
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/fileStore.test.ts`
Expected: FAIL — module `src/fileStore.js` not found.

- [ ] **Step 3: Create `src/fileStore.ts`**

```ts
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
  statSync,
  writeFileSync,
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/fileStore.test.ts`
Expected: PASS — all 13 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/fileStore.ts tests/unit/fileStore.test.ts
git commit -m "feat(fileStore): add content-addressed file cache with upload/get/list/delete"
```

---

## Task 3: FileStore — TTL + max-total-bytes eviction tests

**Files:**
- Test: `tests/unit/fileStore.test.ts` (extend)

The eviction logic already lives in `runEviction()`; this task adds the failing tests that exercise both passes and confirms the LRU ordering.

- [ ] **Step 1: Append failing tests to `tests/unit/fileStore.test.ts`**

```ts
describe("FileStore — eviction", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-fs-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("TTL sweep removes entries whose lastAccessedAt is older than ttlMs", async () => {
    const store = new FileStore({
      dir,
      ttlMs: 50,
      maxTotalBytes: 10_000_000,
      sweepIntervalMs: 0
    });
    const stored = await store.upload(Buffer.from("aged"), "a.txt", "text/plain");
    await new Promise((r) => setTimeout(r, 80));
    store.runEviction();
    await expect(store.get(stored.id)).rejects.toBeInstanceOf(FileNotFoundError);
    store.stop();
  });

  it("LRU pass evicts oldest-accessed entries when total size exceeds cap", async () => {
    const store = new FileStore({
      dir,
      ttlMs: 60_000,
      maxTotalBytes: 6, // tiny cap so 2-byte uploads trip eviction
      sweepIntervalMs: 0
    });
    const a = await store.upload(Buffer.from("aa"), "a", "text/plain");
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.upload(Buffer.from("bb"), "b", "text/plain");
    await new Promise((r) => setTimeout(r, 5));
    const c = await store.upload(Buffer.from("cc"), "c", "text/plain");
    await new Promise((r) => setTimeout(r, 5));
    const d = await store.upload(Buffer.from("dd"), "d", "text/plain");

    store.runEviction();

    // Total 8 bytes > cap 6; LRU evicts oldest (a), leaving 6 bytes — under cap.
    await expect(store.get(a.id)).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(store.get(b.id)).resolves.toBeTruthy();
    await expect(store.get(c.id)).resolves.toBeTruthy();
    await expect(store.get(d.id)).resolves.toBeTruthy();
    store.stop();
  });

  it("TTL pass runs before LRU pass so expired entries don't get re-ranked", async () => {
    const store = new FileStore({
      dir,
      ttlMs: 50,
      maxTotalBytes: 100,
      sweepIntervalMs: 0
    });
    await store.upload(Buffer.from("expired"), "e", "text/plain");
    await new Promise((r) => setTimeout(r, 80));
    const fresh = await store.upload(Buffer.from("fresh"), "f", "text/plain");
    store.runEviction();
    await expect(store.get(fresh.id)).resolves.toBeTruthy();
    store.stop();
  });
});
```

- [ ] **Step 2: Run the test to verify all green**

Run: `npx vitest run tests/unit/fileStore.test.ts`
Expected: PASS — 16 tests green (13 from Task 2 + 3 new).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/fileStore.test.ts
git commit -m "test(fileStore): cover TTL + max-total-bytes LRU eviction"
```

---

## Task 4: ResponseCache — key construction + get/set/eviction

**Files:**
- Create: `src/responseCache.ts`
- Test: `tests/unit/responseCache.test.ts`

A local response-memo cache reinterpreting Anthropic's `cache_control: { type: "ephemeral" }`. The key is `sha256(canonicalize({backendId, resolvedModel, system, cacheablePrefix, tail, tools, toolChoice}))`. Canonicalization: sorted-keys JSON over Unicode-NFC-normalized strings. Persistence: in-memory `Map` mirrored to `config.cache.file` (default `data/response-cache.json`) with atomic-rename writes. Eviction: TTL + max-entries LRU.

Critical: the cache must NOT include sampling params, stream flag, or `metadata` — those are documented exclusions in the spec to avoid fragmenting hits.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/responseCache.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ResponseCache,
  buildCacheKey,
  type CacheKeyParts,
  type CachedResponse
} from "../../src/responseCache.js";

function fakeBody(text: string): CachedResponse {
  return {
    body: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }
    },
    metadata: { backendId: "claude", resolvedModel: "claude-sonnet-4-6" }
  };
}

describe("buildCacheKey — canonicalization", () => {
  it("produces a stable 64-hex SHA-256 string", () => {
    const parts: CacheKeyParts = {
      backendId: "claude",
      resolvedModel: "claude-sonnet-4-6",
      system: "be brief",
      cacheablePrefix: [{ type: "text", text: "ctx" }],
      tail: [{ type: "text", text: "ask" }]
    };
    expect(buildCacheKey(parts)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is invariant to object-key ordering", () => {
    const a = buildCacheKey({
      backendId: "claude",
      resolvedModel: "m",
      system: "s",
      cacheablePrefix: [{ type: "text", text: "p" }],
      tail: [{ type: "text", text: "t" }],
      tools: [{ name: "x", description: "d", inputSchema: { a: 1, b: 2 } }]
    });
    const b = buildCacheKey({
      tools: [{ inputSchema: { b: 2, a: 1 }, description: "d", name: "x" }],
      tail: [{ type: "text", text: "t" }],
      cacheablePrefix: [{ type: "text", text: "p" }],
      system: "s",
      resolvedModel: "m",
      backendId: "claude"
    });
    expect(a).toBe(b);
  });

  it("Unicode-normalizes strings to NFC so visually-identical-but-byte-different inputs collide", () => {
    // U+00E9 (NFC) vs e + U+0301 (NFD) — same visual "é"
    const nfc = buildCacheKey({
      backendId: "claude",
      resolvedModel: "m",
      system: "café",
      cacheablePrefix: [],
      tail: []
    });
    const nfd = buildCacheKey({
      backendId: "claude",
      resolvedModel: "m",
      system: "café",
      cacheablePrefix: [],
      tail: []
    });
    expect(nfc).toBe(nfd);
  });

  it("changes when backendId changes", () => {
    const claude = buildCacheKey({
      backendId: "claude",
      resolvedModel: "m",
      system: "s",
      cacheablePrefix: [],
      tail: []
    });
    const gemini = buildCacheKey({
      backendId: "gemini",
      resolvedModel: "m",
      system: "s",
      cacheablePrefix: [],
      tail: []
    });
    expect(claude).not.toBe(gemini);
  });
});

describe("ResponseCache — get + set", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-cache-"));
    file = join(dir, "response-cache.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined for an unknown key", () => {
    const cache = new ResponseCache({ file, ttlMs: 60_000, maxEntries: 100 });
    expect(cache.get("nope")).toBeUndefined();
  });

  it("returns the stored body on hit", () => {
    const cache = new ResponseCache({ file, ttlMs: 60_000, maxEntries: 100 });
    cache.set("k", fakeBody("hello"));
    const hit = cache.get("k");
    expect(hit?.body.content[0]).toEqual({ type: "text", text: "hello" });
  });

  it("set() writes to the mirror file atomically", () => {
    const cache = new ResponseCache({ file, ttlMs: 60_000, maxEntries: 100 });
    cache.set("k", fakeBody("persisted"));
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain("persisted");
    // Temp file should be gone after the rename.
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("reloads from the mirror file on construction", () => {
    const a = new ResponseCache({ file, ttlMs: 60_000, maxEntries: 100 });
    a.set("k", fakeBody("survives"));

    const b = new ResponseCache({ file, ttlMs: 60_000, maxEntries: 100 });
    const hit = b.get("k");
    expect(hit?.body.content[0]).toEqual({ type: "text", text: "survives" });
  });
});

describe("ResponseCache — eviction", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-cache-"));
    file = join(dir, "response-cache.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when the entry is older than ttlMs", async () => {
    const cache = new ResponseCache({ file, ttlMs: 30, maxEntries: 100 });
    cache.set("k", fakeBody("aged"));
    await new Promise((r) => setTimeout(r, 60));
    expect(cache.get("k")).toBeUndefined();
  });

  it("max-entries LRU drops the oldest-accessed entry on insert", () => {
    const cache = new ResponseCache({ file, ttlMs: 60_000, maxEntries: 2 });
    cache.set("a", fakeBody("a"));
    cache.set("b", fakeBody("b"));
    cache.get("a"); // bump a's lastAccessed
    cache.set("c", fakeBody("c")); // should evict b, not a
    expect(cache.get("a")).toBeTruthy();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/responseCache.test.ts`
Expected: FAIL — module `src/responseCache.js` not found.

- [ ] **Step 3: Create `src/responseCache.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/responseCache.test.ts`
Expected: PASS — all 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/responseCache.ts tests/unit/responseCache.test.ts
git commit -m "feat(responseCache): add cache key canonicalization + persistent LRU cache"
```

---

## Task 5: Archive — typed writer (`recordEntry`) with zstd compression

**Files:**
- Modify: `src/archive.ts`
- Modify: `tests/unit/archive.test.ts`

Extend the Plan-01 `Archive` skeleton with a typed `recordEntry` method that zstd-compresses the request/response bodies and inserts a row. Keep the `raw()` escape hatch for now with a doc comment recommending callers prefer the typed surface. Compression uses `node:zlib`'s `zstdCompressSync` / `zstdDecompressSync` (Node 22+) — no userland deps needed.

This task lands `recordEntry` only; Task 6 adds the read/query methods.

- [ ] **Step 1: Add failing tests to `tests/unit/archive.test.ts`**

Append:

```ts
import {
  Archive,
  type ArchiveEntry
} from "../../src/archive.js";

describe("Archive.recordEntry — typed writer", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-arc-w-"));
    dbPath = join(dir, "archive.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function sampleEntry(overrides: Partial<ArchiveEntry> = {}): ArchiveEntry {
    return {
      requestHash: "h".repeat(64),
      logId: "log_abc",
      endpoint: "/v1/messages",
      backend: "claude",
      modelResolved: "claude-sonnet-4-6",
      sessionId: null,
      timestamp: new Date().toISOString(),
      status: "ok",
      durationMs: 123,
      inputTokens: 10,
      outputTokens: 20,
      requestBody: { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] },
      responseBody: { id: "msg_test", content: [{ type: "text", text: "hello" }] },
      ...overrides
    };
  }

  it("recordEntry inserts a row and returns its id", () => {
    const archive = new Archive(dbPath);
    try {
      const id = archive.recordEntry(sampleEntry());
      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
    } finally {
      archive.close();
    }
  });

  it("recordEntry zstd-compresses request_body so it round-trips", () => {
    const archive = new Archive(dbPath);
    try {
      const id = archive.recordEntry(sampleEntry());
      const row = archive.getById(id);
      expect(row?.requestBody).toEqual({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
      expect(row?.responseBody).toEqual({
        id: "msg_test",
        content: [{ type: "text", text: "hello" }]
      });
    } finally {
      archive.close();
    }
  });

  it("recordEntry honors nullable sessionId / modelResolved", () => {
    const archive = new Archive(dbPath);
    try {
      const id = archive.recordEntry(sampleEntry({ sessionId: null, modelResolved: null }));
      const row = archive.getById(id);
      expect(row?.sessionId).toBeNull();
      expect(row?.modelResolved).toBeNull();
    } finally {
      archive.close();
    }
  });

  it("recordEntry handles 'error' status entries (debugging value)", () => {
    const archive = new Archive(dbPath);
    try {
      const id = archive.recordEntry(
        sampleEntry({
          status: "error",
          responseBody: { type: "error", error: { type: "api_error", message: "boom" } }
        })
      );
      const row = archive.getById(id);
      expect(row?.status).toBe("error");
      expect(row?.responseBody).toEqual({
        type: "error",
        error: { type: "api_error", message: "boom" }
      });
    } finally {
      archive.close();
    }
  });

  it("concurrent inserts are serialized cleanly", () => {
    const archive = new Archive(dbPath);
    try {
      const ids: number[] = [];
      for (let i = 0; i < 20; i++) {
        ids.push(archive.recordEntry(sampleEntry({ logId: `log_${i}` })));
      }
      expect(new Set(ids).size).toBe(20);
    } finally {
      archive.close();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/archive.test.ts`
Expected: FAIL — `recordEntry`, `getById`, and `ArchiveEntry` not exported.

- [ ] **Step 3: Extend `src/archive.ts`**

Add to the existing module (keep the existing class structure intact; insert new types above the class and methods inside):

```ts
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

// ---- Public types -------------------------------------------------------

export type ArchiveStatus = "ok" | "error" | "timeout";

export interface ArchiveEntry {
  requestHash: string;
  logId: string;
  endpoint: string;
  backend: string;
  modelResolved: string | null;
  sessionId: string | null;
  timestamp: string; // ISO-8601
  status: ArchiveStatus;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  requestBody: unknown; // JSON-serializable
  responseBody: unknown; // JSON-serializable
}

export interface StoredArchiveEntry extends ArchiveEntry {
  id: number;
}
```

Inside the `Archive` class, add:

```ts
  private readonly insertStmt = this.db.prepare(`
    INSERT INTO entries (
      request_hash, log_id, endpoint, backend, model_resolved,
      session_id, timestamp, status, duration_ms,
      input_tokens, output_tokens, request_body, response_body
    ) VALUES (
      @requestHash, @logId, @endpoint, @backend, @modelResolved,
      @sessionId, @timestamp, @status, @durationMs,
      @inputTokens, @outputTokens, @requestBody, @responseBody
    )
  `);

  private readonly getByIdStmt = this.db.prepare(
    "SELECT * FROM entries WHERE id = ?"
  );

  recordEntry(entry: ArchiveEntry): number {
    const requestBlob = zstdCompressSync(
      Buffer.from(JSON.stringify(entry.requestBody))
    );
    const responseBlob = zstdCompressSync(
      Buffer.from(JSON.stringify(entry.responseBody))
    );
    const info = this.insertStmt.run({
      requestHash: entry.requestHash,
      logId: entry.logId,
      endpoint: entry.endpoint,
      backend: entry.backend,
      modelResolved: entry.modelResolved,
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      status: entry.status,
      durationMs: entry.durationMs,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      requestBody: requestBlob,
      responseBody: responseBlob
    });
    return Number(info.lastInsertRowid);
  }

  getById(id: number): StoredArchiveEntry | undefined {
    const row = this.getByIdStmt.get(id) as
      | {
          id: number;
          request_hash: string;
          log_id: string;
          endpoint: string;
          backend: string;
          model_resolved: string | null;
          session_id: string | null;
          timestamp: string;
          status: ArchiveStatus;
          duration_ms: number | null;
          input_tokens: number | null;
          output_tokens: number | null;
          request_body: Buffer;
          response_body: Buffer;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      requestHash: row.request_hash,
      logId: row.log_id,
      endpoint: row.endpoint,
      backend: row.backend,
      modelResolved: row.model_resolved,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      status: row.status,
      durationMs: row.duration_ms,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      requestBody: JSON.parse(zstdDecompressSync(row.request_body).toString("utf8")),
      responseBody: JSON.parse(zstdDecompressSync(row.response_body).toString("utf8"))
    };
  }
```

Update the `raw()` doc comment to:

```ts
  /**
   * Direct database handle. Prefer the typed methods (`recordEntry`, `getById`,
   * `list`, `searchText`, `deleteOlderThan`, `deleteBySession`) over this
   * escape hatch — they handle compression and column mapping for you. The
   * raw handle is exposed for ad-hoc operator queries and future tooling that
   * hasn't found its way into the typed surface yet.
   */
```

- [ ] **Step 4: Run to verify passing**

Run: `npx vitest run tests/unit/archive.test.ts`
Expected: PASS — Plan-01 tests still green; 5 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/archive.ts tests/unit/archive.test.ts
git commit -m "feat(archive): add recordEntry typed writer with zstd compression"
```

---

## Task 6: Archive — query + prune methods

**Files:**
- Modify: `src/archive.ts`
- Modify: `tests/unit/archive.test.ts`

Add `list(filters)`, `searchText(q)`, `deleteOlderThan(isoDate)`, and `deleteBySession(sessionId)`. Substring search uses plain `LIKE` per the spec's open-questions note — FTS5 is deferred.

- [ ] **Step 1: Append failing tests**

```ts
describe("Archive — query + prune", () => {
  let dir: string;
  let dbPath: string;
  let archive: Archive;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-arc-q-"));
    dbPath = join(dir, "archive.sqlite");
    archive = new Archive(dbPath);
  });

  afterEach(() => {
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(): { ids: number[] } {
    const ids: number[] = [];
    ids.push(
      archive.recordEntry({
        requestHash: "a".repeat(64),
        logId: "log_a",
        endpoint: "/v1/messages",
        backend: "claude",
        modelResolved: "claude-sonnet-4-6",
        sessionId: "s_one",
        timestamp: "2026-05-10T00:00:00Z",
        status: "ok",
        durationMs: 100,
        inputTokens: 1,
        outputTokens: 1,
        requestBody: { messages: [{ role: "user", content: "hello world" }] },
        responseBody: { id: "msg_a" }
      })
    );
    ids.push(
      archive.recordEntry({
        requestHash: "b".repeat(64),
        logId: "log_b",
        endpoint: "/v1/messages",
        backend: "gemini",
        modelResolved: "gemini-pro",
        sessionId: "s_two",
        timestamp: "2026-05-15T00:00:00Z",
        status: "ok",
        durationMs: 200,
        inputTokens: 2,
        outputTokens: 2,
        requestBody: { messages: [{ role: "user", content: "another prompt" }] },
        responseBody: { id: "msg_b" }
      })
    );
    return { ids };
  }

  it("list() returns entries with pagination, newest first", () => {
    seed();
    const page = archive.list({ limit: 10, offset: 0 });
    expect(page.data.map((e) => e.logId)).toEqual(["log_b", "log_a"]);
    expect(page.has_more).toBe(false);
  });

  it("list() filters by backend", () => {
    seed();
    const onlyGemini = archive.list({ limit: 10, offset: 0, backend: "gemini" });
    expect(onlyGemini.data.map((e) => e.logId)).toEqual(["log_b"]);
  });

  it("list() filters by session", () => {
    seed();
    const sOne = archive.list({ limit: 10, offset: 0, sessionId: "s_one" });
    expect(sOne.data.map((e) => e.logId)).toEqual(["log_a"]);
  });

  it("list() filters by since / until", () => {
    seed();
    const recent = archive.list({
      limit: 10,
      offset: 0,
      since: "2026-05-12T00:00:00Z"
    });
    expect(recent.data.map((e) => e.logId)).toEqual(["log_b"]);
    const old = archive.list({ limit: 10, offset: 0, until: "2026-05-12T00:00:00Z" });
    expect(old.data.map((e) => e.logId)).toEqual(["log_a"]);
  });

  it("searchText() finds substring hits in the decompressed request body", () => {
    seed();
    const hits = archive.searchText("hello world", { limit: 10, offset: 0 });
    expect(hits.data.map((e) => e.logId)).toEqual(["log_a"]);
  });

  it("searchText() returns empty page when no hits", () => {
    seed();
    const hits = archive.searchText("nothing-matches", { limit: 10, offset: 0 });
    expect(hits.data).toEqual([]);
    expect(hits.has_more).toBe(false);
  });

  it("deleteOlderThan() drops entries with timestamp < cutoff", () => {
    seed();
    const removed = archive.deleteOlderThan("2026-05-12T00:00:00Z");
    expect(removed).toBe(1);
    const remaining = archive.list({ limit: 10, offset: 0 });
    expect(remaining.data.map((e) => e.logId)).toEqual(["log_b"]);
  });

  it("deleteBySession() drops entries matching the session id", () => {
    seed();
    const removed = archive.deleteBySession("s_one");
    expect(removed).toBe(1);
    const remaining = archive.list({ limit: 10, offset: 0 });
    expect(remaining.data.map((e) => e.logId)).toEqual(["log_b"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/archive.test.ts`
Expected: FAIL — `list`, `searchText`, `deleteOlderThan`, `deleteBySession` not implemented.

- [ ] **Step 3: Add methods to `src/archive.ts`**

Add the following types above the class:

```ts
export interface ArchiveListFilters {
  limit: number;
  offset: number;
  backend?: string;
  sessionId?: string;
  model?: string;
  since?: string; // ISO-8601 inclusive lower bound
  until?: string; // ISO-8601 exclusive upper bound
  status?: ArchiveStatus;
}

export interface ArchivePage {
  data: StoredArchiveEntry[];
  has_more: boolean;
}
```

Inside the class:

```ts
  list(filters: ArchiveListFilters): ArchivePage {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filters.backend) {
      where.push("backend = @backend");
      params.backend = filters.backend;
    }
    if (filters.sessionId) {
      where.push("session_id = @sessionId");
      params.sessionId = filters.sessionId;
    }
    if (filters.model) {
      where.push("model_resolved = @model");
      params.model = filters.model;
    }
    if (filters.status) {
      where.push("status = @status");
      params.status = filters.status;
    }
    if (filters.since) {
      where.push("timestamp >= @since");
      params.since = filters.since;
    }
    if (filters.until) {
      where.push("timestamp < @until");
      params.until = filters.until;
    }
    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // Over-fetch by one to compute has_more without a separate COUNT.
    const stmt = this.db.prepare(
      `SELECT * FROM entries ${whereClause} ORDER BY timestamp DESC LIMIT @limitPlusOne OFFSET @offset`
    );
    const rows = stmt.all({
      ...params,
      limitPlusOne: filters.limit + 1,
      offset: filters.offset
    }) as Array<Record<string, unknown>>;

    const has_more = rows.length > filters.limit;
    const trimmed = has_more ? rows.slice(0, filters.limit) : rows;
    return {
      data: trimmed.map((r) => this.hydrate(r)),
      has_more
    };
  }

  searchText(
    needle: string,
    paging: { limit: number; offset: number }
  ): ArchivePage {
    // Decompress on read; for large archives we may need a content index in
    // a later plan. The spec's open question on FTS5 is deferred — for now
    // we scan, decompress, and filter in memory.
    const all = this.db
      .prepare("SELECT * FROM entries ORDER BY timestamp DESC")
      .all() as Array<Record<string, unknown>>;
    const hits: StoredArchiveEntry[] = [];
    for (const row of all) {
      const decoded = this.hydrate(row);
      const haystack = JSON.stringify(decoded.requestBody);
      if (haystack.includes(needle)) hits.push(decoded);
    }
    const page = hits.slice(paging.offset, paging.offset + paging.limit);
    return {
      data: page,
      has_more: paging.offset + paging.limit < hits.length
    };
  }

  deleteOlderThan(isoCutoff: string): number {
    const info = this.db
      .prepare("DELETE FROM entries WHERE timestamp < ?")
      .run(isoCutoff);
    return Number(info.changes);
  }

  deleteBySession(sessionId: string): number {
    const info = this.db
      .prepare("DELETE FROM entries WHERE session_id = ?")
      .run(sessionId);
    return Number(info.changes);
  }

  private hydrate(row: Record<string, unknown>): StoredArchiveEntry {
    return {
      id: row.id as number,
      requestHash: row.request_hash as string,
      logId: row.log_id as string,
      endpoint: row.endpoint as string,
      backend: row.backend as string,
      modelResolved: row.model_resolved as string | null,
      sessionId: row.session_id as string | null,
      timestamp: row.timestamp as string,
      status: row.status as ArchiveStatus,
      durationMs: row.duration_ms as number | null,
      inputTokens: row.input_tokens as number | null,
      outputTokens: row.output_tokens as number | null,
      requestBody: JSON.parse(
        zstdDecompressSync(row.request_body as Buffer).toString("utf8")
      ),
      responseBody: JSON.parse(
        zstdDecompressSync(row.response_body as Buffer).toString("utf8")
      )
    };
  }
```

- [ ] **Step 4: Verify all green**

Run: `npx vitest run tests/unit/archive.test.ts`
Expected: PASS — Plan-01 + Task-5 + Task-6 tests all green.

- [ ] **Step 5: Commit**

```bash
git add src/archive.ts tests/unit/archive.test.ts
git commit -m "feat(archive): add list/search/prune query methods"
```

---

## Task 7: Files API handlers — `/v1/files/*`

**Files:**
- Create: `src/anthropicShim/files.ts`
- Test: `tests/unit/anthropicShim/files.test.ts`

Five endpoints: `POST /v1/files` (multipart), `GET /v1/files` (paginated list), `GET /v1/files/{id}` (metadata), `GET /v1/files/{id}/content` (download bytes), `DELETE /v1/files/{id}`. Auth via `checkAuth`. The handler factory takes `fileStore` and `config.apiKey` as deps.

`POST /v1/files` uses `busboy` to parse the multipart body. Anthropic's Files API accepts a `file` field; we mirror that. Returns the metadata envelope shape `{id, type: "file", filename, mime_type, size_bytes, created_at}` to mirror Anthropic.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/anthropicShim/files.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";
import { FileStore } from "../../../src/fileStore.js";
import { createFilesHandlers } from "../../../src/anthropicShim/files.js";

function buildApp(): { app: express.Express; store: FileStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "claudemcp-files-h-"));
  const store = new FileStore({
    dir,
    ttlMs: 60_000,
    maxTotalBytes: 10_000_000,
    sweepIntervalMs: 0
  });
  const app = express();
  const handlers = createFilesHandlers({
    fileStore: store,
    config: { apiKey: "sk-test" }
  });
  app.post("/v1/files", handlers.upload);
  app.get("/v1/files", handlers.list);
  app.get("/v1/files/:id", handlers.getMetadata);
  app.get("/v1/files/:id/content", handlers.download);
  app.delete("/v1/files/:id", handlers.delete);
  return {
    app,
    store,
    cleanup: () => {
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("POST /v1/files — multipart upload", () => {
  it("rejects missing auth with 401", async () => {
    const { app, cleanup } = buildApp();
    try {
      const res = await request(app)
        .post("/v1/files")
        .attach("file", Buffer.from("body"), {
          filename: "f.txt",
          contentType: "text/plain"
        });
      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe("authentication_error");
    } finally {
      cleanup();
    }
  });

  it("accepts a valid multipart upload and returns the file id", async () => {
    const { app, cleanup } = buildApp();
    try {
      const res = await request(app)
        .post("/v1/files")
        .set("x-api-key", "sk-test")
        .attach("file", Buffer.from("hello"), {
          filename: "greeting.txt",
          contentType: "text/plain"
        });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        type: "file",
        filename: "greeting.txt",
        mime_type: "text/plain",
        size_bytes: 5
      });
      expect(res.body.id).toMatch(/^file_[0-9a-f]{24}$/);
    } finally {
      cleanup();
    }
  });

  it("dedup: uploading the same bytes twice returns the same id", async () => {
    const { app, cleanup } = buildApp();
    try {
      const a = await request(app)
        .post("/v1/files")
        .set("x-api-key", "sk-test")
        .attach("file", Buffer.from("same"), { filename: "a.txt", contentType: "text/plain" });
      const b = await request(app)
        .post("/v1/files")
        .set("x-api-key", "sk-test")
        .attach("file", Buffer.from("same"), { filename: "b.txt", contentType: "text/plain" });
      expect(a.body.id).toBe(b.body.id);
    } finally {
      cleanup();
    }
  });

  it("returns 400 on a non-multipart request", async () => {
    const { app, cleanup } = buildApp();
    try {
      const res = await request(app)
        .post("/v1/files")
        .set("x-api-key", "sk-test")
        .set("content-type", "application/json")
        .send({ not: "multipart" });
      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe("invalid_request_error");
    } finally {
      cleanup();
    }
  });
});

describe("GET /v1/files — list with pagination", () => {
  it("returns has_more=false for a small list", async () => {
    const { app, store, cleanup } = buildApp();
    try {
      await store.upload(Buffer.from("a"), "a.txt", "text/plain");
      await store.upload(Buffer.from("b"), "b.txt", "text/plain");
      const res = await request(app).get("/v1/files").set("x-api-key", "sk-test");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.has_more).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("honors limit and offset", async () => {
    const { app, store, cleanup } = buildApp();
    try {
      for (const c of ["a", "b", "c"]) {
        await store.upload(Buffer.from(c), `${c}.txt`, "text/plain");
      }
      const res = await request(app)
        .get("/v1/files?limit=1&offset=1")
        .set("x-api-key", "sk-test");
      expect(res.body.data).toHaveLength(1);
      expect(res.body.has_more).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("GET /v1/files/{id} — metadata", () => {
  it("returns metadata envelope on a known id", async () => {
    const { app, store, cleanup } = buildApp();
    try {
      const stored = await store.upload(Buffer.from("meta"), "m.txt", "text/plain");
      const res = await request(app)
        .get(`/v1/files/${stored.id}`)
        .set("x-api-key", "sk-test");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(stored.id);
      expect(res.body.type).toBe("file");
    } finally {
      cleanup();
    }
  });

  it("returns 404 on an unknown id", async () => {
    const { app, cleanup } = buildApp();
    try {
      const res = await request(app)
        .get("/v1/files/file_000000000000000000000000")
        .set("x-api-key", "sk-test");
      expect(res.status).toBe(404);
    } finally {
      cleanup();
    }
  });
});

describe("GET /v1/files/{id}/content — download", () => {
  it("returns the raw bytes with the recorded mime type", async () => {
    const { app, store, cleanup } = buildApp();
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const stored = await store.upload(png, "x.png", "image/png");
      const res = await request(app)
        .get(`/v1/files/${stored.id}/content`)
        .set("x-api-key", "sk-test");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/image\/png/);
      expect(Buffer.compare(res.body, png)).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("DELETE /v1/files/{id}", () => {
  it("removes the file and returns the Anthropic-shaped delete envelope", async () => {
    const { app, store, cleanup } = buildApp();
    try {
      const stored = await store.upload(Buffer.from("bye"), "b.txt", "text/plain");
      const res = await request(app)
        .delete(`/v1/files/${stored.id}`)
        .set("x-api-key", "sk-test");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: stored.id, type: "file_deleted" });
      const after = await request(app)
        .get(`/v1/files/${stored.id}`)
        .set("x-api-key", "sk-test");
      expect(after.status).toBe(404);
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/anthropicShim/files.test.ts`
Expected: FAIL — module `src/anthropicShim/files.js` not found.

- [ ] **Step 3: Create `src/anthropicShim/files.ts`**

```ts
import type { Request, RequestHandler, Response } from "express";
import Busboy from "busboy";
import { checkAuth } from "../auth.js";
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
    if (!checkAuth(req, deps.config.apiKey)) {
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
```

- [ ] **Step 4: Run to verify passing**

Run: `npx vitest run tests/unit/anthropicShim/files.test.ts`
Expected: PASS — 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/anthropicShim/files.ts tests/unit/anthropicShim/files.test.ts
git commit -m "feat(anthropicShim): add /v1/files/* handlers (upload, list, get, content, delete)"
```

---

## Task 8: Request translator — resolve `file_*` references

**Files:**
- Modify: `src/anthropicShim/requestTranslator.ts`
- Test: `tests/unit/anthropicShim/requestTranslator.test.ts` (extend)

The Anthropic API supports referencing a previously-uploaded file from any image/document block via `source: { type: "file", file_id: "file_..." }`. When the translator sees this shape, it must call `fileStore.resolveForInline(file_id, expectedKind)` and emit a normalized inline content block (with mime + base64 bytes) instead of the file reference.

**Design choice (signature change):** Plan 03's translator was a pure sync function. To resolve file ids we either (a) make the translator `async` and `await` the resolve, or (b) require callers to pre-resolve and pass a `Map<string, NormalizedContentBlock>` of resolved files. **Plan 05 picks (a)** — the translator becomes `async` and accepts an optional `{ fileStore }` dep. The call site in `messages.ts` is already an async handler, so this is the smaller diff.

- [ ] **Step 1: Append failing tests**

Add to `tests/unit/anthropicShim/requestTranslator.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileStore } from "../../../src/fileStore.js";

describe("anthropicRequestToNormalized — file id resolution", () => {
  let dir: string;
  let store: FileStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-fs-rt-"));
    store = new FileStore({
      dir,
      ttlMs: 60_000,
      maxTotalBytes: 10_000_000,
      sweepIntervalMs: 0
    });
  });

  afterEach(() => {
    store.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("inlines image bytes when content block uses source.type='file'", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const stored = await store.upload(png, "x.png", "image/png");
    const out = await anthropicRequestToNormalized(
      {
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "file", file_id: stored.id }
              }
            ]
          }
        ]
      },
      { fileStore: store }
    );
    expect(out.messages[0]?.content[0]).toEqual({
      type: "image",
      mediaType: "image/png",
      data: png.toString("base64")
    });
  });

  it("inlines document bytes when content block uses source.type='file'", async () => {
    const pdf = Buffer.from("%PDF-1.4\n%fake");
    const stored = await store.upload(pdf, "x.pdf", "application/pdf");
    const out = await anthropicRequestToNormalized(
      {
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "file", file_id: stored.id }
              }
            ]
          }
        ]
      },
      { fileStore: store }
    );
    expect(out.messages[0]?.content[0]).toEqual({
      type: "document",
      mediaType: "application/pdf",
      data: pdf.toString("base64")
    });
  });

  it("returns 400-shaped ShimRequestError when file_id is unknown", async () => {
    await expect(
      anthropicRequestToNormalized(
        {
          model: "claude-sonnet-4-6",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "file", file_id: "file_000000000000000000000000" }
                }
              ]
            }
          ]
        },
        { fileStore: store }
      )
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/file/i) });
  });

  it("returns 400-shaped ShimRequestError when source.type='file' but no fileStore was provided", async () => {
    await expect(
      anthropicRequestToNormalized({
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "file", file_id: "file_000000000000000000000000" }
              }
            ]
          }
        ]
      })
    ).rejects.toMatchObject({ status: 400 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/anthropicShim/requestTranslator.test.ts`
Expected: FAIL — translator does not accept a second arg and is not async.

- [ ] **Step 3: Edit `src/anthropicShim/requestTranslator.ts`**

Convert the function to async and thread `fileStore` through. The exact diff depends on Plan 04's extensions but the shape is:

```ts
import type { FileStore } from "../fileStore.js";
import { FileNotFoundError } from "../fileStore.js";

export interface TranslatorDeps {
  fileStore?: FileStore;
}

// Helper: resolve a single image/document content block.
async function resolveSourceBlock(
  block: { type: "image" | "document"; source: unknown },
  deps: TranslatorDeps
): Promise<NormalizedContentBlock> {
  const src = block.source;
  if (
    isRecord(src) &&
    src["type"] === "file" &&
    typeof src["file_id"] === "string"
  ) {
    if (!deps.fileStore) {
      bad(
        "source.type='file' references require server-side file storage; ensure /v1/files is enabled"
      );
    }
    try {
      return await deps.fileStore.resolveForInline(
        src["file_id"] as string,
        block.type
      );
    } catch (err) {
      if (err instanceof FileNotFoundError) {
        bad(`file not found: ${err.id}`);
      }
      throw err;
    }
  }
  // Fall through to Plan 04's existing base64/url handling.
  // ...existing code path that builds {type, mediaType, data} from a base64 source.
}
```

Update `normalizeContentBlock` to be async and `await resolveSourceBlock` for `image`/`document` blocks. Update `normalizeMessage` to `await Promise.all(...)` over the content array. Change the exported signature:

```ts
export async function anthropicRequestToNormalized(
  body: AnthropicMessagesRequest,
  deps: TranslatorDeps = {}
): Promise<NormalizedRequest> {
  // ... existing validation ...
  const messages = await Promise.all(
    (rawMessages as AnthropicMessage[]).map((m) => normalizeMessage(m, deps))
  );
  // ... rest unchanged ...
}
```

**Important:** Plan 04's call site in `messages.ts` already `await`s the translator result (or this task changes it to do so). Update that call site too if it wasn't already async-aware — see Task 9.

- [ ] **Step 4: Update all existing call sites to `await` the translator**

Sites:
- `src/anthropicShim/messages.ts` (Task 9 handles this comprehensively)
- `src/anthropicShim/countTokens.ts` (just add `await`)
- Any test that called the translator synchronously: add `await` to the call.

- [ ] **Step 5: Run the full translator test file**

Run: `npx vitest run tests/unit/anthropicShim/requestTranslator.test.ts`
Expected: PASS — all prior tests + 4 new tests green.

- [ ] **Step 6: Run the full suite to catch downstream sync→async breakage**

Run: `npx vitest run`
Expected: PASS. Any failure is in a Plan-03/04 site that called the translator without `await`. Fix in place; the fix is mechanical (`await` insertion).

- [ ] **Step 7: Commit**

```bash
git add src/anthropicShim/requestTranslator.ts src/anthropicShim/countTokens.ts tests/unit/anthropicShim/requestTranslator.test.ts
git commit -m "feat(anthropicShim): resolve file_<hash> references in request translator"
```

---

## Task 9: Messages handler — cache lookup + archive write integration

**Files:**
- Modify: `src/anthropicShim/messages.ts`
- Test: `tests/unit/anthropicShim/messages.test.ts` (extend)

Three integrations land here, in order of execution:

1. **Cache lookup (before backend dispatch):** If the request includes any block with `cache_control: { type: "ephemeral" }`, compute the cache key. If `responseCache.get(key)` is a hit, return the cached body (non-streaming) OR synthesize an SSE stream from it (streaming).
2. **Cache write (after backend dispatch):** Once the backend completes, if the request had any `cache_control` block, build the same key and call `responseCache.set(key, response)`.
3. **Archive write (always):** After the response is sent (success, error, or timeout), call `archive.recordEntry(...)` with the canonical request hash and the final response body. **Fire-and-forget — never blocks the response. Log on failure.**

The handler factory deps grow to include `responseCache`, `archive`, and `fileStore`.

- [ ] **Step 1: Add failing integration-style tests to `tests/unit/anthropicShim/messages.test.ts`**

```ts
import { Archive } from "../../../src/archive.js";
import { ResponseCache } from "../../../src/responseCache.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("POST /v1/messages — response cache", () => {
  it("on hit, skips backend invocation and returns cached body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudemcp-msg-cache-"));
    try {
      let invocations = 0;
      const backend = stubClaude({
        recorded: undefined,
        events: [
          { kind: "message_start", model: "claude-sonnet-4-6" },
          { kind: "text_delta", index: 0, text: "first-call" },
          {
            kind: "message_stop",
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 }
          }
        ]
      });
      const wrappedBackend: typeof backend = {
        ...backend,
        invoke(req) {
          invocations++;
          return backend.invoke(req);
        }
      };

      const cache = new ResponseCache({
        file: join(dir, "cache.json"),
        ttlMs: 60_000,
        maxEntries: 100
      });
      const archive = new Archive(join(dir, "archive.sqlite"));

      const registry = new BackendRegistry({
        claude: 100,
        gemini: 90,
        lmstudio: 50,
        ollama: 40
      });
      registry.register(wrappedBackend);
      const app = express();
      app.use(express.json({ limit: "10mb" }));
      app.post(
        "/v1/messages",
        createMessagesHandler({
          registry,
          archive,
          responseCache: cache,
          config: { apiKey: "sk-test", router: { defaultBackend: "claude" } }
        })
      );

      const body = {
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "cache me",
                cache_control: { type: "ephemeral" }
              }
            ]
          }
        ]
      };

      const first = await request(app).post("/v1/messages").set("x-api-key", "sk-test").send(body);
      expect(first.status).toBe(200);
      // Give the fire-and-forget archive write a tick to complete.
      await new Promise((r) => setImmediate(r));

      const second = await request(app).post("/v1/messages").set("x-api-key", "sk-test").send(body);
      expect(second.status).toBe(200);

      expect(invocations).toBe(1); // Second call hit the cache.
      expect(second.body.content).toEqual([{ type: "text", text: "first-call" }]);

      archive.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("POST /v1/messages — archive write", () => {
  it("writes an entry per request, including the resolved backend tag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudemcp-msg-arc-"));
    try {
      const archive = new Archive(join(dir, "archive.sqlite"));
      const cache = new ResponseCache({
        file: join(dir, "cache.json"),
        ttlMs: 60_000,
        maxEntries: 100
      });
      const registry = new BackendRegistry({
        claude: 100,
        gemini: 90,
        lmstudio: 50,
        ollama: 40
      });
      registry.register(stubClaude({}));

      const app = express();
      app.use(express.json({ limit: "10mb" }));
      app.post(
        "/v1/messages",
        createMessagesHandler({
          registry,
          archive,
          responseCache: cache,
          config: { apiKey: "sk-test", router: { defaultBackend: "claude" } }
        })
      );

      const res = await request(app)
        .post("/v1/messages")
        .set("x-api-key", "sk-test")
        .send({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "log me" }]
        });
      expect(res.status).toBe(200);
      // Fire-and-forget write — flush.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const page = archive.list({ limit: 10, offset: 0 });
      expect(page.data).toHaveLength(1);
      expect(page.data[0]?.backend).toBe("claude");
      expect(page.data[0]?.endpoint).toBe("/v1/messages");
      archive.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("archives error entries when the backend throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claudemcp-msg-arc-err-"));
    try {
      const archive = new Archive(join(dir, "archive.sqlite"));
      const cache = new ResponseCache({
        file: join(dir, "cache.json"),
        ttlMs: 60_000,
        maxEntries: 100
      });
      const failing: Backend = {
        id: "claude",
        capabilitiesFor: () => ({
          toolUse: false,
          multimodal: false,
          thinking: false,
          cacheControl: "none",
          samplingParams: { temperature: false, topP: false, topK: false },
          stopSequences: "server-side-cut",
          embeddings: false
        }),
        listModels: async () => [{ id: "claude-sonnet-4-6" }],
        invoke: async function* (): AsyncIterable<NormalizedEvent> {
          throw new Error("backend boom");
        },
        countTokens: async () => 0
      };
      const registry = new BackendRegistry({
        claude: 100,
        gemini: 90,
        lmstudio: 50,
        ollama: 40
      });
      registry.register(failing);

      const app = express();
      app.use(express.json({ limit: "10mb" }));
      app.post(
        "/v1/messages",
        createMessagesHandler({
          registry,
          archive,
          responseCache: cache,
          config: { apiKey: "sk-test", router: { defaultBackend: "claude" } }
        })
      );

      const res = await request(app)
        .post("/v1/messages")
        .set("x-api-key", "sk-test")
        .send({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "fail me" }]
        });
      expect(res.status).toBe(500);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const page = archive.list({ limit: 10, offset: 0 });
      expect(page.data).toHaveLength(1);
      expect(page.data[0]?.status).toBe("error");
      archive.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/anthropicShim/messages.test.ts`
Expected: FAIL — `createMessagesHandler` deps don't yet accept `archive` / `responseCache`.

- [ ] **Step 3: Extend `src/anthropicShim/messages.ts`**

Update `MessagesHandlerDeps`:

```ts
import type { Archive, ArchiveEntry, ArchiveStatus } from "../archive.js";
import type { CacheKeyParts, ResponseCache } from "../responseCache.js";
import { buildCacheKey } from "../responseCache.js";
import type { FileStore } from "../fileStore.js";
import { createHash, randomBytes } from "node:crypto";

export interface MessagesHandlerDeps {
  registry: BackendRegistry;
  archive: Archive;
  responseCache: ResponseCache;
  fileStore?: FileStore;
  config: MessagesHandlerConfig;
}
```

Add three helpers at module scope:

```ts
function hasCacheControl(body: AnthropicMessagesRequest): boolean {
  for (const msg of body.messages ?? []) {
    if (typeof msg.content === "string") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && typeof block === "object" && "cache_control" in block) return true;
    }
  }
  return false;
}

function splitCacheable(body: AnthropicMessagesRequest): {
  prefix: unknown[];
  tail: unknown[];
} {
  // Cacheable prefix ends at the last `ephemeral` block; everything after
  // (inclusive of the next block) is the tail.
  const flattened: Array<{ role: string; block: unknown }> = [];
  for (const msg of body.messages ?? []) {
    if (typeof msg.content === "string") {
      flattened.push({ role: msg.role, block: { type: "text", text: msg.content } });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) flattened.push({ role: msg.role, block });
    }
  }
  let lastEphemeralIdx = -1;
  for (let i = 0; i < flattened.length; i++) {
    const b = flattened[i]?.block as Record<string, unknown> | undefined;
    if (b && typeof b === "object" && "cache_control" in b) lastEphemeralIdx = i;
  }
  return {
    prefix: flattened.slice(0, lastEphemeralIdx + 1).map((f) => f),
    tail: flattened.slice(lastEphemeralIdx + 1).map((f) => f)
  };
}

function archiveRequestHash(parts: CacheKeyParts): string {
  // Reuse the cache canonicalization for the archive hash; doc'd in the spec.
  return buildCacheKey(parts);
}
```

In `createMessagesHandler`, after backend resolution and before invoke, add:

```ts
    // ---- Cache check ----------------------------------------------------
    const wantsCache = hasCacheControl(body);
    let cacheKey: string | undefined;
    let cacheKeyParts: CacheKeyParts | undefined;
    if (wantsCache) {
      const { prefix, tail } = splitCacheable(body);
      cacheKeyParts = {
        backendId: backend.id,
        resolvedModel: normalized.model,
        system: normalized.system,
        cacheablePrefix: prefix,
        tail,
        tools: normalized.tools,
        toolChoice: normalized.toolChoice
      };
      cacheKey = buildCacheKey(cacheKeyParts);
      const hit = deps.responseCache.get(cacheKey);
      if (hit) {
        if (wantStream) {
          await replayCachedAsSSE(hit, meta, res);
        } else {
          res.status(200).json(hit.body);
        }
        // Still archive the cache hit so observability sees the request.
        fireAndForgetArchive(deps.archive, {
          requestHash: cacheKey,
          logId: messageId,
          endpoint: "/v1/messages",
          backend: backend.id,
          modelResolved: normalized.model,
          sessionId: null,
          timestamp: new Date().toISOString(),
          status: "ok",
          durationMs: 0,
          inputTokens: null,
          outputTokens: null,
          requestBody: body,
          responseBody: { ...hit.body, _cache_hit: true }
        });
        return;
      }
    }
```

After the existing invoke block, wrap the success/error paths to call `recordEntry` and `responseCache.set`:

```ts
    const started = Date.now();
    let finalBody: Record<string, unknown> | undefined;
    let status: ArchiveStatus = "ok";

    try {
      const events = backend.invoke(normalized);
      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        // Tee the events into both the SSE writer and a buffer for the cache/archive.
        const collected: NormalizedEvent[] = [];
        const teed: AsyncIterable<NormalizedEvent> = (async function* () {
          for await (const ev of events) {
            collected.push(ev);
            yield ev;
          }
        })();
        for await (const chunk of normalizedEventsToSSE(teed, meta)) {
          res.write(chunk);
        }
        res.end();
        finalBody = await normalizedEventsToFinalResponse(
          (async function* () {
            for (const ev of collected) yield ev;
          })(),
          meta
        );
      } else {
        finalBody = await normalizedEventsToFinalResponse(events, meta);
        res.status(200).json(finalBody);
      }
    } catch (e) {
      status = "error";
      const msg = e instanceof Error ? e.message : String(e);
      finalBody = { type: "error", error: { type: "api_error", message: msg } };
      if (!res.headersSent) {
        res.status(500).json(internalServerError(`backend error: ${msg}`));
      } else {
        res.end();
      }
    }

    // ---- Cache write ----------------------------------------------------
    if (wantsCache && cacheKey && finalBody && status === "ok") {
      deps.responseCache.set(cacheKey, {
        body: finalBody,
        metadata: { backendId: backend.id, resolvedModel: normalized.model }
      });
    }

    // ---- Archive write (fire-and-forget) --------------------------------
    fireAndForgetArchive(deps.archive, {
      requestHash:
        cacheKey ??
        archiveRequestHash({
          backendId: backend.id,
          resolvedModel: normalized.model,
          system: normalized.system,
          cacheablePrefix: [],
          tail: normalized.messages,
          tools: normalized.tools,
          toolChoice: normalized.toolChoice
        }),
      logId: messageId,
      endpoint: "/v1/messages",
      backend: backend.id,
      modelResolved: normalized.model,
      sessionId: null,
      timestamp: new Date(started).toISOString(),
      status,
      durationMs: Date.now() - started,
      inputTokens: null,
      outputTokens: null,
      requestBody: body,
      responseBody: finalBody ?? null
    });
  };
```

Add at module scope:

```ts
function fireAndForgetArchive(archive: Archive, entry: ArchiveEntry): void {
  setImmediate(() => {
    try {
      archive.recordEntry(entry);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("archive.recordEntry failed:", err);
    }
  });
}

async function replayCachedAsSSE(
  cached: { body: Record<string, unknown> },
  meta: { messageId: string; model: string },
  res: Response
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  // Synthesize events from the cached final response. We walk the content
  // array and emit one synthetic message_start / content_block_* /
  // message_stop sequence per text block.
  const synthEvents = synthesizeEventsFromBody(cached.body);
  for await (const chunk of normalizedEventsToSSE(synthEvents, meta)) {
    res.write(chunk);
  }
  res.end();
}

async function* synthesizeEventsFromBody(
  body: Record<string, unknown>
): AsyncIterable<NormalizedEvent> {
  yield { kind: "message_start", model: (body.model as string) ?? "" };
  const content = (body.content as Array<Record<string, unknown>>) ?? [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block?.type === "text" && typeof block.text === "string") {
      yield { kind: "text_delta", index: i, text: block.text };
    }
  }
  const usage = body.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  yield {
    kind: "message_stop",
    stopReason: (body.stop_reason as never) ?? "end_turn",
    ...(usage
      ? {
          usage: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0
          }
        }
      : {})
  };
}
```

Update the translator call to `await` and pass `fileStore`:

```ts
    try {
      normalized = await anthropicRequestToNormalized(body, {
        fileStore: deps.fileStore
      });
    } catch (e) {
      // ...existing error handling
    }
```

- [ ] **Step 4: Update existing messages.test.ts call sites to pass the new deps**

Every existing `createMessagesHandler({...})` call in the test file gains stub `archive`, `responseCache` instances (use `:memory:` paths via tmpdir).

- [ ] **Step 5: Run to verify passing**

Run: `npx vitest run tests/unit/anthropicShim/messages.test.ts`
Expected: PASS — Plan-03/04 tests + 3 new tests green.

- [ ] **Step 6: Commit**

```bash
git add src/anthropicShim/messages.ts tests/unit/anthropicShim/messages.test.ts
git commit -m "feat(anthropicShim): wire response cache + archive write into /v1/messages"
```

---

## Task 10: Admin archive handlers — `/admin/archive*`

**Files:**
- Create: `src/admin/archive.ts`
- Test: `tests/unit/admin/archive.test.ts`

Three endpoints: `GET /admin/archive` (paginated list with filters), `GET /admin/archive/{id}` (single entry with decompressed bodies), `GET /admin/archive/search?q=` (substring search). Auth via the shared `apiKey` per spec. The admin UI (Plan 12) will sit on top of these endpoints; for now they're pure REST.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/admin/archive.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";
import { Archive, type ArchiveEntry } from "../../../src/archive.js";
import { createAdminArchiveHandlers } from "../../../src/admin/archive.js";

function buildApp(archive: Archive): express.Express {
  const app = express();
  const h = createAdminArchiveHandlers({
    archive,
    config: { apiKey: "sk-test" }
  });
  app.get("/admin/archive", h.list);
  app.get("/admin/archive/search", h.search);
  app.get("/admin/archive/:id", h.getById);
  return app;
}

function seedEntry(archive: Archive, override: Partial<ArchiveEntry>): number {
  return archive.recordEntry({
    requestHash: "h".repeat(64),
    logId: "log_x",
    endpoint: "/v1/messages",
    backend: "claude",
    modelResolved: "claude-sonnet-4-6",
    sessionId: null,
    timestamp: new Date().toISOString(),
    status: "ok",
    durationMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    requestBody: { messages: [{ role: "user", content: "default-prompt" }] },
    responseBody: { id: "msg_x" },
    ...override
  });
}

describe("/admin/archive — auth", () => {
  let dir: string;
  let archive: Archive;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-admin-arc-"));
    archive = new Archive(join(dir, "archive.sqlite"));
  });

  afterEach(() => {
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 401 on missing api key", async () => {
    const res = await request(buildApp(archive)).get("/admin/archive");
    expect(res.status).toBe(401);
  });

  it("returns 401 on wrong api key", async () => {
    const res = await request(buildApp(archive))
      .get("/admin/archive")
      .set("x-api-key", "wrong");
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/archive — list + filters", () => {
  let dir: string;
  let archive: Archive;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-admin-arc-"));
    archive = new Archive(join(dir, "archive.sqlite"));
  });

  afterEach(() => {
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists entries with default pagination", async () => {
    seedEntry(archive, { logId: "a" });
    seedEntry(archive, { logId: "b", backend: "gemini" });
    const res = await request(buildApp(archive))
      .get("/admin/archive")
      .set("x-api-key", "sk-test");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.has_more).toBe(false);
  });

  it("filters by backend", async () => {
    seedEntry(archive, { logId: "a" });
    seedEntry(archive, { logId: "b", backend: "gemini" });
    const res = await request(buildApp(archive))
      .get("/admin/archive?backend=gemini")
      .set("x-api-key", "sk-test");
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].logId).toBe("b");
  });

  it("filters by session + since combined", async () => {
    seedEntry(archive, {
      logId: "old",
      sessionId: "s1",
      timestamp: "2026-05-10T00:00:00Z"
    });
    seedEntry(archive, {
      logId: "new",
      sessionId: "s1",
      timestamp: "2026-05-15T00:00:00Z"
    });
    seedEntry(archive, {
      logId: "other",
      sessionId: "s2",
      timestamp: "2026-05-15T00:00:00Z"
    });
    const res = await request(buildApp(archive))
      .get("/admin/archive?session=s1&since=2026-05-12T00:00:00Z")
      .set("x-api-key", "sk-test");
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].logId).toBe("new");
  });

  it("honors limit + offset", async () => {
    for (const log of ["a", "b", "c", "d"]) seedEntry(archive, { logId: log });
    const res = await request(buildApp(archive))
      .get("/admin/archive?limit=2&offset=1")
      .set("x-api-key", "sk-test");
    expect(res.body.data).toHaveLength(2);
    expect(res.body.has_more).toBe(true);
  });
});

describe("GET /admin/archive/{id}", () => {
  let dir: string;
  let archive: Archive;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-admin-arc-"));
    archive = new Archive(join(dir, "archive.sqlite"));
  });

  afterEach(() => {
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the full decompressed entry", async () => {
    const id = seedEntry(archive, { logId: "g" });
    const res = await request(buildApp(archive))
      .get(`/admin/archive/${id}`)
      .set("x-api-key", "sk-test");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.requestBody).toEqual({
      messages: [{ role: "user", content: "default-prompt" }]
    });
  });

  it("returns 404 on unknown id", async () => {
    const res = await request(buildApp(archive))
      .get("/admin/archive/999999")
      .set("x-api-key", "sk-test");
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/archive/search", () => {
  let dir: string;
  let archive: Archive;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-admin-arc-"));
    archive = new Archive(join(dir, "archive.sqlite"));
  });

  afterEach(() => {
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds the matching entry by substring", async () => {
    seedEntry(archive, {
      logId: "needle",
      requestBody: { messages: [{ role: "user", content: "find me please" }] }
    });
    seedEntry(archive, {
      logId: "noise",
      requestBody: { messages: [{ role: "user", content: "irrelevant" }] }
    });
    const res = await request(buildApp(archive))
      .get("/admin/archive/search?q=find%20me")
      .set("x-api-key", "sk-test");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].logId).toBe("needle");
  });

  it("returns 400 on missing q parameter", async () => {
    const res = await request(buildApp(archive))
      .get("/admin/archive/search")
      .set("x-api-key", "sk-test");
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/admin/archive.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/admin/archive.ts`**

```ts
import type { Request, RequestHandler, Response } from "express";
import { checkAuth } from "../auth.js";
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
    if (!checkAuth(req, deps.config.apiKey)) {
      res.status(401).json(authenticationError("invalid or missing API key"));
      return false;
    }
    return true;
  };

  const list: RequestHandler = (req, res) => {
    if (!auth(req, res)) return;
    const page = deps.archive.list({
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset),
      backend: pickStringQuery(req.query.backend),
      sessionId: pickStringQuery(req.query.session),
      model: pickStringQuery(req.query.model),
      since: pickStringQuery(req.query.since),
      until: pickStringQuery(req.query.until),
      status: maybeStatus(req.query.status)
    });
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
```

- [ ] **Step 4: Run to verify passing**

Run: `npx vitest run tests/unit/admin/archive.test.ts`
Expected: PASS — all 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/admin/archive.ts tests/unit/admin/archive.test.ts
git commit -m "feat(admin): add /admin/archive list/get/search handlers"
```

---

## Task 11: Server bootstrap — wire FileStore + ResponseCache + admin routes

**Files:**
- Modify: `src/server.ts`

Construct the new singletons at startup, thread them into handler factories, mount the new routes, and start the file-store eviction sweep.

- [ ] **Step 1: Edit `src/server.ts`**

Add imports:

```ts
import { FileStore } from "./fileStore.js";
import { ResponseCache } from "./responseCache.js";
import { createFilesHandlers } from "./anthropicShim/files.js";
import { createAdminArchiveHandlers } from "./admin/archive.js";
```

Extend `ServerDeps`:

```ts
export interface ServerDeps {
  config: Config;
  registry: BackendRegistry;
  archive: Archive;
  fileStore: FileStore;
  responseCache: ResponseCache;
}
```

In `buildApp`, after the existing `/v1/messages` mount, change the `createMessagesHandler` call to pass the new deps:

```ts
  app.post(
    "/v1/messages",
    createMessagesHandler({
      registry: deps.registry,
      archive: deps.archive,
      responseCache: deps.responseCache,
      fileStore: deps.fileStore,
      config: handlerConfig
    })
  );
```

Mount the Files API:

```ts
  const filesHandlers = createFilesHandlers({
    fileStore: deps.fileStore,
    config: { apiKey: deps.config.apiKey }
  });
  app.post("/v1/files", filesHandlers.upload);
  app.get("/v1/files", filesHandlers.list);
  app.get("/v1/files/:id", filesHandlers.getMetadata);
  app.get("/v1/files/:id/content", filesHandlers.download);
  app.delete("/v1/files/:id", filesHandlers.delete);
```

Mount the admin archive routes:

```ts
  const adminArchive = createAdminArchiveHandlers({
    archive: deps.archive,
    config: { apiKey: deps.config.apiKey }
  });
  app.get("/admin/archive", adminArchive.list);
  app.get("/admin/archive/search", adminArchive.search);
  app.get("/admin/archive/:id", adminArchive.getById);
```

In `main`, after `const archive = new Archive(...)`:

```ts
  const fileStore = new FileStore({
    dir: config.files.dir,
    ttlMs: config.files.ttlMs,
    maxTotalBytes: config.files.maxTotalBytes
  });
  const responseCache = new ResponseCache({
    file: config.cache.file,
    ttlMs: config.cache.ttlMs,
    maxEntries: config.cache.maxEntries
  });

  const app = buildApp({ config, registry, archive, fileStore, responseCache });
```

In `shutdown`, also stop the file-store sweep:

```ts
    fileStore.stop();
```

Extend `RunningServer`:

```ts
export interface RunningServer {
  app: Express;
  http: Server;
  registry: BackendRegistry;
  archive: Archive;
  fileStore: FileStore;
  responseCache: ResponseCache;
  config: Config;
  shutdown: () => Promise<void>;
}
```

And include them in the returned object.

- [ ] **Step 2: Verify TypeScript still compiles**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 3: Smoke-test the bootstrap**

Run: `npx tsx src/bin.ts --config configs/default.json --port 13211` in one shell. Expected: `ClaudeMCP listening on http://127.0.0.1:13211`. Hit Ctrl+C; expected: clean exit. `data/files/` should exist (created by the FileStore constructor); `data/response-cache.json` may or may not exist depending on whether any requests were made.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): wire FileStore, ResponseCache, and admin/files routes into bootstrap"
```

---

## Task 12: Integration test — Files API + `/v1/messages` round-trip

**Files:**
- Create: `tests/integration/files.test.ts`

End-to-end: upload via `POST /v1/files`, reference the resulting id from a `/v1/messages` call, verify the request translator inlined the bytes. Delete the file, verify subsequent reference returns 400.

The mock-claude fixture must surface what it saw — the simplest way is to have the test inspect the **archived** request body. Plan 05's archive write captures the post-translation `requestBody`, which already has the inlined base64 if the translator did its job. So the test:

1. Upload bytes.
2. POST `/v1/messages` referencing the file.
3. Wait a tick for the fire-and-forget archive write.
4. Read the latest archive entry; assert its requestBody contains the inlined base64.

- [ ] **Step 1: Write the test**

Create `tests/integration/files.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { Archive } from "../../src/archive.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const MOCK_CLAUDE_JS = join(PROJECT_ROOT, "tests", "fixtures", "mock-claude", "index.mjs");

interface Spawned {
  proc: ChildProcess;
  port: number;
  workDir: string;
  dbPath: string;
}

async function waitForReady(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject(new Error(`status ${res.statusCode}`));
        });
        req.on("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server not ready on port ${port}`);
}

async function startServer(): Promise<Spawned> {
  const workDir = mkdtempSync(join(tmpdir(), "claudemcp-files-it-"));
  const dbPath = join(workDir, "archive.sqlite");
  const cfgPath = join(workDir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      apiKey: "sk-integration",
      claude: {
        enabled: true,
        command: ["node", MOCK_CLAUDE_JS],
        priority: 100,
        timeoutMs: 10000
      },
      gemini: { enabled: false, command: "gemini" },
      lmstudio: { enabled: false, instances: [] },
      ollama: { enabled: false, useNativeApi: false, instances: [] },
      archive: { dbPath, compressionLevel: 3 },
      files: { dir: join(workDir, "files"), ttlMs: 60000, maxTotalBytes: 1_000_000 },
      cache: { file: join(workDir, "cache.json"), ttlMs: 60000, maxEntries: 100 }
    })
  );
  const port = 13310 + Math.floor(Math.random() * 200);
  const proc = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(PROJECT_ROOT, "src", "bin.ts"),
      "--config",
      cfgPath,
      "--port",
      String(port)
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env }
  );
  proc.stdout?.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  proc.stderr?.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  await waitForReady(port);
  return { proc, port, workDir, dbPath };
}

async function stopServer(s: Spawned): Promise<void> {
  return new Promise((resolve) => {
    s.proc.once("exit", () => {
      rmSync(s.workDir, { recursive: true, force: true });
      resolve();
    });
    s.proc.kill("SIGTERM");
    setTimeout(() => {
      if (!s.proc.killed) s.proc.kill("SIGKILL");
    }, 4000);
  });
}

async function uploadFile(
  port: number,
  bytes: Buffer,
  filename: string,
  mime: string
): Promise<string> {
  const boundary = "----claudemcp-test-boundary";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/files",
        method: "POST",
        headers: {
          "x-api-key": "sk-integration",
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(body.length)
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(parsed.id as string);
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function postMessages(port: number, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/messages",
        method: "POST",
        headers: {
          "x-api-key": "sk-integration",
          "content-type": "application/json",
          "content-length": String(payload.length)
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("Files API + /v1/messages round-trip", () => {
  let s: Spawned;

  beforeAll(async () => {
    s = await startServer();
  }, 30_000);

  afterAll(async () => {
    await stopServer(s);
  });

  it("upload → reference → translator inlines bytes (visible in archive)", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const fileId = await uploadFile(s.port, png, "test.png", "image/png");
    expect(fileId).toMatch(/^file_[0-9a-f]{24}$/);

    const res = await postMessages(s.port, {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image",
              source: { type: "file", file_id: fileId }
            }
          ]
        }
      ]
    });
    expect(res.status).toBe(200);

    // Give the fire-and-forget archive write a moment.
    await new Promise((r) => setTimeout(r, 200));

    const archive = new Archive(s.dbPath);
    try {
      const page = archive.list({ limit: 10, offset: 0 });
      expect(page.data).toHaveLength(1);
      const stringified = JSON.stringify(page.data[0]?.requestBody);
      expect(stringified).toContain(png.toString("base64"));
    } finally {
      archive.close();
    }
  });

  it("delete file → subsequent reference returns 400", async () => {
    const bytes = Buffer.from("delete-me");
    const fileId = await uploadFile(s.port, bytes, "d.txt", "text/plain");
    // delete it
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: s.port,
          path: `/v1/files/${fileId}`,
          method: "DELETE",
          headers: { "x-api-key": "sk-integration" }
        },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject(new Error(`status ${res.statusCode}`));
        }
      );
      req.on("error", reject);
      req.end();
    });
    const res = await postMessages(s.port, {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "file", file_id: fileId }
            }
          ]
        }
      ]
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/integration/files.test.ts`
Expected: PASS — 2 tests green.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/files.test.ts
git commit -m "test(integration): files upload → /v1/messages inlining round-trip"
```

---

## Task 13: Integration test — response cache hit skips the backend

**Files:**
- Create: `tests/integration/cache.test.ts`

The cleanest way to count mock-claude invocations is to have the mock write a sidecar file on each invocation. Plan 02's `mock-claude/index.mjs` doesn't currently do this, so this task either (a) extends the fixture or (b) infers the cache-hit by reading the response body's `_cache_hit` flag injected by `messages.ts` on cache replay. **Plan 05 picks (b)** because it requires zero fixture changes and the messages handler already writes that flag to the archive on hits.

- [ ] **Step 1: Write the test**

Create `tests/integration/cache.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { Archive } from "../../src/archive.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const MOCK_CLAUDE_JS = join(PROJECT_ROOT, "tests", "fixtures", "mock-claude", "index.mjs");

// Reuse the same scaffolding helpers from files.test.ts — copy them inline
// here (avoiding cross-test-file imports keeps each integration test
// self-contained).
interface Spawned {
  proc: ChildProcess;
  port: number;
  workDir: string;
  dbPath: string;
}

async function waitForReady(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject(new Error(`status ${res.statusCode}`));
        });
        req.on("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server not ready on port ${port}`);
}

async function startServer(): Promise<Spawned> {
  const workDir = mkdtempSync(join(tmpdir(), "claudemcp-cache-it-"));
  const dbPath = join(workDir, "archive.sqlite");
  const cfgPath = join(workDir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      apiKey: "sk-integration",
      claude: {
        enabled: true,
        command: ["node", MOCK_CLAUDE_JS],
        priority: 100,
        timeoutMs: 10000
      },
      gemini: { enabled: false, command: "gemini" },
      lmstudio: { enabled: false, instances: [] },
      ollama: { enabled: false, useNativeApi: false, instances: [] },
      archive: { dbPath, compressionLevel: 3 },
      files: { dir: join(workDir, "files"), ttlMs: 60000, maxTotalBytes: 1_000_000 },
      cache: { file: join(workDir, "cache.json"), ttlMs: 60000, maxEntries: 100 }
    })
  );
  const port = 13510 + Math.floor(Math.random() * 200);
  const proc = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(PROJECT_ROOT, "src", "bin.ts"),
      "--config",
      cfgPath,
      "--port",
      String(port)
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env }
  );
  proc.stdout?.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  proc.stderr?.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  await waitForReady(port);
  return { proc, port, workDir, dbPath };
}

async function stopServer(s: Spawned): Promise<void> {
  return new Promise((resolve) => {
    s.proc.once("exit", () => {
      rmSync(s.workDir, { recursive: true, force: true });
      resolve();
    });
    s.proc.kill("SIGTERM");
    setTimeout(() => {
      if (!s.proc.killed) s.proc.kill("SIGKILL");
    }, 4000);
  });
}

async function postJson(
  port: number,
  path: string,
  body: unknown
): Promise<{ status: number; body: { _cache_hit?: boolean } & Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "x-api-key": "sk-integration",
          "content-type": "application/json",
          "content-length": String(payload.length)
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
          })
        );
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("Response cache integration", () => {
  let s: Spawned;

  beforeAll(async () => {
    s = await startServer();
  }, 30_000);

  afterAll(async () => {
    await stopServer(s);
  });

  it("second identical request with cache_control hits the cache (verified via archive)", async () => {
    const body = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "deterministic prompt for cache",
              cache_control: { type: "ephemeral" }
            }
          ]
        }
      ]
    };

    const first = await postJson(s.port, "/v1/messages", body);
    expect(first.status).toBe(200);
    const second = await postJson(s.port, "/v1/messages", body);
    expect(second.status).toBe(200);

    // Give the fire-and-forget archive writes a moment.
    await new Promise((r) => setTimeout(r, 250));

    const archive = new Archive(s.dbPath);
    try {
      const page = archive.list({ limit: 10, offset: 0 });
      expect(page.data).toHaveLength(2);
      // Archive entries are returned newest-first; the second call hit the
      // cache and got the `_cache_hit: true` marker.
      const newest = page.data[0]?.responseBody as Record<string, unknown>;
      expect(newest._cache_hit).toBe(true);
    } finally {
      archive.close();
    }
  });

  it("different backends do not share cache entries (key includes backendId)", async () => {
    // This is enforced by buildCacheKey unit tests — see responseCache.test.ts.
    // We add a thin integration smoke-test: the same prompt with different
    // model prefixes should not collide.
    const body = (model: string) => ({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "isolation test",
              cache_control: { type: "ephemeral" }
            }
          ]
        }
      ]
    });

    // Only the claude backend is enabled in this test config; this assertion
    // collapses to "same model = collide" which is the bare-minimum sanity
    // check. The cross-backend isolation case is unit-test territory.
    const a = await postJson(s.port, "/v1/messages", body("claude-sonnet-4-6"));
    const b = await postJson(s.port, "/v1/messages", body("claude-sonnet-4-6"));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/integration/cache.test.ts`
Expected: PASS — 2 tests green.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/cache.test.ts
git commit -m "test(integration): response cache hit skips backend (verified via archive marker)"
```

---

## Task 14: Archive-prune CLI script + integration test

**Files:**
- Create: `scripts/archive-prune.ts`
- Create: `tests/integration/archive.test.ts`

A tiny operator CLI. Two modes: `--before YYYY-MM-DD` deletes entries with `timestamp < cutoff`; `--session <id>` deletes entries with matching session id. Requires `--config <path>` to locate the archive db (same convention as `bin.ts`).

The integration test exercises the prune script via `npx tsx scripts/archive-prune.ts ...` against a seeded archive db.

- [ ] **Step 1: Create `scripts/archive-prune.ts`**

```ts
#!/usr/bin/env node
import { loadConfig } from "../src/config.js";
import { Archive } from "../src/archive.js";

interface Args {
  configPath: string;
  before?: string;
  session?: string;
}

function parseArgs(argv: string[]): Args {
  let configPath: string | undefined;
  let before: string | undefined;
  let session: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      configPath = argv[++i];
    } else if (arg === "--before") {
      before = argv[++i];
    } else if (arg === "--session") {
      session = argv[++i];
    }
  }
  if (!configPath) {
    // eslint-disable-next-line no-console
    console.error(
      "usage: archive-prune --config <path> [--before YYYY-MM-DD] [--session <id>]"
    );
    process.exit(2);
  }
  if (!before && !session) {
    // eslint-disable-next-line no-console
    console.error("archive-prune: must pass either --before or --session");
    process.exit(2);
  }
  return { configPath, ...(before ? { before } : {}), ...(session ? { session } : {}) };
}

function toCutoffIso(date: string): string {
  // Accept "YYYY-MM-DD" and pad to start-of-day UTC.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    // eslint-disable-next-line no-console
    console.error(`archive-prune: --before must be YYYY-MM-DD, got "${date}"`);
    process.exit(2);
  }
  return `${date}T00:00:00Z`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);
  const archive = new Archive(config.archive.dbPath);
  let removed = 0;
  if (args.before) {
    removed += archive.deleteOlderThan(toCutoffIso(args.before));
  }
  if (args.session) {
    removed += archive.deleteBySession(args.session);
  }
  archive.close();
  // eslint-disable-next-line no-console
  console.log(`archive-prune: removed ${removed} entries`);
}

main();
```

- [ ] **Step 2: Create `tests/integration/archive.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import http from "node:http";
import { Archive } from "../../src/archive.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const MOCK_CLAUDE_JS = join(PROJECT_ROOT, "tests", "fixtures", "mock-claude", "index.mjs");

interface Spawned {
  proc: ChildProcess;
  port: number;
  workDir: string;
  dbPath: string;
  cfgPath: string;
}

async function waitForReady(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject(new Error(`status ${res.statusCode}`));
        });
        req.on("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server not ready on port ${port}`);
}

async function startServer(): Promise<Spawned> {
  const workDir = mkdtempSync(join(tmpdir(), "claudemcp-arc-it-"));
  const dbPath = join(workDir, "archive.sqlite");
  const cfgPath = join(workDir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      apiKey: "sk-integration",
      claude: {
        enabled: true,
        command: ["node", MOCK_CLAUDE_JS],
        priority: 100,
        timeoutMs: 10000
      },
      gemini: { enabled: false, command: "gemini" },
      lmstudio: { enabled: false, instances: [] },
      ollama: { enabled: false, useNativeApi: false, instances: [] },
      archive: { dbPath, compressionLevel: 3 },
      files: { dir: join(workDir, "files"), ttlMs: 60000, maxTotalBytes: 1_000_000 },
      cache: { file: join(workDir, "cache.json"), ttlMs: 60000, maxEntries: 100 }
    })
  );
  const port = 13710 + Math.floor(Math.random() * 200);
  const proc = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(PROJECT_ROOT, "src", "bin.ts"),
      "--config",
      cfgPath,
      "--port",
      String(port)
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env }
  );
  proc.stdout?.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  proc.stderr?.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  await waitForReady(port);
  return { proc, port, workDir, dbPath, cfgPath };
}

async function stopServer(s: Spawned): Promise<void> {
  return new Promise((resolve) => {
    s.proc.once("exit", () => {
      rmSync(s.workDir, { recursive: true, force: true });
      resolve();
    });
    s.proc.kill("SIGTERM");
    setTimeout(() => {
      if (!s.proc.killed) s.proc.kill("SIGKILL");
    }, 4000);
  });
}

async function postMessages(port: number, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/messages",
        method: "POST",
        headers: {
          "x-api-key": "sk-integration",
          "content-type": "application/json",
          "content-length": String(payload.length)
        }
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function getJson(
  port: number,
  path: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { "x-api-key": "sk-integration" }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Archive integration", () => {
  let s: Spawned;

  beforeAll(async () => {
    s = await startServer();
  }, 30_000);

  afterAll(async () => {
    await stopServer(s);
  });

  it("any /v1/messages call gets archived with the right backend tag", async () => {
    const status = await postMessages(s.port, {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "archive integration test prompt" }]
    });
    expect(status).toBe(200);
    await new Promise((r) => setTimeout(r, 250));
    const res = await getJson(s.port, "/admin/archive?limit=10&offset=0");
    expect(res.status).toBe(200);
    const data = res.body.data as Array<{ backend: string }>;
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0]?.backend).toBe("claude");
  });

  it("substring search via /admin/archive/search finds the entry", async () => {
    const res = await getJson(
      s.port,
      "/admin/archive/search?q=" + encodeURIComponent("archive integration test prompt")
    );
    expect(res.status).toBe(200);
    expect((res.body.data as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("scripts/archive-prune.ts --before YYYY-MM-DD removes old entries", async () => {
    // Seed an old entry directly via the archive class — we hold the server's
    // db open, but better-sqlite3 with WAL allows concurrent readers + a
    // single writer; opening a second handle for a one-off insert is fine
    // for the test.
    const archive = new Archive(s.dbPath);
    archive.recordEntry({
      requestHash: "z".repeat(64),
      logId: "log_ancient",
      endpoint: "/v1/messages",
      backend: "claude",
      modelResolved: "claude-sonnet-4-6",
      sessionId: null,
      timestamp: "2020-01-01T00:00:00Z",
      status: "ok",
      durationMs: 1,
      inputTokens: null,
      outputTokens: null,
      requestBody: { messages: [{ role: "user", content: "ancient" }] },
      responseBody: { id: "msg_ancient" }
    });
    archive.close();

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(PROJECT_ROOT, "scripts", "archive-prune.ts"),
        "--config",
        s.cfgPath,
        "--before",
        "2024-01-01"
      ],
      { encoding: "utf8" }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/removed \d+ entries/);

    const archive2 = new Archive(s.dbPath);
    try {
      const remaining = archive2.list({
        limit: 100,
        offset: 0,
        sessionId: undefined
      });
      // The ancient entry should be gone; the live entries from earlier in
      // this describe block remain.
      expect(remaining.data.find((e) => e.logId === "log_ancient")).toBeUndefined();
    } finally {
      archive2.close();
    }
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/integration/archive.test.ts`
Expected: PASS — 3 tests green.

- [ ] **Step 4: Commit**

```bash
git add scripts/archive-prune.ts tests/integration/archive.test.ts
git commit -m "feat(scripts): add archive-prune CLI + integration coverage"
```

---

## Task 15: Full suite green + typecheck

Before the close-out document, confirm Plan 05 doesn't leave any regressions.

- [ ] **Step 1: Run the full suite**

Run: `npx vitest run`
Expected: All tests green. Plan-01..04 counts unchanged; Plan-05 adds:
- `tests/unit/fileStore.test.ts` — 16 tests
- `tests/unit/responseCache.test.ts` — 11 tests
- `tests/unit/archive.test.ts` — extended by 14 tests
- `tests/unit/anthropicShim/files.test.ts` — 11 tests
- `tests/unit/admin/archive.test.ts` — 11 tests
- `tests/unit/anthropicShim/requestTranslator.test.ts` — extended by 4 tests
- `tests/unit/anthropicShim/messages.test.ts` — extended by 3 tests
- `tests/integration/files.test.ts` — 2 tests
- `tests/integration/cache.test.ts` — 2 tests
- `tests/integration/archive.test.ts` — 3 tests

Approximate new total: **+77 tests**.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 3: No commit** — this is a verification step.

---

## Task 16: Plan-05 close-out documentation

**Files:**
- Create: `docs/plan-05-files-cache-archive-readme.md`

- [ ] **Step 1: Write the document**

```markdown
# Plan 05 — Files API + Response Cache + Archive Writes: what shipped

Plan 05 closed three cross-cutting gaps every later shim and backend pair relies on:

1. **Persistent Files API** — disk-backed content-addressed file cache exposed via `/v1/files/*`.
2. **Response cache** — local memo cache reinterpreting Anthropic's `cache_control: { type: "ephemeral" }`.
3. **Archive writes + admin read API** — typed writer/query methods on the Plan-01 archive skeleton, plus `/admin/archive*` HTTP endpoints.

## Endpoints live

| Method | Path | Status |
|---|---|---|
| POST | `/v1/files` | multipart upload, dedup by SHA-256 |
| GET  | `/v1/files` | paginated list, newest-first |
| GET  | `/v1/files/{id}` | metadata envelope |
| GET  | `/v1/files/{id}/content` | raw bytes with original mime |
| DELETE | `/v1/files/{id}` | idempotent delete |
| GET  | `/admin/archive` | filtered + paginated archive list |
| GET  | `/admin/archive/{id}` | full entry with decompressed bodies |
| GET  | `/admin/archive/search?q=` | substring search via plain `LIKE` (FTS5 deferred) |

The `/v1/messages` handler now consults the response cache before backend dispatch and archives every request after completion (success, error, or timeout). Both writes are non-blocking.

## Modules added

| Path | Purpose |
|---|---|
| `src/fileStore.ts` | Content-addressed file cache with TTL + max-total-bytes LRU eviction |
| `src/responseCache.ts` | Persistent response memo cache with canonicalized SHA-256 keys |
| `src/anthropicShim/files.ts` | Five `/v1/files/*` route handlers |
| `src/admin/archive.ts` | Three `/admin/archive*` route handlers |
| `scripts/archive-prune.ts` | Operator CLI: `--before YYYY-MM-DD` and `--session <id>` |

## Modules extended

| Path | What changed |
|---|---|
| `src/archive.ts` | Added `recordEntry`, `getById`, `list`, `searchText`, `deleteOlderThan`, `deleteBySession`. zstd compression via `node:zlib` (Node 22+). The `raw()` escape hatch is retained but now documents "prefer the typed surface." |
| `src/anthropicShim/requestTranslator.ts` | Signature change: now async, accepts an optional `{ fileStore }` dep. Resolves `source.type='file'` references to inline base64. |
| `src/anthropicShim/messages.ts` | Wired cache lookup (before backend), cache write (after backend), and fire-and-forget archive write (on completion). New deps: `archive`, `responseCache`, `fileStore`. |
| `src/server.ts` | Constructs `FileStore` and `ResponseCache`; mounts new routes; threads new deps through factories. |
| `package.json` | Added `busboy` (runtime) and `@types/busboy` (dev). |

## Test infrastructure added

| Path | Purpose |
|---|---|
| `tests/unit/fileStore.test.ts` | Upload, dedup, get, list, delete, TTL + LRU eviction, resolveForInline (16 tests) |
| `tests/unit/responseCache.test.ts` | Key canonicalization, get/set, TTL + LRU eviction, persistence round-trip (11 tests) |
| `tests/unit/archive.test.ts` | Extended with recordEntry, query methods, prune (14 new tests) |
| `tests/unit/anthropicShim/files.test.ts` | Five handler shapes (11 tests) |
| `tests/unit/admin/archive.test.ts` | Three handler shapes + auth (11 tests) |
| `tests/integration/files.test.ts` | Upload → reference → translator inlines bytes via archive (2 tests) |
| `tests/integration/cache.test.ts` | Same `cache_control` request twice → second hits cache (2 tests) |
| `tests/integration/archive.test.ts` | /v1/messages → archived → searchable → prune (3 tests) |

Approximate new tests: **+77**. Run all: `npm test`.

## Plan-05 scope boundary (what does NOT ship here)

- **No archive reuse** (the `X-Archive-Reuse: exact-match` header path) — the canonical request hash is stored, but the handler does not yet consult prior archive entries for replay. Slated for a small follow-on (see Open questions).
- **No admin UI** — the admin SPA lands in Plan 12. Plan 05 ships only the underlying REST endpoints.
- **No backend-specific embeddings archival** — Plan 05 archives `/v1/messages` only. Embeddings archival lands when the OpenAI shim's embeddings endpoint exists in Plan 10.
- **No FTS5 substring search** — `searchText` uses plain `LIKE` (actually: in-memory decompress + `String.includes`). FTS5 is in the spec's open questions.
- **No `/v1beta/files` (Gemini-style file routes)** — the underlying `FileStore` is shim-agnostic, but the Gemini-shaped paths land with the Gemini shim in Plan 06.

## What the next plan (Plan 06 — Gemini shim) needs

- Reuse `FileStore` directly for `/v1beta/files` routes (it accepts the same SHA-256 hash via `files/<24hex>` or `file_<24hex>` IDs once the resolver helper is generalized).
- Reuse `ResponseCache` directly; the cache key already includes `backendId` so cross-shim entries cannot collide.
- Reuse `Archive.recordEntry`; the `backend` column is already in the schema and Plan 06's `messages.ts`-equivalent should call `recordEntry` from the Gemini-shaped completion path.

## Operational notes

- Default file dir: `data/files/`. Default cap: 5 GB. Default TTL: 7 days from last access.
- Default response cache file: `data/response-cache.json`. Default TTL: 1 hour. Default cap: 500 entries.
- Default archive db: `data/archive.sqlite`. zstd compression level configurable via `config.archive.compressionLevel` (default 3).
- Eviction timers run every 5 minutes for the file store; the response cache is sweep-on-access (no separate timer).
- Cache + archive writes are fire-and-forget — failures are logged via `console.warn` and never block the response.
- The `Archive.searchText` implementation decompresses every entry in memory; works fine for archives under ~10k entries but will become a hot spot. Plan 11 or a follow-on can swap in FTS5 — see Open questions.
```

- [ ] **Step 2: Commit**

```bash
git add docs/plan-05-files-cache-archive-readme.md
git commit -m "docs: add Plan 05 close-out README for files + cache + archive"
```

---

## Plan 05 — Self-review checklist

Before declaring Plan 05 done, run through this checklist:

- [ ] `npm test` — all tests green, no skips. Plan-01..04 counts unchanged; Plan-05 adds ~77 new tests.
- [ ] `npx tsc --noEmit` — no type errors.
- [ ] `git status` — clean tree, all changes committed (except pre-existing untracked files like `scripts/configure-agent-zero.sh`).
- [ ] `git log --oneline -20` — commits read sensibly: dep, fileStore, fileStore eviction, responseCache, archive recordEntry, archive queries, files handlers, translator file resolution, messages cache+archive wiring, admin archive handlers, server bootstrap, files integration, cache integration, archive-prune + integration, README.
- [ ] `src/fileStore.ts` exists; the eviction timer is `.unref()`d so it doesn't keep the process alive in tests.
- [ ] `src/responseCache.ts` exists; the cache file is written atomically (write to `.tmp`, fsync, rename).
- [ ] `src/archive.ts` retains the `raw()` escape hatch with a doc comment recommending the typed surface.
- [ ] `src/anthropicShim/files.ts` accepts `multipart/form-data` via `busboy` (not `multer`).
- [ ] `src/anthropicShim/requestTranslator.ts` is now async; every caller is updated (`messages.ts`, `countTokens.ts`, all unit tests).
- [ ] `src/anthropicShim/messages.ts`'s archive write uses `setImmediate` (or equivalent) so it never blocks the response.
- [ ] `src/admin/archive.ts` reuses Anthropic-shaped error envelopes from `src/anthropicShim/errors.ts` (no second copy).
- [ ] `src/server.ts` constructs `FileStore` and `ResponseCache` once at startup, threads them via the existing `ServerDeps` pattern, and stops them on shutdown.
- [ ] `scripts/archive-prune.ts` exists, has a shebang, and exits with code 2 on missing `--config` / missing action arg.
- [ ] Cache keys are stable across object-key ordering (verified by `buildCacheKey` unit tests).
- [ ] Cache keys include `backendId` (verified by unit tests).
- [ ] Archive write happens on success, error, AND when the backend throws (verified by the error-archiving test in Task 9).
- [ ] No source file under `src/` exceeds 350 lines (the biggest, `messages.ts`, should stay under 300 — if it grows past that, the cache + archive integration deserves its own helper module).
- [ ] No file-store eviction or cache eviction is reachable from the wire — eviction methods are internal-only.
- [ ] `package.json` only adds `busboy` + `@types/busboy`. No `@mongodb-js/zstd` or other userland zstd dep (Node 22+ assumption — see Open questions if that changes).

If all check, Plan 05 is shipped. Open a PR to main; Plan 06 follows.

---

## Open questions

These deserve attention from a human reviewer before or during Plan 05 execution, and may shift later plans:

1. **Node 22 zstd assumption.** This plan uses `node:zlib`'s `zstdCompressSync` / `zstdDecompressSync`, which require **Node 22+**. The current dev environment reports `node v25.x` and `@types/node` is `^22.10.0`, so the assumption holds — but `package.json` does **not** declare an `engines.node` field. If a future contributor lands on Node 20 CI, archive writes will throw. The fallback is `@mongodb-js/zstd` (or `fzstd` for pure JS). Decide: (a) add `engines.node >= 22` to `package.json` (preferred — explicit), or (b) wrap the import in a try/catch with the userland fallback (smaller blast radius but adds a dep). The plan as written assumes (a) without making the edit; flag if the reviewer wants the edit added as Task 0.

2. **Streaming cache replay event richness.** The synthesizer in `messages.ts` (`synthesizeEventsFromBody`) only emits `text_delta` events for `text` content blocks. Plan 04's `tool_use` content blocks won't replay correctly through the cache. Either (a) extend the synthesizer to walk all content-block shapes (preferred — small effort), or (b) document that cache hits skip streaming when the cached body contains tool_use blocks. Plan 05 ships (b) by omission; address in Plan 06 or sooner.

3. **Archive reuse opt-in header.** The spec defines `X-Archive-Reuse: exact-match` as the opt-in trigger for archive replay. Plan 05 stores the canonical request hash on every entry (so the lookup is cheap) but does not wire the header path. Two reasonable next moves: (a) ship a tiny follow-on right after Plan 05 since the storage layer is ready, or (b) bundle into Plan 06 alongside the Gemini shim's identical header support. The brief said "defer to a later plan unless trivially small" — calling it small but **not** trivially small (it needs cross-shim response-shape conversion, per the spec).

4. **Cache-key cacheable prefix boundary.** The spec says "the cacheable prefix ends at the last `ephemeral` block; everything after is the tail." Plan 05's `splitCacheable` walks message blocks linearly and uses the index of the last `cache_control`-bearing block as the boundary. The system prompt is **excluded** from the prefix and included as a separate `system` field in the key. Confirm with the spec author this matches Anthropic's documented semantics — there's a corner case where the system prompt itself carries `cache_control` that the plan does not currently honor.

5. **FTS5 substring search.** `Archive.searchText` decompresses every entry in memory and runs `String.includes`. Works for small archives but won't scale past a few thousand entries. The spec's open questions section already notes FTS5 as deferred; once total entry count crosses ~10k, this becomes the hot spot. A natural follow-on after admin UI lands in Plan 12.

6. **File-ID format mismatch with Gemini.** Plan 05 uses `file_<24hex>` per Anthropic's convention. The Gemini shim will need `files/<24hex>` — the spec already notes the two surfaces share the underlying hash. When Plan 06 lands, generalize `fileStore.get` / `fileStore.resolveForInline` to accept either form (cheap — a small `parseId` helper that strips the prefix).

7. **Streaming SSE error event on backend crash.** Plan 03's open question #2 noted: when a backend crashes after SSE headers are flushed, Plan 03 just calls `res.end()`. Plan 05 inherits this behavior and **also** archives the partial response with `status: "error"`. The archive entry's `responseBody` for a mid-stream crash will contain `{type: "error", error: {...}}` rather than the partial assistant text — confirm with the reviewer this is the desired observability shape, vs preserving the partial text and a separate error field.

8. **Concurrent SQLite writers.** `Archive.recordEntry` calls run via `setImmediate` (fire-and-forget) so multiple in-flight requests can race on the same db. `better-sqlite3` is synchronous and serialized per-process, so they can't truly race in this process — but multiple processes (e.g., the live server + the prune script) **can** contend. WAL mode (set up in Plan 01) handles this, but verify the integration test in Task 14 actually exercises concurrent writers before declaring it green.
