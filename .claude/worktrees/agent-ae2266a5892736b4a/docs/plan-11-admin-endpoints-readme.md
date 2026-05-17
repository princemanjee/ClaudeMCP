# Plan 11 — Admin REST Endpoints: what shipped

Plan 11 closed the remaining admin REST surface required by Plan 12's glassmorphism UI: backend introspection, candidate-URL testing, and full config read/write with Zod validation + atomic disk write + in-flight snapshot semantics.

## Endpoints live

| Method | Path | Status |
|---|---|---|
| GET | `/admin/backends` | per-backend state: models, capability matrix, last probe, reachability |
| POST | `/admin/backends/reprobe` | force `registry.probe()`; returns refreshed listing in one round-trip |
| POST | `/admin/backends/test` | candidate-URL connectivity test; returns `{ok, models?, error?, latencyMs}` |
| GET | `/admin/config` | full config with apiKey + instance apiKeys redacted to `***` |
| PUT | `/admin/config` | Zod-validated replacement; atomic write to `configs/default.json`; live snapshot swap |
| PATCH | `/admin/config` | RFC 7396 JSON-merge-patch; same validation + swap |

Plan 05's `/admin/archive*` continues to serve at the same URLs; Plan 11 just folds its mounting into the shared `mountAdminRoutes` helper so every admin route sits behind the bindLocalhost fence.

## Modules added

| Path | Purpose |
|---|---|
| `src/admin/configSnapshot.ts` | `ConfigSnapshotStore` — in-process live snapshot with atomic-write-then-swap |
| `src/admin/bindLocalhost.ts` | Middleware fencing all admin routes to 127.0.0.1 / ::1 when enabled |
| `src/admin/backends.ts` | Three `/admin/backends*` route handlers |
| `src/admin/config.ts` | Three `/admin/config*` route handlers (GET redacted, PUT/PATCH validated) |
| `src/admin/configValidate.ts` | Thin wrapper around `ConfigSchema.parse()` for in-memory validation |
| `src/admin/router.ts` | `mountAdminRoutes(app, deps)` helper — wires every admin route behind bindLocalhost |

## Modules extended

| Path | What changed |
|---|---|
| `src/config.ts` | Exported `ConfigSchema` (was previously private) so `admin/config.ts` can validate PUT/PATCH bodies in-memory |
| `src/server.ts` | Constructs `ConfigSnapshotStore` at startup; replaces inline admin-archive mounting with `mountAdminRoutes(...)` call; threads snapshot through `ServerDeps` + `RunningServer` |

## Test infrastructure added

| Path | Purpose |
|---|---|
| `tests/unit/admin/configSnapshot.test.ts` | `current()`, `replace()`, atomic-write crash survival, deep-freeze (6 tests) |
| `tests/unit/admin/bindLocalhost.test.ts` | localhost accept paths, non-local reject paths, dynamic getEnabled re-evaluation (8 tests) |
| `tests/unit/admin/backends.test.ts` | list, reprobe with valid + invalid `?instance`, test endpoint success + failure + native + auth-forwarding (12 tests) |
| `tests/unit/admin/config.test.ts` | GET redaction, PUT validation + persistence, PATCH merge + RFC-7396 null-deletion, in-flight snapshot semantics (13 tests) |
| `tests/integration/adminEndpoints.test.ts` | bindLocalhost reject + toggle, round-trip every endpoint, PUT changes next-request behavior (11 tests) |

Approximate new tests: **+50**. Run all: `npm test`.

## In-flight snapshot semantics — what does and does not work

| Caller | Behavior after `PUT /admin/config` with a new apiKey |
|---|---|
| Subsequent `GET/PUT/PATCH /admin/config` | Sees the new key immediately — handlers re-read snapshot per request |
| Subsequent `GET /admin/backends`, `POST /admin/backends/reprobe`, `POST /admin/backends/test` | STILL accepts the **old** key — handler captured apiKey at construction |
| Subsequent `GET /admin/archive*`, `POST /v1/messages`, `POST /v1/files`, etc. | STILL accepts the **old** key — all Plan 02-05 handlers captured config at startup |
| Disk: `configs/default.json` | Updated atomically; next server restart picks up the new key everywhere |

This is the explicit scope boundary. Retrofitting every handler to consume `snapshot.current()` per request is a Plan-12-or-later concern. For Plan 11, the admin-config endpoints round-trip correctly with the new snapshot, which is what the UI needs to display + edit.

## Reprobe scope

`POST /admin/backends/reprobe?instance=<id>` accepts the query parameter and validates it against known backend ids, but the underlying `registry.probe()` is currently all-or-nothing. The response includes `_meta.reprobeScope: "all"` to surface this. A future plan can promote the registry to support per-instance probes; Plan 11 ships the API surface so the UI can call it today without an awkward server upgrade later.

## Operational notes

