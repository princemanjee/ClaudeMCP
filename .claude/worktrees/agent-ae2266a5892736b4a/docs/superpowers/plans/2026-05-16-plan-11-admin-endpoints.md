# Plan 11: Admin REST Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the remaining admin REST endpoints — `/admin/backends`, `/admin/backends/reprobe`, `/admin/backends/test`, `/admin/config` (GET/PUT/PATCH) — so that Plan 12's glassmorphism admin UI has a complete JSON surface to consume. The `/admin/archive*` family already shipped in Plan 05; this plan layers the backend-introspection and config-editing routes on top of the same handler-factory pattern. It also introduces the localhost-bind middleware (`config.adminUi.bindLocalhost`) that fences ALL admin routes (archive + backends + config + future ui) behind a per-request remote-address check, and it ships the atomic write-and-rename discipline for `configs/default.json` that the spec calls out. The result: a UI can list backends with capability matrices, force a reprobe, test a candidate URL before saving, read the current config (with the API key redacted), and PUT/PATCH the config with Zod validation and in-flight-snapshot semantics.

**Architecture:** Two new handler factory modules under `src/admin/` — `src/admin/backends.ts` and `src/admin/config.ts` — both following the Plan 05 `src/admin/archive.ts` shape (`createXxxHandlers(deps)` returns a `RequestHandler` set; auth via the shared `apiKey` through `checkAuth`; Anthropic-shaped error envelopes from `src/anthropicShim/errors.ts`). The localhost-bind enforcement lives in a small middleware (`bindLocalhostMiddleware`) constructed once and applied to every admin route before its handler runs. Config snapshotting uses a `currentConfig: () => Config` getter that handlers capture at construction; `PUT`/`PATCH` swap the active snapshot atomically by mutating a `let snapshot` cell inside a `ConfigSnapshotStore` class, after the atomic write-and-rename to `configs/default.json` succeeds. In-flight requests (e.g., a slow `/v1/messages` call) keep their old snapshot because handler factories that take `config` directly (the existing `/v1/messages`, `/v1/files`, `/admin/archive`, etc.) already captured it at startup — Plan 11 does NOT retrofit those handlers to follow the new getter pattern. That is a Plan 12 / follow-on concern; for Plan 11 the in-flight-snapshot semantics apply specifically to handlers built **after** the live snapshot lands (the admin-config endpoints themselves, which use the getter). The plan documents this scope boundary explicitly in the "In-flight snapshot semantics" section below.

**Tech Stack:** Same as Plans 01-10 — Node.js 22+, TypeScript 5 (NodeNext ESM, `noUncheckedIndexedAccess`, explicit `.js` import suffixes), Express 4, Vitest + Supertest. **New runtime deps:** none. **New dev deps:** none. The atomic file write reuses the existing `node:fs` `openSync`/`writeSync`/`fsyncSync`/`renameSync` pattern from `src/fileStore.ts`. JSON-merge-patch (RFC 7396) is small enough to implement inline (~20 LOC) — no `fast-json-patch` or `json-merge-patch` dep.

**Spec:** `docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md` (Phase 11: admin endpoints, `/admin/backends*`, `/admin/config*`, localhost-bind middleware).

**Builds on:**
- Plan 01 (`docs/superpowers/plans/2026-05-16-plan-01-foundation.md`) — `Config` + `loadConfig` (Zod schema is the same one Plan 11 PUT validates against), `BackendRegistry` with `enabledBackends()` / `probe()` / `lastProbeStatus()`, `checkAuth` for shared-key auth, `Backend.capabilitiesFor(model)` + `Backend.listModels()` for surfacing capability matrices.
- Plan 05 (`docs/superpowers/plans/2026-05-16-plan-05-files-cache-archive.md`) — established the admin handler factory pattern (`src/admin/archive.ts`), the Anthropic-shaped error envelope reuse via `src/anthropicShim/errors.ts`, and the atomic write-and-rename discipline used here for `configs/default.json`.
- Plans 02-09 — the backends + shims whose state Plan 11 surfaces. None of those modules are modified by Plan 11; the registry already exposes everything needed.

**Reference plans (read these before starting):**
- `docs/superpowers/plans/2026-05-16-plan-05-files-cache-archive.md` — Task 10 (Admin archive handlers) is the closest structural mirror. Plan 11 reuses the exact auth + error envelope + supertest test layout.
- `docs/superpowers/plans/2026-05-16-plan-01-foundation.md` — for the Config Zod schema and `BackendRegistry` API.

---

## Scope boundary for Plan 11

What ships here:

| Feature | Plan 11 disposition |
|---|---|
| `GET /admin/backends` — list all enabled backend instances with their probe status, model list, capability matrix | Shipped via `src/admin/backends.ts` |
| `POST /admin/backends/reprobe` — trigger immediate `registry.probe()`; supports `?instance=<id>` for a single instance (best-effort; current registry probes all-or-nothing, so the query param is accepted but documented as forwarded-to-all in Plan 11) | Shipped with a documented limitation — see "Reprobe scope" below |
| `POST /admin/backends/test` — exercise a candidate `{baseUrl, apiKey?, useNativeApi?}` against `/v1/models` (compat) or `/api/tags` (native) without mutating config | Shipped — pure HTTP probe, no registry side effects |
| `GET /admin/config` — full config JSON; `apiKey` redacted to `"***"`; instance `apiKey` fields redacted likewise | Shipped via `src/admin/config.ts` |
| `PUT /admin/config` — Zod-validated full replacement; atomic write-and-rename to `configs/default.json`; swaps live snapshot for new requests; in-flight requests retain old snapshot via the getter pattern | Shipped |
| `PATCH /admin/config` — JSON-merge-patch (RFC 7396) over current snapshot; Zod-validated; atomic write; swap | Shipped |
| `bindLocalhostMiddleware` — when `config.adminUi.bindLocalhost === true`, reject requests whose `req.ip` (resolved post-`trust proxy`) is not `127.0.0.1` / `::1` / `::ffff:127.0.0.1` with 403 | Shipped — applied uniformly to every admin route |
| `ConfigSnapshotStore` — tiny in-process holder with `current(): Config` getter + `replace(next): Config` setter that performs the atomic write before the swap | Shipped via `src/admin/configSnapshot.ts` |
| Atomic config write (write to `.tmp`, fsync, rename) matching the `src/fileStore.ts` pattern | Shipped — helper extracted into `src/admin/atomicWrite.ts` (or inlined; Task 4 decides) |
| Server wiring: mount the 6 new routes under the admin router with bindLocalhost applied, expose the `ConfigSnapshotStore` so future plans can subscribe | Shipped via `src/server.ts` extension |
| Unit + integration tests covering all six endpoints, the bindLocalhost rejection path, the in-flight-snapshot semantics, the atomic-write crash-survival guarantee | Shipped |

What this plan does NOT ship:

