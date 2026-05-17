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
| GET  | `/admin/archive/search?q=` | substring search via in-memory decompress + `String.includes` (FTS5 deferred) |

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
| `src/anthropicShim/requestTranslator.ts` | Signature change: now async, accepts an optional `{ fileStore }` dep. Resolves `source.type='file'` references to inline base64. `cache_control` is now passed through (silently stripped during normalization) — Plan 04's reject-with-400 guard was removed, since Plan 05 wires cache handling at the `messages.ts` layer instead. |
| `src/anthropicShim/messages.ts` | Wired cache lookup (before backend), cache write (after backend), and fire-and-forget archive write (on completion). New deps: `archive`, `responseCache`, `fileStore`. Archives the request as `{ raw, normalized }` so file_id references show up resolved in the archive. |
| `src/anthropicShim/countTokens.ts` | Translator call became `await` to follow the new async translator signature. |
| `src/server.ts` | Constructs `FileStore` and `ResponseCache`; mounts new routes; threads new deps through factories. Calls `fileStore.stop()` on shutdown. |
| `package.json` | Added `busboy` (runtime) and `@types/busboy` (dev). |

## Test infrastructure added

| Path | Purpose |
|---|---|
| `tests/unit/fileStore.test.ts` | Upload, dedup, get, list, delete, TTL + LRU eviction, resolveForInline (15 tests) |
| `tests/unit/responseCache.test.ts` | Key canonicalization, get/set, TTL + LRU eviction, persistence round-trip (10 tests) |
| `tests/unit/archive.test.ts` | Extended with recordEntry, query methods, prune (13 new tests) |
| `tests/unit/anthropicShim/files.test.ts` | Five handler shapes (10 tests) |
| `tests/unit/admin/archive.test.ts` | Three handler shapes + auth (10 tests) |
| `tests/unit/anthropicShim/requestTranslator.test.ts` | Replaced/converted to async; added 4 file-id resolution tests; converted `cache_control` rejection into a pass-through test |
| `tests/unit/anthropicShim/messages.test.ts` | Added 3 cache + archive tests; updated `buildApp` to thread Archive/ResponseCache deps via an `afterEach`-cleaned harness registry |
| `tests/integration/files.test.ts` | Upload → reference → translator inlines bytes via archive (2 tests) |
| `tests/integration/cache.test.ts` | Same `cache_control` request twice → second hits cache (2 tests) |
| `tests/integration/archive.test.ts` | /v1/messages → archived → searchable → prune (3 tests) |

Approximate new tests: **+71**. Total suite: **355 tests** (baseline 284 + 71). Run all: `npm test`.

## Plan-05 scope boundary (what does NOT ship here)

- **No archive reuse** (the `X-Archive-Reuse: exact-match` header path) — the canonical request hash is stored, but the handler does not yet consult prior archive entries for replay. Slated for a small follow-on.
- **No admin UI** — the admin SPA lands in Plan 12. Plan 05 ships only the underlying REST endpoints.
- **No backend-specific embeddings archival** — Plan 05 archives `/v1/messages` only. Embeddings archival lands when the OpenAI shim's embeddings endpoint exists in Plan 10.
- **No FTS5 substring search** — `searchText` uses an in-memory decompress + `String.includes` scan. FTS5 is in the spec's open questions.
- **No `/v1beta/files` (Gemini-style file routes)** — the underlying `FileStore` is shim-agnostic, but the Gemini-shaped paths land with the Gemini shim later.

## What the next plan (Plan 06 — Gemini shim) needs

- Reuse `FileStore` directly for `/v1beta/files` routes (it accepts the same SHA-256 hash via `files/<24hex>` or `file_<24hex>` IDs once the resolver helper is generalized).
- Reuse `ResponseCache` directly; the cache key already includes `backendId` so cross-shim entries cannot collide.
- Reuse `Archive.recordEntry`; the `backend` column is already in the schema and Plan 06's `messages.ts`-equivalent should call `recordEntry` from the Gemini-shaped completion path.

## Operational notes

- Default file dir: `data/files/`. Default cap: 5 GB. Default TTL: 7 days from last access.
- Default response cache file: `data/response-cache.json`. Default TTL: 1 hour. Default cap: 500 entries.
- Default archive db: `data/archive.sqlite`. zstd compression level configurable via `config.archive.compressionLevel` (default 3 — note: current implementation does not pass the level to `zstdCompressSync`, it uses the node:zlib default; see Deviation 5).
- Eviction timers run every 5 minutes for the file store; the response cache is sweep-on-access (no separate timer).
- Cache + archive writes are fire-and-forget — failures are logged via `console.warn` and never block the response.
- The `Archive.searchText` implementation decompresses every entry in memory; works fine for archives under ~10k entries but will become a hot spot.

## Deviations from the as-designed plan

See the trailing commit `docs(plan-05): record deviations from the as-designed plan` for the complete deviations log appended below.