- Default `adminUi.bindLocalhost`: `true`. Admin endpoints reject non-localhost requests with HTTP 403.
- Operators behind a reverse proxy should either disable bindLocalhost OR enable `app.set("trust proxy", true)` so `req.ip` reflects the original client. Plan 11 does not enable trust-proxy in the default bootstrap.
- Config writes are atomic (write to `.tmp`, fsync, rename). A crash between tmp-write and rename leaves `configs/default.json` intact; the orphaned `.tmp` file is cleanable by hand. A future "startup hygiene" sweep can clean leftovers automatically.
- GET responses redact `apiKey` and every `instances[].apiKey` to `"***"`. PUT/PATCH reject `apiKey: "***"` to prevent round-trip lock-out (the UI must echo the real key on PUT or use PATCH for non-key edits).
- PATCH is RFC 7396: arrays are atomic replacements (no element-level merging); `null` deletes a key; objects merge recursively. Plan 11 extends the null-deletion semantic recursively into array elements before Zod validation so that defaults can re-populate cleared fields (see Deviations below).

## What the next plan (Plan 12 — admin UI) needs

- `GET /admin/backends` for the home dashboard's backend cards (already shipped).
- `POST /admin/backends/reprobe` for the "Refresh" button (already shipped — limitation documented).
- `POST /admin/backends/test` for the "Test connection" button in the add-instance modal (already shipped).
- `GET /admin/config` for the settings page (already shipped, redacted).
- `PATCH /admin/config` for granular saves (already shipped).
- `GET /admin/archive*` for the archive browser (Plan 05).
- `/admin/ui` + `/admin/ui/*` for the SPA itself — **Plan 12 ships these**.
- Session cookie / login flow — **Plan 12 ships these**.
- Retrofitting every pre-existing handler to consume `snapshot.current()` per request so the apiKey change reaches every endpoint — **Plan 12 or a focused follow-on ships this**.

Plan 12's UI consumes these endpoints unchanged; no API churn between Plan 11 and Plan 12.

## Deviations from the as-designed plan

These minor adjustments landed during execution. None alter the externally observable API surface; all are documented for the next plan's authors.

1. **`src/admin/configValidate.ts` simplification.** Plan 11 Task 4 sketched a fallback that duplicated the Zod `InstanceSchema` literal in case `ConfigSchema` was not exported from `src/config.ts`. The export change Task 4 calls out as a "small one-line edit" was applied first (`const ConfigSchema = ...` → `export const ConfigSchema = ...`), so the duplicate schema literal was unnecessary and removed. `configValidate.ts` now only re-exports `parseConfig(raw)` over the canonical schema. No behavior change; one less place to keep in sync.

2. **PATCH null-stripping inside array elements.** Strict RFC 7396 says arrays are atomic replacements with no element-level merge — a literal `null` field inside an array element survives into the merged result. Plan 11's test for the PATCH happy path sends `lmstudio.instances: [{ ..., apiKey: null }]` and expects the resulting instance to have `apiKey: ""` (Zod's default). To honor that expectation while keeping arrays atomic at the array level, the PATCH handler runs a post-merge `stripNullsInArrays` pass that recursively removes `null`-valued keys from array elements before Zod validation. Zod's `.default(...)` then re-populates the cleared fields. This is a small extension of RFC 7396's deletion semantic; the array-as-atomic-replacement rule is unchanged. Documented in `src/admin/config.ts` alongside the helper.

3. **Integration test fixtures retrofitted for `configSnapshot`.** Adding `configSnapshot` to `ServerDeps` made three pre-existing integration fixtures (`tests/integration/messages.test.ts`, `tests/integration/openaiShim/chatCompletions.test.ts`, `tests/integration/openaiShim/embeddings.test.ts`) crash at runtime — they previously called `buildApp({ config, registry, archive } as never)` and the new mount unconditionally dereferences `deps.configSnapshot.current()`. Each fixture got a one-line `new ConfigSnapshotStore({ initial: config, path: ... })` and the snapshot threaded into the `buildApp` call. The fixtures continue to use the `as never` cast that pre-dates Plan 11 — full type-safe rewrites are a separate cleanup. No new tests added; no existing tests altered in intent.

4. **Backends-test count: 12, not 13.** Plan 11's Task 3 step 4 estimates 13 tests for `tests/unit/admin/backends.test.ts`; the actual file has 12 (2 auth + 2 list + 3 reprobe + 5 test-endpoint). The README's "+50 tests" total accounts for this. No functional gap — every behavior the plan describes is covered.

5. **Per-backend `BackendId` import removal in `src/admin/backends.ts`.** The plan's code block in Task 3 Step 3 imports `Backend` from `../backends/types.js`, but the implementation file does not use the `Backend` type directly (only `BackendCapabilities`, `BackendId`, `ModelDescriptor` are referenced). The unused import was elided to keep `noUncheckedIndexedAccess` + `noUnusedParameters` happy. Behavior unchanged.