| Feature | Plan 11 disposition | Lands in |
|---|---|---|
| Admin SPA (HTML/JS/CSS) | Out of scope | Plan 12 |
| `/admin/ui` and `/admin/ui/*` static asset routes | Out of scope | Plan 12 |
| Session cookie / login flow / `sessionTtlMs` honoring | Out of scope (admin endpoints use the same `apiKey` as every other admin route) | Plan 12 |
| Retrofitting `/v1/messages`, `/v1/files`, `/admin/archive` to consume the new `currentConfig: () => Config` getter | Out of scope (in-flight-snapshot semantics for those handlers already work because they capture config at startup; only Plan 11's own admin-config handlers need the live getter) | Plan 12 or later |
| Subscriber pattern (EventEmitter) for downstream consumers of config snapshot changes | Out of scope — `ConfigSnapshotStore.replace()` returns the new snapshot synchronously; future plans can layer an EventEmitter on top if needed | Plan 12 |
| `POST /admin/backends/reprobe?instance=<id>` actually probing only one instance | Out of scope — current `BackendRegistry.probe()` is all-or-nothing. Plan 11 accepts the query param, validates it, but probes everything regardless and surfaces the limitation in the response under `_meta.reprobeScope: "all"` | Future plan; see "Reprobe scope" below |
| Embedded-models-only filter on `/admin/backends` | Out of scope — list returns every model; consumers can filter client-side | Plan 12 if needed |
| Cross-instance distinct entries for multi-instance LM Studio / Ollama in `/admin/backends` | Partial — the response aggregates per BackendId (the unit the registry currently surfaces). Sub-instance breakdown waits on a registry surface change | Future plan |
| Real-time push (WebSocket / SSE) of config or reachability changes | Out of scope — UI polls per spec | Future plan |
| Touching `/admin/archive*` | Out of scope — Plan 05's handlers remain unchanged | n/a |

---

## File map

| File | Change | Lines (approx.) |
|---|---|---|
| `src/admin/configSnapshot.ts` | NEW — `ConfigSnapshotStore` class with `current()`, `replace(next)`, plus the atomic write-to-tmp / fsync / rename helper. Holds the current `Config` in a `let snapshot` cell. Constructor takes the initial snapshot + the resolved `configs/default.json` path. | ~110 |
| `src/admin/bindLocalhost.ts` | NEW — `bindLocalhostMiddleware(getEnabled: () => boolean)` Express middleware. Returns 403 + Anthropic-shaped envelope when `getEnabled() === true` and the request is not from `127.0.0.1` / `::1` / `::ffff:127.0.0.1`. The `getEnabled` getter reads from the live `ConfigSnapshotStore` so toggling `adminUi.bindLocalhost` via PATCH takes effect for the next request. | ~70 |
| `src/admin/backends.ts` | NEW — handler factory `createAdminBackendsHandlers({registry, config})`. Three handlers: `list` (`GET /admin/backends`), `reprobe` (`POST /admin/backends/reprobe`), `test` (`POST /admin/backends/test`). The `test` handler performs an HTTP `fetch` against `<baseUrl>/v1/models` (compat) or `<baseUrl>/api/tags` (native) and returns `{ok, models?, error?, latencyMs}`. | ~230 |
| `src/admin/config.ts` | NEW — handler factory `createAdminConfigHandlers({snapshot, configSchema})`. Three handlers: `get` (`GET /admin/config`), `put` (`PUT /admin/config`), `patch` (`PATCH /admin/config`). GET deep-clones + redacts API keys before sending. PUT validates the body against the Zod schema and calls `snapshot.replace(...)`. PATCH applies RFC 7396 merge-patch to a copy of `snapshot.current()`, validates the result, then `snapshot.replace(...)`. | ~250 |
| `src/admin/router.ts` | NEW — small helper `mountAdminRoutes(app, deps)` that wires the bindLocalhost middleware + all six new routes + Plan 05's three archive routes under `/admin/*`. Keeps `src/server.ts` short and makes the test wiring trivial. | ~80 |
| `src/server.ts` | EXTEND — construct `ConfigSnapshotStore` at startup, build the bindLocalhost middleware against it, call `mountAdminRoutes(app, { ... })`, remove the inlined admin-archive mount block (moved into `router.ts`). The existing `ServerDeps` interface grows a `configSnapshot` field. | +40, -10 |
| `tests/unit/admin/configSnapshot.test.ts` | NEW — `current()` returns the initial snapshot; `replace(next)` swaps and persists; atomic write crash mid-rename leaves the original intact (simulated by inducing rename failure); successive `replace` calls deep-freeze. | ~180 |
| `tests/unit/admin/bindLocalhost.test.ts` | NEW — accepts `127.0.0.1`, `::1`, `::ffff:127.0.0.1`; rejects `127.0.0.2`, `10.0.0.5`, `192.168.1.20`; passes through when `getEnabled() === false`; uses the Anthropic-shaped 403 envelope. | ~150 |
| `tests/unit/admin/backends.test.ts` | NEW — list returns the expected shape across one or two registered backends; reprobe triggers `registry.probe()` (verified via a spy / counter); test endpoint succeeds against a mock model-listing fixture and fails cleanly on connection refused. | ~300 |
| `tests/unit/admin/config.test.ts` | NEW — GET redacts `apiKey` to `"***"` and instance apiKeys likewise; PUT rejects an invalid body (Zod surface); PUT updates `snapshot.current()` and writes to disk; PATCH merges a sub-tree; in-flight snapshot semantics — a handler closure captured the OLD snapshot via getter sees the OLD apiKey until it re-reads; atomic write survives a crash mid-rename. | ~340 |
| `tests/integration/adminEndpoints.test.ts` | NEW — full HTTP stack via supertest against `buildApp(...)`. (a) `bindLocalhost: true` rejects a request whose `req.ip` is `127.0.0.2` (simulated by setting `app.set("trust proxy", true)` + `X-Forwarded-For: 127.0.0.2`). (b) All six endpoints round-trip with `127.0.0.1`. (c) Config PUT changes the next request's behavior (e.g., `apiKey: "sk-new"` — old key now returns 401). | ~360 |
| `docs/plan-11-admin-endpoints-readme.md` | NEW — close-out doc summarizing what shipped, the file/endpoint surface, and the open questions. | ~120 |

---

## Pre-flight check

Before starting Task 1, confirm the Plans 01-10 baseline is in place and verify the assumptions Plan 11 builds on:

- [ ] `git log --oneline -10` shows the latest plan merged (Plan 09 or 10 depending on branch lineage) on or near the top.
- [ ] `npm test` passes the full suite with no skips.
- [ ] `npx tsc --noEmit` clean.
- [ ] `src/admin/archive.ts` exists and exports `createAdminArchiveHandlers` returning `{list, search, getById}` (Plan 05 deliverable).
- [ ] `src/anthropicShim/errors.ts` exports `authenticationError`, `invalidRequestError`, `notFoundError`, `internalServerError` (used by all admin handlers).
- [ ] `src/auth.ts` exports `checkAuth(carrier, apiKey)` + the `AuthCarrier` interface.
- [ ] `src/backends/registry.ts` exposes `enabledBackends()`, `probe(): Promise<ProbeOutcome>`, `lastProbeStatus(id): ProbeStatus | undefined`. If the registry API differs, Task 5 (the `backends` handler) adapts; the rest of the plan stays unchanged.
- [ ] `src/backends/types.ts` exports `Backend.capabilitiesFor(model: string): BackendCapabilities` and `Backend.listModels(): Promise<ModelDescriptor[]>`.
- [ ] `src/config.ts` exports the `Config` type and `loadConfig(path)` returning a deep-frozen snapshot. The Zod schema is the source of truth for PUT/PATCH validation.
- [ ] `configs/default.json` exists and is the writable target for PUT/PATCH (the path is resolved from the bootstrap, not hardcoded in handlers — Task 9 passes the path through `ServerDeps`).
- [ ] `node --version` reports `v22.x` or later (the project already assumes this; admin endpoints add no new Node version constraints).
- [ ] `tests/unit/admin/` directory exists from Plan 05 — new test files for Plan 11 go alongside Plan 05's `archive.test.ts`.

If any check fails, stop and resolve before proceeding.

---

## In-flight snapshot semantics (read before Task 1)

The spec mandates: "PUT/PATCH takes effect for new requests immediately, in-flight requests keep their old snapshot." Plan 11 implements this as follows:

**For the admin-config handlers (the ones built by Plan 11):**

Each handler captures the `ConfigSnapshotStore` (not a `Config` value) at construction. Every request reads `snapshot.current()` at request entry. After `snapshot.replace(next)` returns, the **next** request to land sees the new snapshot; an in-flight request that already entered the handler and saved its local `const cfg = snapshot.current()` continues to use the old snapshot through its full lifecycle.

**For pre-existing handlers (archive, files, messages, etc.):**

These were built in Plans 03/05/etc. with a `config: Config` parameter at construction. They captured the snapshot at server startup and never re-read it. Plan 11 does NOT retrofit them to use the getter. Consequence: PUT/PATCH against `/admin/config` updates `configs/default.json` on disk and the live snapshot held by Plan 11's own handlers, BUT existing handlers continue to serve requests against their old captured config until the server restarts.

This is intentional — retrofitting every handler to consume a live getter is a larger refactor that touches every Plan 02-10 module. Plan 12 (or a follow-on) can do that refactor when the UI exists to drive it. For Plan 11, the spec's in-flight-snapshot semantics are honored for the **admin-config endpoints themselves**, which is what the UI cares about (the UI reads `/admin/config` → edits → PATCH → re-reads `/admin/config` → sees the edits reflected).

The close-out README documents this scope boundary explicitly so future plans can budget the retrofit.

---

## Reprobe scope (read before Task 5)

The spec calls for `POST /admin/backends/reprobe?instance=lmstudio:work-server` to force a single-instance reprobe. The current `BackendRegistry.probe()` is all-or-nothing — it iterates every registered backend in parallel and rebuilds the full model map. Plan 11 accepts the `?instance=<id>` query param, validates it (returns 400 if it doesn't match a known instance), but always calls `registry.probe()` (which probes all backends). The response includes `_meta.reprobeScope: "all"` so the UI knows. Future plans can add a per-instance probe API to the registry; Plan 11 doesn't touch backend code.

This matches the spec's "supports `?instance=lmstudio:work-server` for one" with a documented limitation. Tests exercise both the all-backend path and the with-instance-param path.

---

## Task 1: ConfigSnapshotStore — atomic-write-then-swap

**Files:**
- Create: `src/admin/configSnapshot.ts`
- Test: `tests/unit/admin/configSnapshot.test.ts`

The in-process holder for the live config snapshot. Wraps a `let snapshot: Config` cell, exposes a `current(): Config` getter, and ships a `replace(next: Config): Config` method that performs the atomic write-to-tmp / fsync / rename to `configs/default.json` BEFORE swapping the cell. If the write throws, the cell is unchanged. After a successful swap, returns the new snapshot (deep-frozen).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/admin/configSnapshot.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigSnapshotStore } from "../../../src/admin/configSnapshot.js";
import { loadConfig, type Config } from "../../../src/config.js";

const BASE_CONFIG = {
  apiKey: "sk-initial",
  claude: { enabled: true, command: "claude", priority: 100, timeoutMs: 600000 },
  gemini: { enabled: false, command: "gemini", priority: 90, timeoutMs: 600000 },
  lmstudio: { enabled: false, instances: [] },
  ollama: { enabled: false, useNativeApi: false, instances: [] }
};

function makeSeed(dir: string, overrides: Record<string, unknown> = {}): {
  cfgPath: string;
  cfg: Config;
} {
  const cfgPath = join(dir, "default.json");
  writeFileSync(cfgPath, JSON.stringify({ ...BASE_CONFIG, ...overrides }));
  return { cfgPath, cfg: loadConfig(cfgPath) };
}

describe("ConfigSnapshotStore — current() + replace()", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-snapshot-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("current() returns the initial snapshot deep-frozen", () => {
    const { cfgPath, cfg } = makeSeed(dir);
    const store = new ConfigSnapshotStore({ initial: cfg, path: cfgPath });
    expect(store.current()).toEqual(cfg);
    expect(Object.isFrozen(store.current())).toBe(true);
  });

  it("replace() writes the new config to disk before swapping in memory", () => {
    const { cfgPath, cfg } = makeSeed(dir);
    const store = new ConfigSnapshotStore({ initial: cfg, path: cfgPath });
    const next = { ...cfg, apiKey: "sk-rotated" } as Config;
    const returned = store.replace(next);
    expect(returned.apiKey).toBe("sk-rotated");
    expect(store.current().apiKey).toBe("sk-rotated");
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(onDisk.apiKey).toBe("sk-rotated");
  });

  it("replace() leaves the old snapshot in memory when the disk write throws", () => {
    const { cfgPath, cfg } = makeSeed(dir);
    const store = new ConfigSnapshotStore({ initial: cfg, path: cfgPath });
    // Point the store at a path inside a now-deleted directory to force EIO on rename.
    rmSync(dir, { recursive: true, force: true });
    expect(() => store.replace({ ...cfg, apiKey: "sk-doomed" } as Config)).toThrow();
    expect(store.current().apiKey).toBe("sk-initial");
  });

  it("replace() returns a deep-frozen snapshot", () => {
    const { cfgPath, cfg } = makeSeed(dir);
    const store = new ConfigSnapshotStore({ initial: cfg, path: cfgPath });
    const returned = store.replace({ ...cfg, apiKey: "sk-frozen" } as Config);
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned.claude)).toBe(true);
  });

  it("atomic write: tmp file is not left behind on success", () => {
    const { cfgPath, cfg } = makeSeed(dir);
    const store = new ConfigSnapshotStore({ initial: cfg, path: cfgPath });
    store.replace({ ...cfg, apiKey: "sk-clean" } as Config);
    expect(existsSync(`${cfgPath}.tmp`)).toBe(false);
  });
});

describe("ConfigSnapshotStore — crash mid-rename", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-snapshot-crash-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("simulated crash between tmp-write and rename leaves the original config intact", () => {
    const { cfgPath, cfg } = makeSeed(dir);
    // Write a sentinel via the tmp path that would normally be renamed.
    const tmpPath = `${cfgPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ apiKey: "sk-crash-attempt" }));
    // A future process boot reads the live path, NOT the tmp file. Verify.
    const reloaded = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(reloaded.apiKey).toBe("sk-initial");
    // And: instantiating a fresh store from the live path returns the original.
    const fresh = new ConfigSnapshotStore({
      initial: loadConfig(cfgPath),
      path: cfgPath
    });
    expect(fresh.current().apiKey).toBe("sk-initial");
    // Cleanup the orphan tmp; future Plan-12 startup hygiene can add an
    // explicit "remove leftover .tmp on boot" sweep, but Plan 11 leaves it.
    rmSync(tmpPath, { force: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/admin/configSnapshot.test.ts`
Expected: FAIL — module `src/admin/configSnapshot.js` not found.

- [ ] **Step 3: Create `src/admin/configSnapshot.ts`**

```ts
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  writeSync
} from "node:fs";
import type { Config } from "../config.js";

export interface ConfigSnapshotStoreOptions {
  initial: Config;
  path: string;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function atomicWriteJson(path: string, payload: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * In-process holder for the live config snapshot. Atomic-writes the new
 * config to `configs/default.json` BEFORE swapping the in-memory cell so a
 * disk-write failure leaves the old snapshot intact.
 *
 * The admin-config handlers (Plan 11) capture this store at construction and
 * call `current()` per request. Pre-existing handlers (archive, files,
 * messages) captured a `Config` value directly at startup and are NOT
 * retrofitted by Plan 11 — see the plan's "In-flight snapshot semantics"
 * section for the scope boundary.
 */
export class ConfigSnapshotStore {
  private snapshot: Config;
  private readonly path: string;

  constructor(opts: ConfigSnapshotStoreOptions) {
    this.snapshot = deepFreeze({ ...opts.initial });
    this.path = opts.path;
  }

  current(): Config {
    return this.snapshot;
  }

  /**
   * Atomic write-then-swap. If the disk write throws, the in-memory snapshot
   * is unchanged and the exception propagates. On success the new snapshot is
   * returned (and is the value subsequent `current()` calls will see).
   */
  replace(next: Config): Config {
    const payload = JSON.stringify(next, null, 2);
    atomicWriteJson(this.path, payload);
    this.snapshot = deepFreeze({ ...next });
    return this.snapshot;
  }

  /** The resolved on-disk path (exposed for diagnostics + tests). */
  configPath(): string {
    return this.path;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/admin/configSnapshot.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/admin/configSnapshot.ts tests/unit/admin/configSnapshot.test.ts
git commit -m "feat(admin): add ConfigSnapshotStore with atomic write-then-swap"
```

---

## Task 2: bindLocalhost middleware

**Files:**
- Create: `src/admin/bindLocalhost.ts`
- Test: `tests/unit/admin/bindLocalhost.test.ts`

When `config.adminUi.bindLocalhost === true`, every admin route must reject non-localhost requests with a 403. The check runs against `req.ip` (Express normalizes IPv4-mapped IPv6 addresses to `::ffff:127.0.0.1`). The middleware accepts a `getEnabled: () => boolean` getter so toggling `adminUi.bindLocalhost` via PATCH takes effect for the next request without reconstructing handlers.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/admin/bindLocalhost.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { bindLocalhostMiddleware } from "../../../src/admin/bindLocalhost.js";

function buildApp(getEnabled: () => boolean, trustProxy = false): express.Express {
  const app = express();
  if (trustProxy) app.set("trust proxy", true);
  app.use(bindLocalhostMiddleware(getEnabled));
  app.get("/probe", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe("bindLocalhostMiddleware — disabled", () => {
  it("passes every request through when getEnabled() returns false", async () => {
    const res = await request(buildApp(() => false))
      .get("/probe")
      .set("X-Forwarded-For", "10.0.0.5");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("bindLocalhostMiddleware — enabled", () => {
  it("accepts 127.0.0.1 (the supertest default)", async () => {
    const res = await request(buildApp(() => true)).get("/probe");
    expect(res.status).toBe(200);
  });

  it("rejects a request whose forwarded ip is 127.0.0.2", async () => {
    const app = buildApp(() => true, true);
    const res = await request(app)
      .get("/probe")
      .set("X-Forwarded-For", "127.0.0.2");
    expect(res.status).toBe(403);
    expect(res.body.type).toBe("error");
    expect(res.body.error.type).toBe("authentication_error");
    expect(res.body.error.message).toMatch(/localhost/i);
  });

  it("rejects a request whose forwarded ip is 10.0.0.5", async () => {
    const app = buildApp(() => true, true);
    const res = await request(app)
      .get("/probe")
      .set("X-Forwarded-For", "10.0.0.5");
    expect(res.status).toBe(403);
  });

  it("rejects a request whose forwarded ip is 192.168.1.20", async () => {
    const app = buildApp(() => true, true);
    const res = await request(app)
      .get("/probe")
      .set("X-Forwarded-For", "192.168.1.20");
    expect(res.status).toBe(403);
  });

  it("accepts ::1", async () => {
    // Supertest's underlying superagent does not let us spoof req.ip directly
    // without trust-proxy + X-Forwarded-For. Use the forwarded variant.
    const app = buildApp(() => true, true);
    const res = await request(app)
      .get("/probe")
      .set("X-Forwarded-For", "::1");
    expect(res.status).toBe(200);
  });

  it("accepts ::ffff:127.0.0.1 (IPv4-mapped IPv6)", async () => {
    const app = buildApp(() => true, true);
    const res = await request(app)
      .get("/probe")
      .set("X-Forwarded-For", "::ffff:127.0.0.1");
    expect(res.status).toBe(200);
  });

  it("re-evaluates getEnabled() per request (toggle without reconstruction)", async () => {
    let enabled = true;
    const app = buildApp(() => enabled, true);
    const blocked = await request(app)
      .get("/probe")
      .set("X-Forwarded-For", "10.0.0.5");
    expect(blocked.status).toBe(403);
    enabled = false;
    const allowed = await request(app)
      .get("/probe")
      .set("X-Forwarded-For", "10.0.0.5");
    expect(allowed.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/admin/bindLocalhost.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/admin/bindLocalhost.ts`**

```ts
import type { RequestHandler } from "express";
import { authenticationError } from "../anthropicShim/errors.js";

const LOCAL_IPS = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1"
]);

/**
 * When `getEnabled()` returns true, rejects any request whose `req.ip` is not
 * a recognized localhost address with HTTP 403 + an Anthropic-shaped error
 * envelope. The getter is re-evaluated per request so toggling
 * `adminUi.bindLocalhost` via PATCH takes effect without reconstructing the
 * middleware.
 *
 * For accurate `req.ip` against an X-Forwarded-For header (e.g., when a test
 * needs to simulate a non-127.0.0.1 source), the app must `app.set("trust
 * proxy", true)`. Plan 11's server bootstrap does not enable trust-proxy in
 * production by default — the spec specifies bindLocalhost is for direct-
 * connection deployments. Operators behind a reverse proxy should disable
 * bindLocalhost or enable trust-proxy explicitly.
 */
export function bindLocalhostMiddleware(
  getEnabled: () => boolean
): RequestHandler {
  return (req, res, next) => {
    if (!getEnabled()) {
      next();
      return;
    }
    const ip = req.ip ?? "";
    if (LOCAL_IPS.has(ip)) {
      next();
      return;
    }
    res
      .status(403)
      .json(
        authenticationError(
          `admin endpoints are bound to localhost only; rejecting request from ${ip || "<unknown>"}`
        )
      );
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/admin/bindLocalhost.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/admin/bindLocalhost.ts tests/unit/admin/bindLocalhost.test.ts
git commit -m "feat(admin): add bindLocalhostMiddleware fencing admin routes to 127.0.0.1 / ::1"
```

---

## Task 3: Admin backends handlers — list, reprobe, test

**Files:**
- Create: `src/admin/backends.ts`
- Test: `tests/unit/admin/backends.test.ts`

Three endpoints under `/admin/backends*`:

- `GET /admin/backends` — list every registered backend. For each backend: id, enabled status, last probe status (timestamp + ok flag + error if any), discovered models (id + descriptor fields), capability matrix per model.
- `POST /admin/backends/reprobe` — force `registry.probe()`. Accepts `?instance=<id>` query param (validated; returns 400 if no matching backend). Response shape mirrors `GET /admin/backends` so the UI can refresh state in one round-trip. Includes `_meta.reprobeScope: "all"` to document the current limitation.
- `POST /admin/backends/test` — POST body `{ baseUrl: string, apiKey?: string, useNativeApi?: boolean }`. Performs an HTTP `fetch` against `<baseUrl>/v1/models` (compat) or `<baseUrl>/api/tags` (native). Returns `{ ok: boolean, models?: string[], error?: string, latencyMs: number }`. Does NOT mutate config or registry.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/admin/backends.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createAdminBackendsHandlers } from "../../../src/admin/backends.js";
import type { BackendRegistry, ProbeStatus } from "../../../src/backends/registry.js";
import type {
  Backend,
  BackendCapabilities,
  BackendId,
  ModelDescriptor
} from "../../../src/backends/types.js";

function fakeBackend(id: BackendId, models: ModelDescriptor[]): Backend {
  const caps: BackendCapabilities = {
    toolUse: true,
    multimodal: false,
    thinking: false,
    cacheControl: "none",
    samplingParams: { temperature: true, topP: true, topK: false },
    stopSequences: "native",
    embeddings: id === "lmstudio" || id === "ollama"
  };
  return {
    id,
    capabilitiesFor: () => caps,
    listModels: async () => models,
    invoke: async function* () {
      // not exercised in these tests
    },
    countTokens: async () => 0
  };
}

function fakeRegistry(opts: {
  backends: Backend[];
  statuses?: Map<BackendId, ProbeStatus>;
  probeImpl?: () => Promise<unknown>;
}): BackendRegistry {
  const map = new Map<BackendId, Backend>(opts.backends.map((b) => [b.id, b]));
  const statuses = opts.statuses ?? new Map<BackendId, ProbeStatus>();
  const stub = {
    get: (id: BackendId) => map.get(id),
    enabledBackends: () => Array.from(map.values()),
    resolveModel: () => undefined,
    lastProbeStatus: (id: BackendId) => statuses.get(id),
    probe: opts.probeImpl ?? (async () => ({ successes: [], failures: [] })),
    register: () => {},
    startPeriodicProbe: () => {},
    stop: () => {}
  } as unknown as BackendRegistry;
  return stub;
}

function buildApp(deps: { registry: BackendRegistry; apiKey: string }): express.Express {
  const app = express();
  app.use(express.json());
  const h = createAdminBackendsHandlers({
    registry: deps.registry,
    config: { apiKey: deps.apiKey }
  });
  app.get("/admin/backends", h.list);
  app.post("/admin/backends/reprobe", h.reprobe);
  app.post("/admin/backends/test", h.test);
  return app;
}

describe("/admin/backends — auth", () => {
  it("returns 401 on missing api key", async () => {
    const reg = fakeRegistry({ backends: [fakeBackend("claude", [])] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" })).get(
      "/admin/backends"
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 on wrong api key", async () => {
    const reg = fakeRegistry({ backends: [fakeBackend("claude", [])] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .get("/admin/backends")
      .set("x-api-key", "wrong");
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/backends", () => {
  it("lists every registered backend with id, models, capabilities, probe status", async () => {
    const claude = fakeBackend("claude", [
      { id: "claude-opus-4-7", supportsTools: true, supportsVision: true }
    ]);
    const lm = fakeBackend("lmstudio", [{ id: "qwen3-coder-30b" }]);
    const statuses = new Map<BackendId, ProbeStatus>([
      ["claude", { ok: true, lastProbedAt: new Date("2026-05-16T12:00:00Z") }],
      [
        "lmstudio",
        {
          ok: false,
          lastProbedAt: new Date("2026-05-16T12:01:00Z"),
          error: "connection refused"
        }
      ]
    ]);
    const reg = fakeRegistry({ backends: [claude, lm], statuses });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .get("/admin/backends")
      .set("x-api-key", "sk-x");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const claudeEntry = res.body.data.find((e: { id: string }) => e.id === "claude");
    expect(claudeEntry).toBeDefined();
    expect(claudeEntry.models.map((m: { id: string }) => m.id)).toEqual([
      "claude-opus-4-7"
    ]);
    expect(claudeEntry.lastProbe.ok).toBe(true);
    expect(claudeEntry.lastProbe.at).toBe("2026-05-16T12:00:00.000Z");
    expect(claudeEntry.reachable).toBe(true);
    expect(claudeEntry.capabilities["claude-opus-4-7"]).toMatchObject({
      toolUse: true,
      embeddings: false
    });

    const lmEntry = res.body.data.find((e: { id: string }) => e.id === "lmstudio");
    expect(lmEntry.lastProbe.ok).toBe(false);
    expect(lmEntry.lastProbe.error).toBe("connection refused");
    expect(lmEntry.reachable).toBe(false);
    expect(lmEntry.capabilities["qwen3-coder-30b"].embeddings).toBe(true);
  });

  it("returns lastProbe: null for backends never probed", async () => {
    const reg = fakeRegistry({ backends: [fakeBackend("gemini", [])] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .get("/admin/backends")
      .set("x-api-key", "sk-x");
    const entry = res.body.data[0];
    expect(entry.lastProbe).toBeNull();
    expect(entry.reachable).toBe(false);
  });
});

describe("POST /admin/backends/reprobe", () => {
  it("calls registry.probe() and returns the refreshed listing", async () => {
    let probeCalls = 0;
    const reg = fakeRegistry({
      backends: [fakeBackend("claude", [{ id: "claude-opus-4-7" }])],
      probeImpl: async () => {
        probeCalls += 1;
        return { successes: [], failures: [] };
      }
    });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .post("/admin/backends/reprobe")
      .set("x-api-key", "sk-x")
      .send({});
    expect(res.status).toBe(200);
    expect(probeCalls).toBe(1);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body._meta.reprobeScope).toBe("all");
  });

  it("validates ?instance against the known backend ids; 400 if unknown", async () => {
    const reg = fakeRegistry({ backends: [fakeBackend("claude", [])] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .post("/admin/backends/reprobe?instance=mystery")
      .set("x-api-key", "sk-x")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("invalid_request_error");
  });

  it("accepts ?instance=<known backend id> and surfaces the all-scope note", async () => {
    const reg = fakeRegistry({ backends: [fakeBackend("claude", [])] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .post("/admin/backends/reprobe?instance=claude")
      .set("x-api-key", "sk-x")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body._meta.reprobeScope).toBe("all");
    expect(res.body._meta.requestedInstance).toBe("claude");
  });
});

describe("POST /admin/backends/test", () => {
  // We mock global.fetch for this describe block.
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns ok:true with models when /v1/models responds 200", async () => {
    global.fetch = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "qwen3-coder-30b" }, { id: "llama-3.3-70b" }] })
    })) as unknown as typeof fetch;
    const reg = fakeRegistry({ backends: [] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .post("/admin/backends/test")
      .set("x-api-key", "sk-x")
      .send({ baseUrl: "http://10.0.0.5:1234" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.models).toEqual(["qwen3-coder-30b", "llama-3.3-70b"]);
    expect(typeof res.body.latencyMs).toBe("number");
  });

  it("returns ok:false with error when fetch rejects (connection refused)", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const reg = fakeRegistry({ backends: [] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .post("/admin/backends/test")
      .set("x-api-key", "sk-x")
      .send({ baseUrl: "http://10.0.0.5:1234" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/ECONNREFUSED/);
  });

  it("hits /api/tags when useNativeApi is true", async () => {
    const seen: string[] = [];
    global.fetch = vi.fn(async (url: string) => {
      seen.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [{ name: "llama3.2" }, { name: "qwen2.5" }]
        })
      };
    }) as unknown as typeof fetch;
    const reg = fakeRegistry({ backends: [] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .post("/admin/backends/test")
      .set("x-api-key", "sk-x")
      .send({ baseUrl: "http://10.0.0.5:11434", useNativeApi: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.models).toEqual(["llama3.2", "qwen2.5"]);
    expect(seen[0]).toMatch(/\/api\/tags$/);
  });

  it("400 on missing baseUrl", async () => {
    const reg = fakeRegistry({ backends: [] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .post("/admin/backends/test")
      .set("x-api-key", "sk-x")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("invalid_request_error");
  });

  it("forwards apiKey in the Authorization header when provided", async () => {
    let seenAuth: string | undefined;
    global.fetch = vi.fn(async (_url: string, init: { headers?: Record<string, string> } = {}) => {
      seenAuth = init.headers?.["Authorization"];
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }) as unknown as typeof fetch;
    const reg = fakeRegistry({ backends: [] });
    await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .post("/admin/backends/test")
      .set("x-api-key", "sk-x")
      .send({ baseUrl: "http://10.0.0.5:1234", apiKey: "lm-studio-token" });
    expect(seenAuth).toBe("Bearer lm-studio-token");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/admin/backends.test.ts`
Expected: FAIL — module `src/admin/backends.js` not found.

- [ ] **Step 3: Create `src/admin/backends.ts`**

```ts
import type { Request, RequestHandler, Response } from "express";
import { checkAuth, type AuthCarrier } from "../auth.js";
import type { BackendRegistry } from "../backends/registry.js";
import type {
  Backend,
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/admin/backends.test.ts`
Expected: PASS — all 13 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/admin/backends.ts tests/unit/admin/backends.test.ts
git commit -m "feat(admin): add /admin/backends list/reprobe/test handlers"
```

---

## Task 4: Admin config handlers — GET (redacted) / PUT / PATCH

**Files:**
- Create: `src/admin/config.ts`
- Test: `tests/unit/admin/config.test.ts`

Three endpoints under `/admin/config`:

- `GET /admin/config` — returns the live snapshot with `apiKey` redacted to `"***"`. Instance `apiKey` fields within `lmstudio.instances[]` and `ollama.instances[]` are likewise redacted.
- `PUT /admin/config` — body is a full config object; validated via the Zod schema; on success: `snapshot.replace(...)` writes to disk and swaps. On validation failure: 400 with a structured error listing the invalid paths.
- `PATCH /admin/config` — body is an RFC 7396 JSON-merge-patch; applied to a deep copy of `snapshot.current()`; result is Zod-validated; on success: same atomic swap. On validation failure: 400 likewise.

A redacted GET should NEVER be acceptable input to PUT (the `"***"` would round-trip and lock the API key). PUT validates that the apiKey is not literally `"***"`; if so, returns 400 with a helpful message asking the caller to either supply the real key or use PATCH for granular updates.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/admin/config.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";
import { ConfigSnapshotStore } from "../../../src/admin/configSnapshot.js";
import { createAdminConfigHandlers } from "../../../src/admin/config.js";
import { loadConfig, type Config } from "../../../src/config.js";

const BASE = {
  apiKey: "sk-initial",
  claude: { enabled: true, command: "claude", priority: 100, timeoutMs: 600000 },
  gemini: { enabled: false, command: "gemini", priority: 90, timeoutMs: 600000 },
  lmstudio: {
    enabled: false,
    instances: [
      {
        name: "local",
        baseUrl: "http://127.0.0.1:1234",
        apiKey: "lm-secret",
        priority: 50,
        timeoutMs: 300000,
        useNativeApi: null
      }
    ]
  },
  ollama: { enabled: false, useNativeApi: false, instances: [] }
};

function seedSnapshot(dir: string, overrides: Record<string, unknown> = {}): {
  store: ConfigSnapshotStore;
  cfgPath: string;
  initial: Config;
} {
  const cfgPath = join(dir, "default.json");
  writeFileSync(cfgPath, JSON.stringify({ ...BASE, ...overrides }));
  const initial = loadConfig(cfgPath);
  const store = new ConfigSnapshotStore({ initial, path: cfgPath });
  return { store, cfgPath, initial };
}

function buildApp(store: ConfigSnapshotStore): express.Express {
  const app = express();
  app.use(express.json());
  const h = createAdminConfigHandlers({ snapshot: store });
  app.get("/admin/config", h.get);
  app.put("/admin/config", h.put);
  app.patch("/admin/config", h.patch);
  return app;
}

describe("/admin/config — auth", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-cfg-auth-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("401 on missing api key", async () => {
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store)).get("/admin/config");
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/config — redaction", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-cfg-get-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("redacts apiKey to ***", async () => {
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store))
      .get("/admin/config")
      .set("x-api-key", "sk-initial");
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toBe("***");
  });

  it("redacts instance apiKey fields", async () => {
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store))
      .get("/admin/config")
      .set("x-api-key", "sk-initial");
    expect(res.body.lmstudio.instances[0].apiKey).toBe("***");
  });

  it("does NOT mutate the underlying snapshot", async () => {
    const { store } = seedSnapshot(dir);
    await request(buildApp(store))
      .get("/admin/config")
      .set("x-api-key", "sk-initial");
    expect(store.current().apiKey).toBe("sk-initial");
    expect(store.current().lmstudio.instances[0]?.apiKey).toBe("lm-secret");
  });
});

describe("PUT /admin/config", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-cfg-put-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("replaces the snapshot and writes to disk on a valid body", async () => {
    const { store, cfgPath } = seedSnapshot(dir);
    const next = { ...BASE, apiKey: "sk-rotated" };
    const res = await request(buildApp(store))
      .put("/admin/config")
      .set("x-api-key", "sk-initial")
      .send(next);
    expect(res.status).toBe(200);
    expect(store.current().apiKey).toBe("sk-rotated");
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(onDisk.apiKey).toBe("sk-rotated");
  });

  it("rejects an apiKey of literally *** (would lock the key)", async () => {
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store))
      .put("/admin/config")
      .set("x-api-key", "sk-initial")
      .send({ ...BASE, apiKey: "***" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/redacted/i);
    expect(store.current().apiKey).toBe("sk-initial");
  });

  it("rejects an invalid body via Zod (e.g., apiKey: empty string)", async () => {
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store))
      .put("/admin/config")
      .set("x-api-key", "sk-initial")
      .send({ ...BASE, apiKey: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("invalid_request_error");
  });

  it("leaves the snapshot unchanged when validation fails", async () => {
    const { store } = seedSnapshot(dir);
    await request(buildApp(store))
      .put("/admin/config")
      .set("x-api-key", "sk-initial")
      .send({ apiKey: "" });
    expect(store.current().apiKey).toBe("sk-initial");
  });
});

describe("PATCH /admin/config — JSON merge patch (RFC 7396)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-cfg-patch-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges a sub-tree without affecting siblings", async () => {
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store))
      .patch("/admin/config")
      .set("x-api-key", "sk-initial")
      .send({ claude: { timeoutMs: 900000 } });
    expect(res.status).toBe(200);
    expect(store.current().claude.timeoutMs).toBe(900000);
    expect(store.current().claude.command).toBe("claude");
    expect(store.current().apiKey).toBe("sk-initial");
  });

  it("explicit null removes a field (RFC 7396 semantics)", async () => {
    // Use a field where removal is legal (instance-level apiKey defaults to "").
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store))
      .patch("/admin/config")
      .set("x-api-key", "sk-initial")
      .send({
        lmstudio: {
          instances: [
            {
              name: "local",
              baseUrl: "http://127.0.0.1:1234",
              apiKey: null,
              priority: 50,
              timeoutMs: 300000,
              useNativeApi: null
            }
          ]
        }
      });
    // Note: PATCH on array elements is treated as full-array replacement per
    // RFC 7396 (arrays are not merged). The Zod default for instance apiKey is
    // empty string, so the result should be apiKey: "".
    expect(res.status).toBe(200);
    expect(store.current().lmstudio.instances[0]?.apiKey).toBe("");
  });

  it("validates the merged result and rolls back on invalid", async () => {
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store))
      .patch("/admin/config")
      .set("x-api-key", "sk-initial")
      .send({ apiKey: "" });
    expect(res.status).toBe(400);
    expect(store.current().apiKey).toBe("sk-initial");
  });

  it("rejects an apiKey of literally *** under PATCH too", async () => {
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store))
      .patch("/admin/config")
      .set("x-api-key", "sk-initial")
      .send({ apiKey: "***" });
    expect(res.status).toBe(400);
    expect(store.current().apiKey).toBe("sk-initial");
  });
});

describe("In-flight snapshot semantics", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-cfg-inflight-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("captured snapshot value continues to reflect the old apiKey after replace()", async () => {
    const { store } = seedSnapshot(dir);
    // Simulate an in-flight handler that captured cfg at request entry.
    const inFlightCfg = store.current();
    store.replace({ ...store.current(), apiKey: "sk-rotated" } as Config);
    expect(inFlightCfg.apiKey).toBe("sk-initial");
    expect(store.current().apiKey).toBe("sk-rotated");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/admin/config.test.ts`
Expected: FAIL — module `src/admin/config.js` not found.

- [ ] **Step 3: Create `src/admin/config.ts`**

```ts
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
    let validated: Config;
    try {
      validated = parseConfig(merged);
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
```

The handler imports `parseConfig` from a tiny helper module — Task 4 needs it because the existing `src/config.ts` only exports `loadConfig(path)` which reads from disk. We expose the Zod schema's `parse` separately so the admin handlers can validate in-memory bodies.

- [ ] **Step 4: Create `src/admin/configValidate.ts`**

```ts
import { z } from "zod";
import type { Config } from "../config.js";

// Re-export the same Zod schema used by loadConfig() for in-memory validation
// of PUT / PATCH bodies. This intentionally duplicates the schema literal
// rather than refactoring src/config.ts so Plan 11 stays surgical. A follow-on
// can hoist the schema to a shared module if a third consumer appears.
//
// IMPLEMENTATION NOTE for the agent: if `src/config.ts` already exports the
// raw ConfigSchema (or a `parseConfig` function), use that instead of the
// duplication below. Check first; this fallback exists only if the Plan-01
// module keeps the schema private.

// Duplicate of ConfigSchema from src/config.ts — kept in sync manually.
const InstanceSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().default(""),
  priority: z.number().int().default(50),
  timeoutMs: z.number().int().positive().default(300000),
  useNativeApi: z.boolean().nullable().default(null)
});

// NOTE: when the agent executes this task, prefer to import the live schema
// from src/config.ts if it's exported. If not, copy the full schema here and
// update src/config.ts to export `ConfigSchema` so future plans need not
// duplicate it (small one-line export change is acceptable).
import { ConfigSchema } from "../config.js";

export function parseConfig(raw: unknown): Config {
  return ConfigSchema.parse(raw);
}
```

If `ConfigSchema` is not currently exported from `src/config.ts`, add the export as a small inline edit:

```diff
-const ConfigSchema = z
+export const ConfigSchema = z
   .object({
```

Note this export change in the commit message. The Task 4 commit becomes a two-file change: `src/admin/configValidate.ts` + the `src/config.ts` export.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/admin/config.test.ts`
Expected: PASS — all 13 tests green.

- [ ] **Step 6: Commit**

```bash
git add src/admin/config.ts src/admin/configValidate.ts src/config.ts tests/unit/admin/config.test.ts
git commit -m "feat(admin): add /admin/config GET/PUT/PATCH handlers with Zod validation + redaction"
```

---

## Task 5: Admin router — mount all admin routes with bindLocalhost

**Files:**
- Create: `src/admin/router.ts`

A tiny helper that takes the Express app + a typed deps bundle and mounts every admin route in one place, with the bindLocalhost middleware applied uniformly. Keeps `src/server.ts` short and gives integration tests a single entry point.

- [ ] **Step 1: Create `src/admin/router.ts`**

```ts
import express, { type Express } from "express";
import type { BackendRegistry } from "../backends/registry.js";
import type { Archive } from "../archive.js";
import { createAdminArchiveHandlers } from "./archive.js";
import { createAdminBackendsHandlers } from "./backends.js";
import { createAdminConfigHandlers } from "./config.js";
import { bindLocalhostMiddleware } from "./bindLocalhost.js";
import type { ConfigSnapshotStore } from "./configSnapshot.js";

export interface MountAdminDeps {
  archive: Archive;
  registry: BackendRegistry;
  snapshot: ConfigSnapshotStore;
}

/**
 * Mounts every /admin/* route on the given app with the bindLocalhost
 * middleware applied uniformly. The middleware re-reads its enabled flag
 * from the live snapshot per request, so PATCHing adminUi.bindLocalhost takes
 * effect immediately for subsequent requests.
 *
 * Plan-05's archive routes are mounted here too (the inline mount that
 * previously lived in src/server.ts moves into this helper) so every admin
 * route sits behind the same fence with no duplication.
 */
export function mountAdminRoutes(app: Express, deps: MountAdminDeps): void {
  const router = express.Router();
  router.use(
    bindLocalhostMiddleware(() => deps.snapshot.current().adminUi.bindLocalhost)
  );

  // ---- /admin/archive (Plan 05) --------------------------------------
  const adminArchive = createAdminArchiveHandlers({
    archive: deps.archive,
    config: { apiKey: deps.snapshot.current().apiKey }
  });
  router.get("/archive", adminArchive.list);
  router.get("/archive/search", adminArchive.search);
  router.get("/archive/:id", adminArchive.getById);

  // ---- /admin/backends (Plan 11) -------------------------------------
  const adminBackends = createAdminBackendsHandlers({
    registry: deps.registry,
    config: { apiKey: deps.snapshot.current().apiKey }
  });
  router.get("/backends", adminBackends.list);
  router.post("/backends/reprobe", adminBackends.reprobe);
  router.post("/backends/test", adminBackends.test);

  // ---- /admin/config (Plan 11) ---------------------------------------
  const adminConfig = createAdminConfigHandlers({ snapshot: deps.snapshot });
  router.get("/config", adminConfig.get);
  router.put("/config", adminConfig.put);
  router.patch("/config", adminConfig.patch);

  app.use("/admin", router);
}
```

NOTE: the existing `/admin/archive*` handlers continue to authenticate against the static apiKey captured at construction (matching Plan 05's behavior). When the snapshot's apiKey changes via PUT/PATCH, the archive routes do NOT see the new key — only the new `/admin/config` routes do, because they re-read the snapshot per request. This is the explicit scope boundary from the "In-flight snapshot semantics" section: retrofitting archive (and the rest of the pre-existing handlers) is a Plan-12-or-later concern.

The admin-backends handler captures apiKey similarly. If a future plan retrofits these to consume the snapshot per request, a quick edit here changes both.

- [ ] **Step 2: Verify TypeScript still compiles**

Run: `npx tsc --noEmit`
Expected: Clean. No test file yet — the router is exercised by Task 6's integration tests.

- [ ] **Step 3: Commit**

```bash
git add src/admin/router.ts
git commit -m "feat(admin): add mountAdminRoutes helper wiring all admin routes behind bindLocalhost"
```

---

## Task 6: Server bootstrap — wire ConfigSnapshotStore + admin router

**Files:**
- Modify: `src/server.ts`

Construct `ConfigSnapshotStore` at startup, build the admin router against it, replace the inline `/admin/archive*` mounting with the `mountAdminRoutes` call.

- [ ] **Step 1: Edit `src/server.ts`**

Add imports:

```ts
import { ConfigSnapshotStore } from "./admin/configSnapshot.js";
import { mountAdminRoutes } from "./admin/router.js";
```

Remove the existing import that's no longer used directly:

```diff
-import { createAdminArchiveHandlers } from "./admin/archive.js";
```

Extend `ServerDeps`:

```ts
export interface ServerDeps {
  config: Config;
  registry: BackendRegistry;
  archive: Archive;
  fileStore: FileStore;
  responseCache: ResponseCache;
  configSnapshot: ConfigSnapshotStore;
}
```

Inside `buildApp`, replace the inline admin-archive mounting:

```diff
-  // ---- Admin archive ---------------------------------------------------
-  const adminArchive = createAdminArchiveHandlers({
-    archive: deps.archive,
-    config: { apiKey: deps.config.apiKey }
-  });
-  app.get("/admin/archive", adminArchive.list);
-  app.get("/admin/archive/search", adminArchive.search);
-  app.get("/admin/archive/:id", adminArchive.getById);
+  // ---- Admin routes (Plan 05 + Plan 11) -------------------------------
+  mountAdminRoutes(app, {
+    archive: deps.archive,
+    registry: deps.registry,
+    snapshot: deps.configSnapshot
+  });
```

In `main`, construct the snapshot after `loadConfig`:

```ts
  const config = loadConfig(opts.configPath);
  const configSnapshot = new ConfigSnapshotStore({
    initial: config,
    path: opts.configPath
  });
```

Pass it into `buildApp`:

```ts
  const app = buildApp({
    config,
    registry,
    archive,
    fileStore,
    responseCache,
    configSnapshot
  });
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
  configSnapshot: ConfigSnapshotStore;
  shutdown: () => Promise<void>;
}
```

And include `configSnapshot` in the returned object.

- [ ] **Step 2: Verify TypeScript still compiles**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 3: Verify existing tests still pass**

Run: `npx vitest run`
Expected: All tests green — Plan 05 + Plan 11's unit tests pass. The integration test from Plan 05 (`tests/integration/archive.test.ts`) continues to pass against the new mount path because `/admin/archive*` is still reachable at the same URL (the router prefix is `/admin` and the routes register relatively as `/archive`).

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): wire ConfigSnapshotStore and mount admin router with bindLocalhost"
```

---

## Task 7: Integration test — full HTTP stack for all admin endpoints

**Files:**
- Create: `tests/integration/adminEndpoints.test.ts`

End-to-end coverage via supertest against `buildApp(...)`. Three sub-suites:

1. **bindLocalhost enforcement** — `adminUi.bindLocalhost: true` rejects a forwarded-from-127.0.0.2 request with 403; toggling to false lets the same request through.
2. **Round-trip every endpoint** — every one of the six new routes returns a sensible 200 against the default-trust-localhost path. Confirms the router is mounted correctly and the handlers respond.
3. **PUT changes next request behavior** — PUT a new apiKey via `/admin/config`; verify the next `/admin/config` GET requires the new key.

- [ ] **Step 1: Write the test**

Create `tests/integration/adminEndpoints.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express, { type Express } from "express";
import request from "supertest";
import { buildApp, type ServerDeps } from "../../src/server.js";
import { ConfigSnapshotStore } from "../../src/admin/configSnapshot.js";
import { Archive } from "../../src/archive.js";
import { FileStore } from "../../src/fileStore.js";
import { ResponseCache } from "../../src/responseCache.js";
import { BackendRegistry } from "../../src/backends/registry.js";
import { loadConfig } from "../../src/config.js";

const BASE_CONFIG = {
  apiKey: "sk-integration",
  claude: { enabled: false, command: "claude", priority: 100, timeoutMs: 600000 },
  gemini: { enabled: false, command: "gemini", priority: 90, timeoutMs: 600000 },
  lmstudio: { enabled: false, instances: [] },
  ollama: { enabled: false, useNativeApi: false, instances: [] },
  adminUi: { enabled: true, bindLocalhost: true, sessionTtlMs: 3600000 }
};

interface Setup {
  dir: string;
  cfgPath: string;
  deps: ServerDeps;
}

function setup(overrides: Record<string, unknown> = {}): Setup {
  const dir = mkdtempSync(join(tmpdir(), "claudemcp-admin-it-"));
  const cfgPath = join(dir, "default.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      ...BASE_CONFIG,
      ...overrides,
      archive: { dbPath: join(dir, "archive.sqlite"), compressionLevel: 3 },
      files: { dir: join(dir, "files"), ttlMs: 60000, maxTotalBytes: 1_000_000 },
      cache: {
        file: join(dir, "cache.json"),
        ttlMs: 60000,
        maxEntries: 100
      }
    })
  );
  const config = loadConfig(cfgPath);
  const archive = new Archive(config.archive.dbPath);
  const fileStore = new FileStore({
    dir: config.files.dir,
    ttlMs: config.files.ttlMs,
    maxTotalBytes: config.files.maxTotalBytes,
    sweepIntervalMs: 0
  });
  const responseCache = new ResponseCache({
    file: config.cache.file,
    ttlMs: config.cache.ttlMs,
    maxEntries: config.cache.maxEntries
  });
  const registry = new BackendRegistry({
    claude: 100,
    gemini: 90,
    lmstudio: 50,
    ollama: 40
  });
  const configSnapshot = new ConfigSnapshotStore({ initial: config, path: cfgPath });
  return {
    dir,
    cfgPath,
    deps: {
      config,
      registry,
      archive,
      fileStore,
      responseCache,
      configSnapshot
    }
  };
}

function teardown(s: Setup): void {
  s.deps.archive.close();
  s.deps.fileStore.stop?.();
  rmSync(s.dir, { recursive: true, force: true });
}

function appWith(deps: ServerDeps, trustProxy = false): Express {
  const app = buildApp(deps);
  if (trustProxy) app.set("trust proxy", true);
  return app;
}

describe("admin endpoints — bindLocalhost enforcement", () => {
  let s: Setup;

  beforeEach(() => {
    s = setup();
  });

  afterEach(() => {
    teardown(s);
  });

  it("rejects a forwarded-from-127.0.0.2 request when bindLocalhost is true", async () => {
    const app = appWith(s.deps, true);
    const res = await request(app)
      .get("/admin/config")
      .set("x-api-key", "sk-integration")
      .set("X-Forwarded-For", "127.0.0.2");
    expect(res.status).toBe(403);
  });

  it("passes through after PATCHing bindLocalhost: false", async () => {
    const app = appWith(s.deps, true);
    const patched = await request(app)
      .patch("/admin/config")
      .set("x-api-key", "sk-integration")
      .send({ adminUi: { bindLocalhost: false } });
    expect(patched.status).toBe(200);
    expect(s.deps.configSnapshot.current().adminUi.bindLocalhost).toBe(false);
    const followup = await request(app)
      .get("/admin/config")
      .set("x-api-key", "sk-integration")
      .set("X-Forwarded-For", "127.0.0.2");
    expect(followup.status).toBe(200);
  });
});

describe("admin endpoints — round-trip every route", () => {
  let s: Setup;

  beforeEach(() => {
    s = setup({ adminUi: { enabled: true, bindLocalhost: false, sessionTtlMs: 3600000 } });
  });

  afterEach(() => {
    teardown(s);
  });

  it("GET /admin/backends returns an empty data array (no backends registered)", async () => {
    const app = appWith(s.deps);
    const res = await request(app)
      .get("/admin/backends")
      .set("x-api-key", "sk-integration");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("POST /admin/backends/reprobe returns _meta.reprobeScope: all", async () => {
    const app = appWith(s.deps);
    const res = await request(app)
      .post("/admin/backends/reprobe")
      .set("x-api-key", "sk-integration")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body._meta.reprobeScope).toBe("all");
  });

  it("POST /admin/backends/test returns ok:false against an unreachable URL", async () => {
    const app = appWith(s.deps);
    const res = await request(app)
      .post("/admin/backends/test")
      .set("x-api-key", "sk-integration")
      .send({ baseUrl: "http://127.0.0.1:1" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.latencyMs).toBe("number");
  });

  it("GET /admin/config returns redacted apiKey", async () => {
    const app = appWith(s.deps);
    const res = await request(app)
      .get("/admin/config")
      .set("x-api-key", "sk-integration");
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toBe("***");
  });

  it("PUT /admin/config replaces snapshot", async () => {
    const app = appWith(s.deps);
    const res = await request(app)
      .put("/admin/config")
      .set("x-api-key", "sk-integration")
      .send({ ...BASE_CONFIG, apiKey: "sk-rotated" });
    expect(res.status).toBe(200);
    expect(s.deps.configSnapshot.current().apiKey).toBe("sk-rotated");
  });

  it("PATCH /admin/config merges a sub-tree", async () => {
    const app = appWith(s.deps);
    const res = await request(app)
      .patch("/admin/config")
      .set("x-api-key", "sk-integration")
      .send({ claude: { timeoutMs: 750000 } });
    expect(res.status).toBe(200);
    expect(s.deps.configSnapshot.current().claude.timeoutMs).toBe(750000);
  });

  it("GET /admin/archive (Plan 05 mounted via Plan 11's router) still works", async () => {
    const app = appWith(s.deps);
    const res = await request(app)
      .get("/admin/archive")
      .set("x-api-key", "sk-integration");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe("admin endpoints — config PUT changes next request behavior", () => {
  let s: Setup;

  beforeEach(() => {
    s = setup({ adminUi: { enabled: true, bindLocalhost: false, sessionTtlMs: 3600000 } });
  });

  afterEach(() => {
    teardown(s);
  });

  it("after PUT with new apiKey, the new key authenticates and old does not (for /admin/config)", async () => {
    const app = appWith(s.deps);
    const put = await request(app)
      .put("/admin/config")
      .set("x-api-key", "sk-integration")
      .send({ ...BASE_CONFIG, apiKey: "sk-newer" });
    expect(put.status).toBe(200);

    // The /admin/config GET re-reads the snapshot, so the new key wins.
    const newKeyGet = await request(app)
      .get("/admin/config")
      .set("x-api-key", "sk-newer");
    expect(newKeyGet.status).toBe(200);

    const oldKeyGet = await request(app)
      .get("/admin/config")
      .set("x-api-key", "sk-integration");
    expect(oldKeyGet.status).toBe(401);
  });

  it("after PUT, pre-existing handlers (e.g., /admin/archive) STILL accept the old key — documented scope boundary", async () => {
    const app = appWith(s.deps);
    await request(app)
      .put("/admin/config")
      .set("x-api-key", "sk-integration")
      .send({ ...BASE_CONFIG, apiKey: "sk-newer" });
    // /admin/archive was constructed with the original apiKey captured at
    // boot, so the old key still works there until server restart.
    const oldKeyArchive = await request(app)
      .get("/admin/archive")
      .set("x-api-key", "sk-integration");
    expect(oldKeyArchive.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/integration/adminEndpoints.test.ts`
Expected: PASS — all 11 tests green.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/adminEndpoints.test.ts
git commit -m "test(integration): admin endpoints HTTP round-trip with bindLocalhost + PUT/PATCH semantics"
```

---

## Task 8: Full suite green + typecheck

Before the close-out document, confirm Plan 11 doesn't leave any regressions.

- [ ] **Step 1: Run the full suite**

Run: `npx vitest run`
Expected: All tests green. Plan-01..10 counts unchanged; Plan-11 adds:
- `tests/unit/admin/configSnapshot.test.ts` — 6 tests
- `tests/unit/admin/bindLocalhost.test.ts` — 8 tests
- `tests/unit/admin/backends.test.ts` — 13 tests
- `tests/unit/admin/config.test.ts` — 13 tests
- `tests/integration/adminEndpoints.test.ts` — 11 tests

Approximate new total: **+51 tests**.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 3: No commit** — this is a verification step.

---

## Task 9: Plan-11 close-out documentation

**Files:**
- Create: `docs/plan-11-admin-endpoints-readme.md`

- [ ] **Step 1: Write the document**

````markdown
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
| `tests/unit/admin/backends.test.ts` | list, reprobe with valid + invalid `?instance`, test endpoint success + failure + native + auth-forwarding (13 tests) |
| `tests/unit/admin/config.test.ts` | GET redaction, PUT validation + persistence, PATCH merge + RFC-7396 null-deletion, in-flight snapshot semantics (13 tests) |
| `tests/integration/adminEndpoints.test.ts` | bindLocalhost reject + toggle, round-trip every endpoint, PUT changes next-request behavior (11 tests) |

Approximate new tests: **+51**. Run all: `npm test`.

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
- PATCH is RFC 7396: arrays are atomic replacements (no element-level merging); `null` deletes a key; objects merge recursively.

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
````

- [ ] **Step 2: Commit**

```bash
git add docs/plan-11-admin-endpoints-readme.md
git commit -m "docs: add Plan 11 close-out README for admin REST endpoints"
```

---

## Plan 11 — Self-review checklist

Before declaring Plan 11 done, run through this checklist:

- [ ] `npm test` — all tests green, no skips. Plan-01..10 counts unchanged; Plan-11 adds ~51 new tests.
- [ ] `npx tsc --noEmit` — no type errors.
- [ ] `git status` — clean tree, all changes committed (except pre-existing untracked files like `scripts/configure-agent-zero.sh`).
- [ ] `git log --oneline -12` — commits read sensibly: configSnapshot, bindLocalhost, backends handlers, config handlers, admin router, server wiring, integration tests, README.
- [ ] `src/admin/configSnapshot.ts` exists, atomic-writes to `configs/default.json` BEFORE swapping the in-memory cell, leaves snapshot unchanged on disk-write failure.
- [ ] `src/admin/bindLocalhost.ts` re-evaluates `getEnabled()` per request (PATCHing `adminUi.bindLocalhost: false` takes effect immediately).
- [ ] `src/admin/backends.ts` handlers reuse `checkAuth` + Anthropic error envelopes; no parallel auth implementation.
- [ ] `src/admin/config.ts` GET redacts BOTH the top-level apiKey AND every `lmstudio.instances[].apiKey` / `ollama.instances[].apiKey`.
- [ ] `src/admin/config.ts` PUT + PATCH reject `apiKey: "***"` with a clear error message.
- [ ] `src/admin/config.ts` PUT + PATCH leave the snapshot AND `configs/default.json` unchanged when validation fails.
- [ ] `src/admin/router.ts` mounts every admin route behind the bindLocalhost middleware; no admin route bypasses the fence.
- [ ] `src/admin/router.ts` ALSO mounts Plan 05's `/admin/archive*` routes (the inline mount in `server.ts` was removed in Task 6).
- [ ] `src/server.ts` constructs `ConfigSnapshotStore` once at startup and threads it through `ServerDeps`.
- [ ] `src/server.ts` no longer contains the inline `createAdminArchiveHandlers` call — it was moved into `mountAdminRoutes`.
- [ ] `src/config.ts` now `export`s `ConfigSchema` (the small edit Task 4 calls out).
- [ ] No source file under `src/admin/` exceeds 300 lines.
- [ ] `dist/` directory is untouched.
- [ ] No admin route (archive, backends, config) is reachable without authentication.
- [ ] The `POST /admin/backends/test` handler does not write to the registry, the config snapshot, or any on-disk file.
- [ ] `tests/integration/adminEndpoints.test.ts` exercises the `X-Forwarded-For: 127.0.0.2` rejection path with `app.set("trust proxy", true)`.
- [ ] `tests/integration/adminEndpoints.test.ts` verifies that PUT-with-new-apiKey changes the next `/admin/config` request's required key AND documents (via a passing test) that pre-existing handlers like `/admin/archive` still accept the old key.
- [ ] No new runtime dependencies were added to `package.json`.
- [ ] `data/` directory is unchanged (no new artifact files).

If all check, Plan 11 is shipped. Open a PR to main; Plan 12 follows.

---

## Open questions

These deserve attention from a human reviewer before or during Plan 11 execution, and may shift later plans:

1. **Snapshot-getter retrofit scope.** Plan 11's in-flight snapshot semantics work for the admin-config endpoints themselves (they re-read `snapshot.current()` per request) but NOT for the pre-existing `/admin/archive`, `/admin/backends`, `/v1/messages`, `/v1/files`, etc. handlers, which captured `config: Config` at construction. The spec's "new requests see new config" guarantee is therefore partial. Two options for Plan 12: (a) retrofit every handler to accept `currentConfig: () => Config` instead of `config: Config` — touches every Plan 02-10 handler factory; mechanical but broad. (b) Document the partial guarantee and rely on server restart for full config refresh; the UI's hot-reload story handles UI-visible fields (apiKey) via the admin-config endpoints already. Plan 11 ships (b) by omission; Plan 12 should decide.

2. **Per-instance reprobe.** `POST /admin/backends/reprobe?instance=lmstudio:work-server` accepts the param but probes everything because `BackendRegistry.probe()` is all-or-nothing. Either (a) extend the registry with a `probeOne(id)` method now in a small follow-on, or (b) wait for Plan 12 to surface the user demand. Plan 11 ships (b) with `_meta.reprobeScope: "all"` so the UI doesn't lie about what happened.

3. **Multi-instance disambiguation in `GET /admin/backends`.** The current registry surfaces backends by `BackendId` (one entry per `claude` / `gemini` / `lmstudio` / `ollama`), not per-instance. Multi-instance LM Studio / Ollama deployments will see one aggregated entry rather than one per `instances[]` entry. The UI's "list of configured instances" view will need a separate data source (e.g., reading from `/admin/config` and cross-referencing the registry's model list) until a future plan extends the registry to enumerate sub-instances.

4. **Atomic write tmp leftover cleanup.** A crash between tmp-write and rename leaves `configs/default.json.tmp` on disk. Plan 11 does not clean it up at next boot; the operator must remove it manually. Trivial to add a "startup sweep" — Plan 12 or a small follow-on.

5. **PATCH array semantics.** RFC 7396 treats arrays as atomic replacements — there's no way to PATCH a single instance in `lmstudio.instances[]` by name. The UI must send the full array on every instance edit. This is a known RFC 7396 limitation; if it bites in practice, JSON Patch (RFC 6902, with element-level ops) is the upgrade path.

6. **Connectivity test for backends besides LM Studio / Ollama.** `POST /admin/backends/test` currently knows about OpenAI-compat (`/v1/models`) and Ollama-native (`/api/tags`). Claude CLI + Gemini CLI backends have no analogous candidate-URL connectivity test (they're CLIs, not HTTP). The UI's "test connection" button for those backends should fall back to "try a `claude --version` invocation" — out of scope here; Plan 12 should decide the UX.

7. **API key forwarded as `Authorization: Bearer`.** The `test` endpoint sends the candidate apiKey as `Authorization: Bearer <key>`. LM Studio accepts any header; Ollama ignores auth. Some future HTTP backends may expect `x-api-key` instead. If a backend's auth header diverges, extend the test handler to honor a `headerName` field on the request body.

8. **Trust-proxy for production deployments.** Operators behind a reverse proxy need `app.set("trust proxy", true)` for bindLocalhost to work correctly against `X-Forwarded-For`. Plan 11 does not enable this by default — the spec's bindLocalhost is for direct-connection deployments. A `config.adminUi.trustProxy` flag is the natural follow-on if a deployment hits this.

## Deviations from this plan that landed during execution

(Filled in by the implementer / reviewer during the actual task cycles. Expected items typically include: any divergence in `BackendRegistry`'s `enabledBackends()` / `lastProbeStatus()` surface requiring Task 3 adaptation; any differences in the Zod `ConfigSchema` export shape if `src/config.ts` already exposed it; test-count reconciliation if a placeholder needed replacement; any need to update Plan 05's existing `tests/integration/archive.test.ts` if the route mount move broke an assertion on URL form.)
