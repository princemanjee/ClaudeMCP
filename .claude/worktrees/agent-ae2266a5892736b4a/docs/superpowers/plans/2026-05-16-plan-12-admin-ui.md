# Plan 12: Admin UI (Glassmorphism SPA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the single-page web admin that ClaudeMCP operators open at `http://127.0.0.1:8899/admin/ui`. After Plan 12, a browser pointed at that URL lands on a login page (apiKey prompt), exchanges the key for an HttpOnly session cookie, and then presents a five-panel app — Dashboard, Backends, Router, General, Archive viewer — rendered as frosted-glass cards floating over a vibrant gradient background, with a sun/moon pill in the top-right that flips between light and dark themes. The UI consumes the Plan 11 admin REST endpoints (`/admin/backends*`, `/admin/config*`) plus the Plan 05 `/admin/archive*` endpoints. No build step exists: vanilla HTML + Alpine.js (loaded via a pinned jsDelivr URL with SRI hash) + hand-rolled CSS keyed off CSS custom properties, all served as static assets from `src/admin-ui/` by a thin Express handler.

**Architecture:** Two new server-side modules under `src/admin/` (`session.ts`, `ui.ts`) and a static-asset directory `src/admin-ui/` shipped with the source. `session.ts` holds an in-memory map of session-token → `{ createdAt }`, evicts on TTL, and exposes a small middleware that reads the `claudemcp_session` cookie and tags the request as authenticated when the token is live. `ui.ts` mounts: (a) the static SPA assets under `/admin/ui` and `/admin/ui/*` (no auth gate — the HTML/CSS/JS are inert without an apiKey), and (b) the login handler at `POST /admin/ui/session` that validates the posted apiKey via the existing `auth.ts` constant-time comparator and sets the `claudemcp_session` cookie. `src/server.ts` is extended to wire the session middleware ahead of every `/admin/*` admin route so cookie-bearing requests and `x-api-key`-bearing requests both authenticate equivalently. The localhost-bind enforcement is a 4-line precondition in `ui.ts`: when `config.adminUi.bindLocalhost` is true, requests whose `req.ip` is not `127.0.0.1` / `::1` / `::ffff:127.0.0.1` return 403 before any handler runs.

The frontend is a single `index.html` body root that Alpine.js hydrates. `app.js` defines one Alpine component per panel plus a top-level `app()` component that owns the auth state, the active panel, the theme attribute, and the 5-second `/admin/backends` poller. `styles.css` ships the base reset, layout, surface treatments, and component styles — all keyed off CSS custom properties whose values are defined in `themes/light.css` and `themes/dark.css`, both loaded unconditionally so swapping themes is a single `<html data-theme="...">` attribute flip with zero flash-of-unstyled-content. SVG icons live as small string exports in `app.js` (importing `.svg` files would require ESM-import-of-non-JS support that vanilla browsers lack without a bundler).

**Tech Stack:** Server side: Node.js 22+, TypeScript 5 (NodeNext ESM, `noUncheckedIndexedAccess`), Express 4 (`express.static` for the asset directory, `cookie-parser` for the session cookie), Vitest + Supertest. **New runtime dep:** `cookie-parser` (`^1.4.6`) for parsing `Cookie` headers — chosen over hand-rolling because the existing Express stack already uses Express middleware idioms. Frontend: vanilla HTML, CSS, JavaScript. **No npm-side frontend toolchain** — no Vite, no Webpack, no TypeScript-for-frontend, no JSX, no Tailwind, no PostCSS. Alpine.js (`^3.14.1`) loads from a pinned jsDelivr URL with an SRI `integrity=` attribute computed at write time. The optional visual regression test under `tests/integration/adminUi.visual.test.ts` uses Playwright via the `@playwright/test` dev dep — gated behind an `npm run test:visual` script and skipped in CI by default.

**Spec:** `docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md` (Phase 12: Admin UI). The "Admin UI" and "Visual design — glassmorphism + light/dark themes" sections of the spec are the canonical source for what ships here.

**Builds on:**
- Plan 01 (`docs/superpowers/plans/2026-05-16-plan-01-foundation.md`) — `loadConfig`, `config.adminUi.{enabled, bindLocalhost, sessionTtlMs}`, `config.apiKey`, the shared `checkAuth` helper in `src/auth.ts`.
- Plan 05 (`docs/superpowers/plans/2026-05-16-plan-05-files-cache-archive.md`) — `/admin/archive`, `/admin/archive/{id}`, `/admin/archive/search` already exist and are the data source for the Archive viewer panel.
- Plan 11 (`docs/superpowers/plans/2026-05-16-plan-11-admin-endpoints.md`, assumed merged) — `/admin/backends`, `/admin/backends/reprobe`, `/admin/backends/test`, `/admin/config` (GET / PUT / PATCH). All five panels of the UI consume these endpoints; Plan 12 ships ZERO new admin JSON endpoints — only the static-asset routes plus the session login endpoint.

**Reference plans (read these before starting):**
- `docs/superpowers/plans/2026-05-16-plan-05-files-cache-archive.md` — the `/admin/archive*` handler factory pattern; Plan 12's `ui.ts` mirrors its factory shape (`createAdminUiHandler(deps)`).
- `docs/superpowers/plans/2026-05-16-plan-11-admin-endpoints.md` — the endpoint contract Plan 12 consumes. Particularly: the JSON envelope returned by `/admin/backends` (per-instance reachability + model list) and the merge-patch semantics of `PATCH /admin/config`.

---

## Scope boundary for Plan 12

What ships here:

| Feature | Plan 12 disposition |
|---|---|
| `GET /admin/ui` serves the SPA entry HTML regardless of auth | Shipped via `src/admin/ui.ts` |
| `GET /admin/ui/*` serves the SPA static assets (CSS, JS, SVG, theme files) | Shipped via `express.static(src/admin-ui)` |
| `POST /admin/ui/session` validates posted apiKey, issues HttpOnly session cookie | Shipped — `src/admin/session.ts` issues + tracks the token |
| `DELETE /admin/ui/session` logs out (clears cookie + evicts token) | Shipped |
| Session cookie auth on `/admin/*` (cookie OR `x-api-key` header — either succeeds) | Shipped — middleware in `src/server.ts` |
| Localhost-bind enforcement (`config.adminUi.bindLocalhost: true` returns 403 for non-loopback) | Shipped — middleware precondition on the `/admin/ui*` routes |
| Five panels: Dashboard, Backends, Router, General, Archive viewer | Shipped via `src/admin-ui/app.js` + components |
| Light + dark themes via `<html data-theme="...">` attribute selectors | Shipped via `themes/light.css` + `themes/dark.css` |
| Theme toggle pill (sun/moon icons) in the top-right of the top bar | Shipped — persists to `localStorage` under `claudemcp-theme`, first-visit honors `prefers-color-scheme` |
| Glassmorphism surface treatments per the spec (cards, buttons, inputs, modals, status pills) | Shipped — keyed off CSS custom properties |
| 5-second poll of `/admin/backends` for reachability + loaded model list | Shipped — `setInterval` driven by Alpine component lifecycle |
| Backend-instance add/remove + Test Connection button + Save/Discard | Shipped — UI surfaces the existing Plan 11 endpoints |
| Router panel: `defaultBackend` dropdown, threshold fields, per-backend `reasoningEffortMap` editor with dropdowns populated from discovered models | Shipped |
| General panel: apiKey (write-only/masked), archive/cache/files paths + limits, `adminUi.bindLocalhost` toggle (with confirmation modal) | Shipped |
| Archive viewer: paginated table, filters (backend / session / model / since / until / status), substring search, click-row modal with decompressed bodies | Shipped |
| `prefers-reduced-motion` disables gradient drift + hover-lift animation | Shipped via media query in `styles.css` |
| `prefers-color-scheme` first-visit default | Shipped |
| Inline SVG icons (no icon font, no image requests beyond the pinned Alpine.js CDN) | Shipped via string exports in `app.js` |
| WCAG AA contrast verification on both themes | Shipped — documented per-theme color choices + manual audit task |
| Glass blur fallback for browsers without `backdrop-filter` support | Shipped — higher-opacity solid fallback per theme |
| Optional Playwright visual regression test, skipped in CI by default | Shipped — gated behind `npm run test:visual` |

What this plan does NOT ship — explicit non-goals reaffirmed from the spec and the "Scope boundary" in the user prompt:

| Feature | Plan 12 disposition | Lands in |
|---|---|---|
| Log streaming over WebSocket | Out of scope; spec open question | Future plan |
| In-UI request replay | Out of scope | Future plan |
| In-UI prompt playground | Out of scope | Future plan |
| Multi-user audit log | Out of scope | Future plan |
| Theme customization beyond light/dark | Out of scope | Future plan |
| Additional accent palettes | Out of scope | Future plan |
| New admin JSON endpoints (anything under `/admin/*` returning data) | Plan 11 owns these; Plan 12 only adds the SPA + session login | n/a |
| Server-side rendering / hydration / framework migration (React, Svelte, etc.) | Explicitly rejected — vanilla HTML + Alpine.js, no build step | n/a |
| Mobile-app or PWA shell | Out of scope; the UI is responsive but ships no manifest or service worker | Future plan |
| Headless-browser CI gate | The Playwright visual test is opt-in via `npm run test:visual`, not added to the default `npm test` matrix | Future plan |

Server-internal deferrals:
- No new JSON admin endpoints — every data fetch routes through Plan 11's surface or Plan 05's `/admin/archive*`.
- No server-Sent-Events stream for live updates — the UI polls; SSE/WS deferred.
- No persistent server-side session store across process restarts — the in-memory map is intentional. On server restart, all existing sessions invalidate and users re-log-in. Documented in the close-out README.

---

## File map

| File | Change | Lines (approx.) |
|---|---|---|
| `package.json` | EXTEND — add `cookie-parser` runtime dep + `@types/cookie-parser` dev dep. Add `@playwright/test` dev dep (for the optional `test:visual` script). Add `"test:visual": "playwright test tests/integration/adminUi.visual.test.ts"` script. | +5 |
| `src/admin/session.ts` | NEW — `SessionStore` class. `issue(): string` returns a fresh random hex token and records `{ createdAt }`. `validate(token): boolean` returns true if the token exists and `Date.now() - createdAt < ttlMs`. `revoke(token): void` deletes. `sweep(): void` evicts expired entries. Constructor takes `{ ttlMs }`. Internally a `Map<string, { createdAt: number }>`. Token format: 32-byte `crypto.randomBytes` rendered as 64-char lowercase hex. | ~120 |
| `src/admin/ui.ts` | NEW — `createAdminUiHandler({ sessionStore, config, checkApiKey })` returns an Express `Router`. Mounts: (a) `express.static(uiDir, {maxAge: 0, etag: true})` under `/`; (b) `GET /` serves `index.html` (covered by the static handler — explicit route is for the localhost-bind guard); (c) `POST /session` reads the JSON `{apiKey: string}` body, validates via the shared comparator, issues a session token, sets `Set-Cookie: claudemcp_session=<token>; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=<ttlMs/1000>`, responds `204`; (d) `DELETE /session` reads the cookie, revokes it, clears the cookie, responds `204`. The localhost-bind precondition runs first: if `config.adminUi.bindLocalhost === true` and `req.ip` is not `127.0.0.1` / `::1` / `::ffff:127.0.0.1`, respond `403 { error: "admin UI bound to localhost" }` and stop. | ~180 |
| `src/server.ts` | EXTEND — (1) call `app.use(cookieParser())` once near the top of the middleware stack; (2) construct `new SessionStore({ ttlMs: config.adminUi.sessionTtlMs })` and set a periodic `sweep()` interval (60s); (3) install a `sessionAuthMiddleware` ahead of every `/admin/*` route (not under `/admin/ui*`) that calls `next()` if the request already has a valid `x-api-key` header OR the `claudemcp_session` cookie maps to a live token; otherwise responds 401 with an Anthropic-shaped error (per spec); (4) mount `createAdminUiHandler({...})` at `/admin/ui`; (5) at shutdown, call `sessionStore.sweep()` once and clear the interval. | +60 |
| `src/admin-ui/index.html` | NEW — single-page entry. Loads `<link rel="stylesheet" href="./styles.css">`, `<link rel="stylesheet" href="./themes/light.css">`, `<link rel="stylesheet" href="./themes/dark.css">`, `<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js" integrity="sha384-<HASH>" crossorigin="anonymous"></script>`, `<script type="module" src="./app.js"></script>`. Body holds a single `<div id="app" x-data="app()">` shell hydrated by Alpine. The pinned Alpine version (`3.14.1`) and its SRI hash are filled in at write time by the implementer via the `openssl dgst -sha384 -binary | openssl base64 -A` recipe (see Task 5). | ~80 |
| `src/admin-ui/app.js` | NEW — Alpine.js root component `app()` plus per-panel components (`dashboardPanel()`, `backendsPanel()`, `routerPanel()`, `generalPanel()`, `archivePanel()`). Owns auth state (`isLoggedIn`, `apiKey`, `login()`, `logout()`), active panel (`activePanel`), theme (`theme`, `toggleTheme()`), and the 5-second `/admin/backends` poller. Exports inline SVG icon strings as `const ICONS = {...}` and `import`s them within components (well — vanilla browsers don't allow named imports between modules without `import` statements at the top; we use a single-file approach: all components plus `ICONS` live in `app.js`). Fetch helpers (`adminFetch(path, opts)`) automatically attach the `credentials: "include"` flag so the session cookie rides along; on 401 they bounce the user back to the login screen. | ~520 |
| `src/admin-ui/styles.css` | NEW — base reset, layout grid, top bar, sidebar, card surface treatments, buttons, inputs, modals, status pills, table, pagination, login panel. All keyed off CSS custom properties listed under "CSS architecture" below. Gradient-background `<body>::before` pseudo-element with subtle drift animation gated on `prefers-reduced-motion`. Glass blur fallback via `@supports not (backdrop-filter: blur(1px))`. | ~480 |
| `src/admin-ui/themes/light.css` | NEW — `[data-theme="light"]` selector wraps `:root`-style declarations of every CSS custom property: `--glass-bg`, `--glass-border`, `--glass-blur`, `--accent`, `--accent-secondary`, `--text-primary`, `--text-muted`, `--bg-gradient-start/mid/end`, plus secondary tokens (`--ring`, `--shadow-soft`, `--status-green/yellow/red`, `--input-bg`, `--modal-overlay`). Pastel lavender → soft pink → pale cyan gradient stops. White at 12-18% opacity for glass surfaces. | ~75 |
| `src/admin-ui/themes/dark.css` | NEW — `[data-theme="dark"]` selector wraps the same custom-property declarations with dark-theme values. Deep indigo → violet → near-black gradient. White at 6-10% opacity for glass over the dark base. | ~75 |
| `src/admin-ui/icons/README.md` | NEW — documents the inline-SVG approach and how to add a new icon. (Plan 12 does NOT ship `.svg` files in this directory — icons are string constants in `app.js`. The directory is a placeholder + documentation marker so future plans can adopt build-step-free SVG imports if desired.) | ~30 |
| `tests/unit/admin/session.test.ts` | NEW — `SessionStore`: `issue()` returns 64-char lowercase-hex strings; tokens are unique across 1000 issues; `validate()` returns true within TTL and false after; `revoke()` invalidates; `sweep()` evicts expired entries; ttl=0 means immediately-expired. | ~180 |
| `tests/unit/admin/ui.test.ts` | NEW — `createAdminUiHandler`: localhost-bind enforcement (127.0.0.1 / ::1 / ::ffff:127.0.0.1 all allowed; 8.8.8.8 rejected with 403; bindLocalhost=false disables the gate); GET `/admin/ui` serves `index.html` regardless of auth; POST `/admin/ui/session` rejects bad apiKey with 401; POST `/admin/ui/session` accepts good apiKey and returns `Set-Cookie` with HttpOnly + SameSite=Strict + Path=/admin + Max-Age computed from `config.adminUi.sessionTtlMs`; DELETE `/admin/ui/session` clears the cookie; expired session cookie on a subsequent `/admin/*` call returns 401. | ~320 |
| `tests/integration/adminUi.test.ts` | NEW — full HTTP stack via supertest: GET `/admin/ui` returns HTML containing the expected Alpine.js script tag with the pinned SRI hash; GET `/admin/ui/styles.css` returns CSS with `text/css` content-type; GET `/admin/ui/app.js` returns JavaScript with `application/javascript` content-type; GET `/admin/ui/themes/light.css` and `dark.css` both load; POST `/admin/ui/session` with the right apiKey returns 204 + Set-Cookie; subsequent GET `/admin/backends` with that cookie returns the backend list (Plan 11 endpoint) — proving cookie-equivalence with `x-api-key`; session expiration: stub `Date.now` past TTL, the cookie is rejected; localhost-bind: simulate non-loopback request → 403. | ~340 |
| `tests/integration/adminUi.visual.test.ts` | NEW (optional, skipped in CI). Playwright test that launches Chromium against the running server, logs in via the UI, toggles the theme, takes a screenshot per panel per theme (10 total), compares against committed baseline images under `tests/integration/adminUi.visual.baseline/`. Skipped via `describe.skip` in CI; opt-in via `npm run test:visual` which sets `RUN_VISUAL=1` and removes the skip. | ~220 |
| `docs/plan-12-admin-ui-readme.md` | NEW — close-out doc. | ~160 |

---

## Pre-flight check

Before starting Task 1, confirm the Plans 01-11 baseline is in place and verify the dependencies Plan 12 builds on:

- [ ] `git log --oneline -30` shows Plan 11's merge commit at or near the top (or whichever plan immediately precedes Plan 12 in your branch lineage).
- [ ] `npm test` shows the full prior-plans suite passing (no skips).
- [ ] `npx tsc --noEmit` clean.
- [ ] `src/auth.ts` exists with a `checkApiKey(presented: string, expected: string): boolean` constant-time comparator (Plan 01).
- [ ] `src/config.ts` Zod schema accepts `config.adminUi = { enabled: boolean, bindLocalhost: boolean, sessionTtlMs: number }` with defaults `{ enabled: true, bindLocalhost: true, sessionTtlMs: 3600000 }` (Plan 01).
- [ ] `src/server.ts` exports `buildApp(deps)` and `main(opts)` — Plan 12 extends it.
- [ ] `src/admin/archive.ts` exists from Plan 05 and handles `/admin/archive*` routes.
- [ ] `src/admin/backends.ts` exists from Plan 11 and handles `/admin/backends*` routes returning the documented per-instance JSON envelope (`{instances: [{name, baseUrl, enabled, lastProbeStatus, lastProbeAt, models: [...], capabilities: {...}}]}`).
- [ ] `src/admin/config.ts` exists from Plan 11 and handles GET / PUT / PATCH on `/admin/config` with redaction of `apiKey` to `***`.
- [ ] `tests/integration/` contains at least one supertest-driven test of the live Express app (e.g., `tests/integration/messages.test.ts`) — Plan 12 mirrors its pattern.
- [ ] Node version is 22+ (`node --version` reports `v22.x` or later); `crypto.randomBytes` is core so no extra dep is needed.

**Frontend dependency verification:**

- [ ] Decide on the pinned Alpine.js version. Plan 12 documents `3.14.1` as the example; the implementer may bump to whatever is the current stable at write time (`3.x`) and update the SRI hash in lockstep.
- [ ] Compute the SRI hash. From a development host with network access:
  ```bash
  curl -sL https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js \
    | openssl dgst -sha384 -binary \
    | openssl base64 -A
  ```
  Prepend `sha384-` to the result. Paste into `index.html`'s `integrity=` attribute. Recompute on any version bump.
- [ ] If `cookie-parser` is not already in `package.json`, prepare to add it in Task 1.

If any check fails, stop and resolve before proceeding.

---

## Plan length expectation

Largest plan in the project so far. Aim for **~18 tasks**, **~4,500 lines** of plan markdown. The frontend has many small pieces (5 panels × multiple subcomponents, 2 theme files, a CSS architecture with ~20 custom properties, ~20 SVG icons) that each warrant a dedicated step. The server side is small (3 source files, 2 unit tests, 1 integration test).

---

## CSS architecture overview

`styles.css` declares no color values directly. Every paintable property reads from a CSS custom property:

| Property | Purpose | Light example | Dark example |
|---|---|---|---|
| `--glass-bg` | Card / panel fill | `rgba(255,255,255,0.14)` | `rgba(255,255,255,0.06)` |
| `--glass-border` | 1px border on glass surfaces | `rgba(255,255,255,0.30)` | `rgba(255,255,255,0.15)` |
| `--glass-blur` | `backdrop-filter` blur radius | `20px` | `20px` |
| `--glass-saturate` | `backdrop-filter` saturate | `140%` | `140%` |
| `--accent` | Primary accent (magenta) | `#e91e63` | `#ec4899` |
| `--accent-secondary` | Secondary accent (cyan) | `#06b6d4` | `#22d3ee` |
| `--text-primary` | Body text | `#1a1a2e` | `#f5f5fa` |
| `--text-muted` | Secondary text | `#5b5b7a` | `#9c9cb8` |
| `--bg-gradient-start` | Top-left of viewport gradient | `#e0c3fc` (lavender) | `#1a1340` (deep indigo) |
| `--bg-gradient-mid` | Middle stop | `#ffc8dd` (soft pink) | `#3a1d6e` (violet) |
| `--bg-gradient-end` | Bottom-right | `#bde0fe` (pale cyan) | `#0a0a1a` (near-black) |
| `--ring` | 2px focus ring | `rgba(233,30,99,0.45)` | `rgba(236,72,153,0.55)` |
| `--shadow-soft` | Card drop shadow | `0 10px 30px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04)` | `0 10px 30px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.30)` |
| `--status-green` | Healthy indicator | `#10b981` | `#34d399` |
| `--status-yellow` | Degraded indicator | `#f59e0b` | `#fbbf24` |
| `--status-red` | Unreachable indicator | `#ef4444` | `#f87171` |
| `--input-bg` | Glass tint behind inputs | `rgba(255,255,255,0.22)` | `rgba(255,255,255,0.04)` |
| `--modal-overlay` | Backdrop dim color | `rgba(20,20,40,0.45)` | `rgba(0,0,0,0.55)` |
| `--card-radius` | Border radius for glass cards | `20px` | `20px` |
| `--button-radius` | Border radius for buttons | `12px` | `12px` |

`themes/light.css` opens with `[data-theme="light"] { ... }` and lists every property above. `themes/dark.css` does the same with dark values. Both are loaded unconditionally; only one matches at any time, so swapping `<html data-theme="light">` ⇄ `<html data-theme="dark">` retints the entire UI in one synchronous repaint.

`prefers-color-scheme` is consulted only on first visit (no `localStorage` entry) to choose the initial value of `data-theme`; subsequent visits read from `localStorage["claudemcp-theme"]`.

---

## Task 1: Add `cookie-parser` (and optional `@playwright/test`) dependencies

**Files:**
- Modify: `package.json`

The session middleware needs to parse the `Cookie` header. `cookie-parser` is the canonical Express-ecosystem choice and is pinned at `^1.4.6`. The optional Playwright dep enables `npm run test:visual` for manual visual regression — gated behind a script, not added to default `npm test`.

- [ ] **Step 1: Add runtime + dev deps**

Edit `package.json`. Under `dependencies`, insert (sorted alphabetically):

```json
"cookie-parser": "^1.4.6",
```

Under `devDependencies`, insert:

```json
"@playwright/test": "^1.48.0",
"@types/cookie-parser": "^1.4.7",
```

Under `scripts`, add the visual test runner:

```json
"test:visual": "RUN_VISUAL=1 playwright test tests/integration/adminUi.visual.test.ts"
```

(On Windows-PowerShell, the cross-platform `cross-env` package would normally set `RUN_VISUAL=1`; this plan deliberately uses an inline `RUN_VISUAL=1` prefix because the script is documented as a manual local-only command — operators on Windows can run `set RUN_VISUAL=1 && npx playwright test ...` directly. Document this in the close-out README.)

- [ ] **Step 2: Install**

```bash
npm install
```

Expect three new entries in `package-lock.json`. Confirm `node_modules/cookie-parser/index.js` exists.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add cookie-parser + @playwright/test for Plan 12 admin UI"
```

---

## Task 2: SessionStore (in-memory token map with TTL eviction)

**Files:**
- Create: `src/admin/session.ts`
- Create: `tests/unit/admin/session.test.ts`

A tiny class that holds `Map<token, { createdAt }>`, hands out fresh 32-byte hex tokens on `issue()`, validates a presented token against TTL on `validate()`, revokes individual tokens on `revoke()`, and bulk-evicts expired entries on `sweep()`. No persistence: the map lives in process memory and clears on restart. That is deliberate — the spec accepts session loss on restart as a non-issue for a localhost-only admin UI.

- [ ] **Step 1: Write the class**

Create `src/admin/session.ts`:

```ts
import { randomBytes } from "node:crypto";

export interface SessionStoreOptions {
  /** Time-to-live in milliseconds. Tokens older than this are invalid. */
  ttlMs: number;
}

interface SessionEntry {
  createdAt: number;
}

/**
 * In-memory map of session-token → creation timestamp. Used by the admin UI
 * login flow: POST /admin/ui/session issues a token, sets it as an HttpOnly
 * cookie, and subsequent /admin/* requests authenticate via `validate()`.
 *
 * No persistence — the map clears on process restart. Operators re-log-in.
 * The spec accepts this trade-off for a localhost-only admin tool.
 */
export class SessionStore {
  private readonly map = new Map<string, SessionEntry>();
  private readonly ttlMs: number;

  constructor(opts: SessionStoreOptions) {
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs < 0) {
      throw new Error(`SessionStore: ttlMs must be a non-negative finite number, got ${opts.ttlMs}`);
    }
    this.ttlMs = opts.ttlMs;
  }

  /** Issue a fresh token. 32 random bytes rendered as 64-char lowercase hex. */
  issue(): string {
    const token = randomBytes(32).toString("hex");
    this.map.set(token, { createdAt: Date.now() });
    return token;
  }

  /** True iff the token exists and `Date.now() - createdAt < ttlMs`. */
  validate(token: string | undefined | null): boolean {
    if (!token) return false;
    const entry = this.map.get(token);
    if (!entry) return false;
    if (Date.now() - entry.createdAt >= this.ttlMs) {
      // Lazy eviction on read.
      this.map.delete(token);
      return false;
    }
    return true;
  }

  /** Explicit logout: revoke a single token. No-op if absent. */
  revoke(token: string | undefined | null): void {
    if (!token) return;
    this.map.delete(token);
  }

  /** Periodic bulk eviction of expired entries. Call from a setInterval. */
  sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.map.entries()) {
      if (now - entry.createdAt >= this.ttlMs) {
        this.map.delete(token);
      }
    }
  }

  /** Test-only: current live entry count. Not for production use. */
  size(): number {
    return this.map.size;
  }
}
```

- [ ] **Step 2: Write the unit tests**

Create `tests/unit/admin/session.test.ts` with 12 cases covering: token format (64-char lowercase hex), uniqueness across 1000 issues, validate within TTL, validate after TTL, validate on unknown token, validate on null/undefined/empty, revoke invalidates, revoke is no-op for absent token, sweep evicts only expired, lazy eviction on validate, ttlMs=0 means immediately-expired, constructor rejects negative or non-finite ttlMs. Use `vi.useFakeTimers()` + `vi.advanceTimersByTime()` to control TTL boundaries deterministically.

The test skeleton follows the same import + `describe`/`it` shape as `tests/unit/admin/archive.test.ts` (Plan 05). Sample of the most important cases:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../../../src/admin/session.js";

describe("SessionStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("issues 64-char lowercase hex tokens", () => {
    const store = new SessionStore({ ttlMs: 1000 });
    expect(store.issue()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("issues unique tokens across 1000 calls", () => {
    const store = new SessionStore({ ttlMs: 1000 });
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(store.issue());
    expect(seen.size).toBe(1000);
  });

  it("validate() returns true within TTL, false after", () => {
    const store = new SessionStore({ ttlMs: 10_000 });
    const token = store.issue();
    vi.advanceTimersByTime(5_000);
    expect(store.validate(token)).toBe(true);
    vi.advanceTimersByTime(5_001);
    expect(store.validate(token)).toBe(false);
  });

  it("sweep() evicts only expired entries", () => {
    const store = new SessionStore({ ttlMs: 10_000 });
    const a = store.issue();
    vi.advanceTimersByTime(5_000);
    const b = store.issue();
    vi.advanceTimersByTime(6_000); // a 11s; b 6s
    store.sweep();
    expect(store.validate(a)).toBe(false);
    expect(store.validate(b)).toBe(true);
  });

  it("rejects negative or non-finite ttlMs at construction", () => {
    expect(() => new SessionStore({ ttlMs: -1 })).toThrow(/non-negative/);
    expect(() => new SessionStore({ ttlMs: Infinity })).toThrow(/finite/);
    expect(() => new SessionStore({ ttlMs: NaN })).toThrow(/finite/);
  });
});
```

(Implementer writes the remaining 7 cases following the same pattern.)

- [ ] **Step 3: Run tests and typecheck**

```bash
npx vitest run tests/unit/admin/session.test.ts
npx tsc --noEmit
```

Expect 12 green tests.

- [ ] **Step 4: Commit**

```bash
git add src/admin/session.ts tests/unit/admin/session.test.ts
git commit -m "feat(admin): SessionStore — in-memory token map with TTL eviction for admin UI login"
```

---

## Task 3: `createAdminUiHandler` — static asset router + session login endpoint + localhost-bind guard

**Files:**
- Create: `src/admin/ui.ts`
- (Tests in Task 4 — combined with a focused unit pass)

Build the Express Router that serves `src/admin-ui/*` as static assets, handles `POST /admin/ui/session` (login → set HttpOnly cookie) and `DELETE /admin/ui/session` (logout → clear cookie), and rejects non-loopback requests when `config.adminUi.bindLocalhost` is true.

- [ ] **Step 1: Write the handler factory**

Create `src/admin/ui.ts`:

```ts
import express, { type Router, type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "./session.js";

export interface AdminUiHandlerDeps {
  sessionStore: SessionStore;
  config: {
    apiKey: string;
    adminUi: {
      enabled: boolean;
      bindLocalhost: boolean;
      sessionTtlMs: number;
    };
  };
  /** Shared constant-time comparator from src/auth.ts. */
  checkApiKey: (presented: string, expected: string) => boolean;
  /** Override of the static-asset directory location (tests pass a fixture dir). */
  uiAssetDir?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Express Router mounted at `/admin/ui`. Routes:
 *   GET    /            → static index.html (no auth — page renders login form)
 *   GET    /*           → static assets (CSS, JS, theme files)
 *   POST   /session     → validate apiKey, issue session cookie
 *   DELETE /session     → revoke session, clear cookie
 *
 * Localhost-bind precondition runs first: when config.adminUi.bindLocalhost is
 * true, non-loopback requests get 403 before any handler runs.
 *
 * Auth note: static routes do NOT require auth. The HTML/CSS/JS are inert
 * without an apiKey. The login page IS the SPA. JSON /admin/* calls (handled
 * elsewhere) require auth via cookie OR x-api-key header.
 */
export function createAdminUiHandler(deps: AdminUiHandlerDeps): Router {
  const { sessionStore, config, checkApiKey } = deps;
  const uiAssetDir = deps.uiAssetDir ?? path.resolve(__dirname, "..", "admin-ui");
  const router = express.Router();

  // Localhost-bind precondition.
  router.use((req: Request, res: Response, next: NextFunction): void => {
    if (!config.adminUi.bindLocalhost) { next(); return; }
    if (isLoopback(req.ip ?? "")) { next(); return; }
    res.status(403).json({
      type: "error",
      error: {
        type: "permission_error",
        message: "admin UI bound to localhost; set config.adminUi.bindLocalhost=false to disable",
      },
    });
  });

  // POST /session — login.
  router.post("/session", express.json({ limit: "4kb" }), (req, res) => {
    const body = req.body as { apiKey?: unknown } | undefined;
    const apiKey = typeof body?.apiKey === "string" ? body.apiKey : "";
    if (!apiKey || !checkApiKey(apiKey, config.apiKey)) {
      res.status(401).json({
        type: "error",
        error: { type: "authentication_error", message: "invalid apiKey" },
      });
      return;
    }
    const token = sessionStore.issue();
    res.setHeader(
      "Set-Cookie",
      buildCookie("claudemcp_session", token, {
        httpOnly: true,
        sameSite: "Strict",
        path: "/admin",
        maxAgeSeconds: Math.floor(config.adminUi.sessionTtlMs / 1000),
      })
    );
    res.status(204).end();
  });

  // DELETE /session — logout.
  router.delete("/session", (req, res) => {
    const token = readSessionCookie(req);
    sessionStore.revoke(token);
    res.setHeader(
      "Set-Cookie",
      buildCookie("claudemcp_session", "", {
        httpOnly: true,
        sameSite: "Strict",
        path: "/admin",
        maxAgeSeconds: 0,
      })
    );
    res.status(204).end();
  });

  // Static assets last so explicit routes win on path collisions.
  router.use(
    express.static(uiAssetDir, {
      etag: true,
      lastModified: true,
      maxAge: 0,
      index: "index.html",
      setHeaders(res, filePath) {
        if (filePath.endsWith(".js")) res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        else if (filePath.endsWith(".css")) res.setHeader("Content-Type", "text/css; charset=utf-8");
        else if (filePath.endsWith(".svg")) res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
      },
    })
  );

  return router;
}

export function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function readSessionCookie(req: Request): string | undefined {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  if (cookies && typeof cookies["claudemcp_session"] === "string") {
    return cookies["claudemcp_session"];
  }
  const header = req.headers["cookie"];
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === "claudemcp_session") return v;
  }
  return undefined;
}

interface CookieOpts {
  httpOnly: boolean;
  sameSite: "Strict" | "Lax" | "None";
  path: string;
  maxAgeSeconds: number;
}

function buildCookie(name: string, value: string, opts: CookieOpts): string {
  const parts = [`${name}=${value}`];
  if (opts.httpOnly) parts.push("HttpOnly");
  parts.push(`SameSite=${opts.sameSite}`);
  parts.push(`Path=${opts.path}`);
  parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  return parts.join("; ");
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/admin/ui.ts
git commit -m "feat(admin): createAdminUiHandler — static SPA + session login/logout + localhost-bind guard"
```

---

## Task 4: Unit tests for `createAdminUiHandler`

**Files:**
- Create: `tests/unit/admin/ui.test.ts`

Exercise every branch of the handler in isolation: localhost-bind enforcement (allow 127.0.0.1 / ::1 / ::ffff:127.0.0.1; reject 8.8.8.8 with 403; bindLocalhost=false bypasses the gate), static asset serving with correct content types, POST /session login (good key 204 + Set-Cookie, bad key 401, missing key 401, non-string key 401, empty-string key 401), DELETE /session logout (revokes + clears cookie; no-op when no cookie). All cases use supertest against a freshly-built `express.Router` mounted at `/admin/ui`, with `req.ip` overridden via a tiny middleware so tests can simulate any remote address. Fixture asset directory is a temp dir with a stub `index.html`, `app.js`, `styles.css`, `themes/light.css`, `themes/dark.css`.

- [ ] **Step 1: Write the test skeleton + helpers**

Create `tests/unit/admin/ui.test.ts` with helper functions `buildApp(opts)` (builds an Express app + SessionStore for a single test) and `makeFakeAssetDir()` (mkdtemp + writes stubs). Then six `describe` blocks:

1. `describe("isLoopback()")` — 2 cases covering accept list and reject list.
2. `describe("createAdminUiHandler — localhost bind enforcement")` — 5 cases (127.0.0.1 ok, ::1 ok, 8.8.8.8 → 403, bindLocalhost=false bypass, non-loopback on POST /session also 403).
3. `describe("createAdminUiHandler — static asset serving")` — 5 cases (index.html, app.js + content type, styles.css + content type, themes/light.css, 404 for unknown).
4. `describe("createAdminUiHandler — POST /session login")` — 6 cases (missing apiKey 401, wrong apiKey 401, correct apiKey 204 + Set-Cookie with all attributes, issued cookie validates against store, empty-string apiKey 401, non-string apiKey 401).
5. `describe("createAdminUiHandler — DELETE /session logout")` — 2 cases (revokes + clears cookie; no-op without cookie).
6. `describe("createAdminUiHandler — expired session")` — 1 case (fake-timers past TTL → store.validate returns false; verifies the SessionStore-side contract that the handler relies on).

Total ~22 cases. Reference the Task 4 sample in this plan's working notes for the `buildApp` shape — it mounts `createAdminUiHandler` at `/admin/ui`, installs a tiny cookie reader (since cookie-parser is wired in `src/server.ts` not in the router itself), and lets each test override `req.ip` via `forceRemoteIp`.

The most load-bearing assertions:

```ts
// POST /session attribute audit:
const cookieStr = (res.headers["set-cookie"] as unknown as string[])[0];
expect(cookieStr).toMatch(/^claudemcp_session=[0-9a-f]{64}/);
expect(cookieStr).toMatch(/HttpOnly/);
expect(cookieStr).toMatch(/SameSite=Strict/);
expect(cookieStr).toMatch(/Path=\/admin/);
expect(cookieStr).toMatch(/Max-Age=\d+/);
```

```ts
// localhost bypass when bindLocalhost=false:
const { app } = buildApp({ forceRemoteIp: "8.8.8.8", bindLocalhost: false, uiAssetDir });
const res = await request(app).get("/admin/ui/");
expect(res.status).toBe(200);
```

- [ ] **Step 2: Run tests + typecheck**

```bash
npx vitest run tests/unit/admin/ui.test.ts
npx tsc --noEmit
```

Expect ~22 green tests.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/admin/ui.test.ts
git commit -m "test(admin): unit tests for createAdminUiHandler — bind enforcement, login, logout, asset serving"
```

---

## Task 5: Wire SessionStore + cookie-parser + sessionAuthMiddleware into `src/server.ts`

**Files:**
- Modify: `src/server.ts`

The session middleware needs to live ahead of every `/admin/*` route handler (Plan 05's `/admin/archive*`, Plan 11's `/admin/backends*`, `/admin/config`) so a request with a valid session cookie authenticates equivalently to one bearing `x-api-key`. The `/admin/ui` routes (Plan 12's static assets + login endpoint) must NOT pass through this middleware — they predate auth (login itself happens there).

- [ ] **Step 1: Add the cookie-parser middleware**

In `src/server.ts`, near the top of the middleware stack (after JSON parsing but before any auth-bearing routes), add:

```ts
import cookieParser from "cookie-parser";
// ...
app.use(cookieParser());
```

- [ ] **Step 2: Construct the SessionStore at startup**

After `loadConfig` returns:

```ts
import { SessionStore } from "./admin/session.js";

const sessionStore = new SessionStore({ ttlMs: config.adminUi.sessionTtlMs });
const sessionSweepInterval = setInterval(() => sessionStore.sweep(), 60_000);
sessionSweepInterval.unref(); // don't keep the process alive
```

Add `clearInterval(sessionSweepInterval)` to the shutdown path alongside the registry stop.

- [ ] **Step 3: Define the sessionAuthMiddleware**

```ts
import { checkApiKey } from "./auth.js";
import { readSessionCookie } from "./admin/ui.js";

function sessionAuthMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  // x-api-key wins if present (matches the existing /admin/* gate).
  const headerKey = typeof req.headers["x-api-key"] === "string"
    ? (req.headers["x-api-key"] as string)
    : undefined;
  if (headerKey && checkApiKey(headerKey, config.apiKey)) {
    next();
    return;
  }
  // Cookie fallback.
  const token = readSessionCookie(req);
  if (token && sessionStore.validate(token)) {
    next();
    return;
  }
  res.status(401).json({
    type: "error",
    error: { type: "authentication_error", message: "missing or invalid credentials" },
  });
}
```

- [ ] **Step 4: Mount the middleware ahead of admin routes**

The mount order matters. Mount `/admin/ui` FIRST (it has its own bind guard but no session middleware), then `sessionAuthMiddleware`, then every other `/admin/*` handler:

```ts
import { createAdminUiHandler } from "./admin/ui.js";

if (config.adminUi.enabled) {
  app.use(
    "/admin/ui",
    createAdminUiHandler({ sessionStore, config, checkApiKey })
  );
}

app.use("/admin", sessionAuthMiddleware);
app.use("/admin/archive", createArchiveAdminHandler({ archive }));      // from Plan 05
app.use("/admin/backends", createBackendsAdminHandler({ registry }));   // from Plan 11
app.use("/admin/config", createConfigAdminHandler({ config, configPath })); // from Plan 11
```

Note: `app.use("/admin", sessionAuthMiddleware)` triggers for every path under `/admin/*` INCLUDING `/admin/ui/*`. To avoid that, either:
- Mount `/admin/ui` BEFORE the catch-all `/admin` middleware (Express matches routers in declaration order — Plan 12 uses this approach), OR
- Add a path-prefix check inside the middleware: `if (req.path.startsWith("/ui")) { next(); return; }`.

This plan uses **declaration order** (mount `/admin/ui` first, then the `/admin` middleware). Document this load-bearing ordering in the close-out README.

- [ ] **Step 5: Add startup warning if bindLocalhost is false**

Per the spec:

```ts
if (config.adminUi.enabled && !config.adminUi.bindLocalhost) {
  console.warn(
    "[startup] WARNING: config.adminUi.bindLocalhost=false; the admin UI accepts " +
    "requests from any IP. This is a security concession — confirm intentional."
  );
}
```

- [ ] **Step 6: Typecheck + smoke**

```bash
npx tsc --noEmit
npm test  # ensure existing tests still pass
```

- [ ] **Step 7: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): wire SessionStore + cookie-parser + sessionAuthMiddleware + admin UI mount"
```

---

## Task 6: SPA shell `src/admin-ui/index.html` (with pinned Alpine.js CDN + SRI)

**Files:**
- Create: `src/admin-ui/index.html`

The single-page app entry. Loads both theme stylesheets unconditionally, loads Alpine.js from jsDelivr with a pinned version and SRI hash, and hands off to `app.js` (a separate file loaded as a classic script so Alpine's `x-data` attributes can reference `app()` from window scope).

- [ ] **Step 1: Compute the Alpine.js SRI hash**

```bash
curl -sL https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js \
  | openssl dgst -sha384 -binary \
  | openssl base64 -A
```

Prepend `sha384-`. The resulting string goes into the `integrity=` attribute below. On any future version bump, recompute and update.

- [ ] **Step 2: Write the HTML**

Create `src/admin-ui/index.html`:

```html
<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ClaudeMCP Admin</title>
  <meta name="color-scheme" content="light dark" />
  <link rel="icon" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PGNpcmNsZSBjeD0iOCIgY3k9IjgiIHI9IjciIGZpbGw9IiNlOTFlNjMiLz48L3N2Zz4=" />
  <!-- Bootstrap theme attribute before paint to prevent FOUC. -->
  <script>
    (function () {
      var t = localStorage.getItem("claudemcp-theme");
      if (!t) {
        t = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      }
      document.documentElement.setAttribute("data-theme", t);
    })();
  </script>
  <link rel="stylesheet" href="./styles.css" />
  <link rel="stylesheet" href="./themes/light.css" />
  <link rel="stylesheet" href="./themes/dark.css" />
  <!--
    Alpine.js pinned at 3.14.1 from jsDelivr with SRI hash.
    To bump: change the version in the URL AND recompute the integrity hash via
      curl -sL <URL> | openssl dgst -sha384 -binary | openssl base64 -A
    and prepend "sha384-".
  -->
  <script
    defer
    src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js"
    integrity="sha384-REPLACE_WITH_ACTUAL_HASH_AT_IMPLEMENTATION_TIME"
    crossorigin="anonymous"
  ></script>
  <script src="./app.js"></script>
</head>
<body>
  <div id="app" x-data="app()" x-cloak>

    <!-- Login screen (shown until x-show="!isLoggedIn"). -->
    <template x-if="!isLoggedIn">
      <main class="login-shell">
        <div class="glass-card login-card">
          <h1>ClaudeMCP</h1>
          <p class="muted">Sign in with your admin API key.</p>
          <form @submit.prevent="login()">
            <label for="apikey">API Key</label>
            <input id="apikey" type="password" x-model="apiKeyInput" autocomplete="current-password" autofocus />
            <button type="submit" class="primary" :disabled="loggingIn" x-text="loggingIn ? 'Signing in…' : 'Sign in'"></button>
            <p class="error" x-show="loginError" x-text="loginError"></p>
          </form>
          <button type="button" class="ghost theme-toggle" @click="toggleTheme()" :title="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'">
            <span x-html="theme === 'dark' ? ICONS.sun : ICONS.moon"></span>
          </button>
        </div>
      </main>
    </template>

    <!-- Authenticated shell. -->
    <template x-if="isLoggedIn">
      <div class="app-shell">

        <!-- Top bar (sticky). -->
        <header class="top-bar glass-card">
          <div class="brand">
            <span class="brand-mark" x-html="ICONS.logo"></span>
            <span class="brand-text">ClaudeMCP</span>
          </div>
          <h1 class="page-title" x-text="panelTitle()"></h1>
          <nav class="backend-health">
            <template x-for="b in backendHealthPills" :key="b.name">
              <span class="status-pill" :class="'status-' + b.color">
                <span class="dot"></span>
                <span x-text="b.name"></span>
              </span>
            </template>
          </nav>
          <div class="top-bar-actions">
            <button type="button" class="ghost theme-toggle" @click="toggleTheme()" :title="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'">
              <span x-html="theme === 'dark' ? ICONS.sun : ICONS.moon"></span>
            </button>
            <button type="button" class="ghost" @click="logout()" title="Sign out">
              <span x-html="ICONS.logout"></span>
            </button>
          </div>
        </header>

        <!-- Sidebar. -->
        <aside class="sidebar glass-card">
          <template x-for="p in panels" :key="p.id">
            <button
              class="nav-item"
              :class="{ active: activePanel === p.id }"
              @click="setPanel(p.id)"
            >
              <span class="nav-icon" x-html="ICONS[p.icon]"></span>
              <span class="nav-label" x-text="p.label"></span>
            </button>
          </template>
        </aside>

        <!-- Main content. One panel visible at a time. -->
        <main class="content">
          <section x-show="activePanel === 'dashboard'" x-data="dashboardPanel()"   x-init="init()"></section>
          <section x-show="activePanel === 'backends'"  x-data="backendsPanel()"    x-init="init()"></section>
          <section x-show="activePanel === 'router'"    x-data="routerPanel()"      x-init="init()"></section>
          <section x-show="activePanel === 'general'"   x-data="generalPanel()"     x-init="init()"></section>
          <section x-show="activePanel === 'archive'"   x-data="archivePanel()"     x-init="init()"></section>
        </main>

      </div>
    </template>
  </div>
</body>
</html>
```

(Plan 12 deliberately leaves the panel `<section>` contents empty here — they are filled in by Tasks 10-14, each panel one task. The Alpine `x-data` reference targets the component functions defined in `app.js`, which Task 9 introduces.)

- [ ] **Step 3: Commit**

```bash
git add src/admin-ui/index.html
git commit -m "feat(admin-ui): SPA shell index.html with pinned Alpine.js CDN + SRI"
```

---

## Task 7: Base `src/admin-ui/styles.css` (reset, layout, glass surfaces, components)

**Files:**
- Create: `src/admin-ui/styles.css`

Hand-rolled CSS keyed off the custom properties listed in the "CSS architecture overview" table at the top of this plan. Sections (in file order): (1) reset + base, (2) viewport gradient + decorative shapes, (3) layout grid, (4) top bar + sidebar, (5) glass card surface, (6) buttons, (7) inputs + selects, (8) status pills, (9) tables, (10) modals, (11) login shell, (12) `prefers-reduced-motion` overrides, (13) `@supports not (backdrop-filter)` fallback.

- [ ] **Step 1: Write `styles.css`**

Create `src/admin-ui/styles.css`. Structure (sample showing the load-bearing parts; implementer fills in the remaining ~400 lines following the same patterns):

```css
/* ============================================================
   1. RESET + BASE
   ============================================================ */
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; min-height: 100vh; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
  color: var(--text-primary);
  background: transparent;
  overflow-x: hidden;
}
[x-cloak] { display: none !important; }

/* ============================================================
   2. VIEWPORT GRADIENT + DECORATIVE BLOBS
   ============================================================ */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -2;
  background: linear-gradient(
    135deg,
    var(--bg-gradient-start) 0%,
    var(--bg-gradient-mid) 50%,
    var(--bg-gradient-end) 100%
  );
  background-size: 200% 200%;
  animation: gradient-drift 60s ease-in-out infinite;
}
body::after {
  content: "";
  position: fixed;
  top: -10%;
  right: -10%;
  width: 40vmax;
  height: 40vmax;
  border-radius: 50%;
  background: radial-gradient(circle, var(--accent-secondary) 0%, transparent 60%);
  opacity: 0.18;
  z-index: -1;
  filter: blur(40px);
  pointer-events: none;
}
@keyframes gradient-drift {
  0%, 100% { background-position: 0% 0%; }
  50% { background-position: 100% 100%; }
}

/* ============================================================
   3. LAYOUT GRID
   ============================================================ */
.app-shell {
  display: grid;
  grid-template-columns: 240px 1fr;
  grid-template-rows: auto 1fr;
  grid-template-areas:
    "top top"
    "side main";
  gap: 16px;
  padding: 16px;
  min-height: 100vh;
}
.top-bar { grid-area: top; }
.sidebar { grid-area: side; align-self: start; position: sticky; top: 16px; }
.content { grid-area: main; }

@media (max-width: 1024px) {
  .app-shell { grid-template-columns: 64px 1fr; }
  .sidebar .nav-label { display: none; }
}
@media (max-width: 768px) {
  .app-shell {
    grid-template-columns: 1fr;
    grid-template-areas: "top" "main";
  }
  .sidebar { display: none; } /* hamburger drawer is a future enhancement */
}

/* ============================================================
   4. TOP BAR + SIDEBAR
   ============================================================ */
.top-bar {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 12px 20px;
}
.brand { display: flex; align-items: center; gap: 10px; font-weight: 600; }
.brand-mark { width: 24px; height: 24px; color: var(--accent); }
.page-title { font-size: 16px; font-weight: 500; margin: 0 auto 0 0; color: var(--text-muted); }
.backend-health { display: flex; gap: 8px; flex-wrap: wrap; }
.top-bar-actions { display: flex; gap: 8px; }

.sidebar {
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  border-radius: var(--button-radius);
  cursor: pointer;
  font-size: 14px;
  text-align: left;
  transition: background-color 0.15s ease;
}
.nav-item:hover { background: var(--glass-bg); }
.nav-item.active {
  background: linear-gradient(135deg, var(--accent), var(--accent-secondary));
  color: white;
}
.nav-icon { width: 18px; height: 18px; display: inline-flex; }

/* ============================================================
   5. GLASS CARD
   ============================================================ */
.glass-card {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  border: 1px solid var(--glass-border);
  border-radius: var(--card-radius);
  box-shadow: var(--shadow-soft);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.glass-card:hover { transform: translateY(-2px); }

/* ============================================================
   6. BUTTONS
   ============================================================ */
button {
  font: inherit;
  cursor: pointer;
}
button.primary {
  padding: 10px 18px;
  border: 0;
  border-radius: var(--button-radius);
  background: linear-gradient(135deg, var(--accent), var(--accent-secondary));
  color: white;
  font-weight: 500;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
button.primary:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.2); }
button.primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

button.ghost {
  padding: 8px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--button-radius);
  background: var(--glass-bg);
  color: var(--text-primary);
  backdrop-filter: blur(10px);
}
button.ghost:hover { background: var(--glass-border); }

button.danger {
  padding: 8px 14px;
  border: 0;
  border-radius: var(--button-radius);
  background: var(--status-red);
  color: white;
}

/* ============================================================
   7. INPUTS + SELECTS
   ============================================================ */
input[type="text"], input[type="password"], input[type="number"], input[type="search"], select, textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--button-radius);
  background: var(--input-bg);
  color: var(--text-primary);
  font: inherit;
  transition: box-shadow 0.15s ease, border-color 0.15s ease;
}
input:focus, select:focus, textarea:focus {
  outline: 0;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--ring);
}
label { display: block; font-size: 13px; color: var(--text-muted); margin-bottom: 6px; }

/* ============================================================
   8. STATUS PILLS
   ============================================================ */
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  font-size: 12px;
  color: var(--text-primary);
}
.status-pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--status-green); }
.status-pill.status-green  .dot { background: var(--status-green); }
.status-pill.status-yellow .dot { background: var(--status-yellow); }
.status-pill.status-red    .dot { background: var(--status-red); }

/* ============================================================
   9. TABLES (archive viewer)
   ============================================================ */
.archive-table { width: 100%; border-collapse: collapse; }
.archive-table th, .archive-table td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--glass-border);
  font-size: 13px;
}
.archive-table th { color: var(--text-muted); font-weight: 500; }
.archive-table tr { cursor: pointer; transition: background-color 0.1s ease; }
.archive-table tr:hover { background: var(--glass-bg); }

/* ============================================================
   10. MODALS
   ============================================================ */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--modal-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  backdrop-filter: blur(8px);
}
.modal {
  max-width: min(900px, 90vw);
  max-height: 85vh;
  overflow: auto;
  padding: 24px;
  /* extends .glass-card via class composition in the markup */
}

/* ============================================================
   11. LOGIN SHELL
   ============================================================ */
.login-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 16px;
}
.login-card { max-width: 400px; width: 100%; padding: 32px; position: relative; }
.login-card h1 { margin: 0 0 8px; font-size: 28px; }
.login-card .muted { color: var(--text-muted); margin: 0 0 24px; }
.login-card form { display: grid; gap: 16px; }
.login-card .theme-toggle {
  position: absolute; top: 16px; right: 16px; padding: 6px;
}
.error { color: var(--status-red); font-size: 13px; margin: 0; }

/* ============================================================
   12. PREFERS-REDUCED-MOTION
   ============================================================ */
@media (prefers-reduced-motion: reduce) {
  body::before { animation: none; }
  .glass-card { transition: none; }
  .glass-card:hover { transform: none; }
  button.primary { transition: none; }
  button.primary:hover { transform: none; }
}

/* ============================================================
   13. BACKDROP-FILTER FALLBACK
   ============================================================ */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .glass-card { background: var(--glass-bg-fallback, rgba(255, 255, 255, 0.85)); }
  [data-theme="dark"] .glass-card { background: var(--glass-bg-fallback, rgba(20, 20, 40, 0.85)); }
}
```

The implementer extends this with:
- Form-row layouts for the Backends and Router panels (`.form-row`, `.form-grid`).
- Tile grid for the Dashboard (`.tile-grid` with `repeat(auto-fit, minmax(280px, 1fr))`).
- Per-backend block styling for the Backends panel.
- Pagination controls for the Archive viewer.

- [ ] **Step 2: Commit**

```bash
git add src/admin-ui/styles.css
git commit -m "feat(admin-ui): base styles.css — reset, layout, glass surfaces, components, a11y media queries"
```

---

## Task 8: Theme files `src/admin-ui/themes/{light,dark}.css`

**Files:**
- Create: `src/admin-ui/themes/light.css`
- Create: `src/admin-ui/themes/dark.css`

Each theme file declares the same set of CSS custom properties under a `[data-theme="..."]` attribute selector on `<html>`. Both files load unconditionally; only one selector matches at any moment, so swapping themes is a single `data-theme` attribute write with zero flash-of-unstyled-content.

- [ ] **Step 1: Write `themes/light.css`**

Create `src/admin-ui/themes/light.css`:

```css
[data-theme="light"] {
  /* Glass surfaces */
  --glass-bg: rgba(255, 255, 255, 0.14);
  --glass-bg-fallback: rgba(255, 255, 255, 0.85);
  --glass-border: rgba(255, 255, 255, 0.30);
  --glass-blur: 20px;
  --glass-saturate: 140%;

  /* Accent colors */
  --accent: #e91e63;
  --accent-secondary: #06b6d4;

  /* Text */
  --text-primary: #1a1a2e;
  --text-muted: #5b5b7a;

  /* Viewport gradient — pastel lavender → soft pink → pale cyan */
  --bg-gradient-start: #e0c3fc;
  --bg-gradient-mid: #ffc8dd;
  --bg-gradient-end: #bde0fe;

  /* Focus + shadow */
  --ring: rgba(233, 30, 99, 0.45);
  --shadow-soft:
    0 10px 30px rgba(0, 0, 0, 0.08),
    0 2px 6px rgba(0, 0, 0, 0.04);

  /* Status colors */
  --status-green: #10b981;
  --status-yellow: #f59e0b;
  --status-red: #ef4444;

  /* Form surfaces */
  --input-bg: rgba(255, 255, 255, 0.22);

  /* Modal */
  --modal-overlay: rgba(20, 20, 40, 0.45);

  /* Radii */
  --card-radius: 20px;
  --button-radius: 12px;
}
```

- [ ] **Step 2: Write `themes/dark.css`**

Create `src/admin-ui/themes/dark.css`:

```css
[data-theme="dark"] {
  /* Glass surfaces — lower opacity over a dark base reads as smoky translucent */
  --glass-bg: rgba(255, 255, 255, 0.06);
  --glass-bg-fallback: rgba(20, 20, 40, 0.85);
  --glass-border: rgba(255, 255, 255, 0.15);
  --glass-blur: 20px;
  --glass-saturate: 140%;

  /* Accent — slightly desaturated to reduce eye strain on dark */
  --accent: #ec4899;
  --accent-secondary: #22d3ee;

  /* Text */
  --text-primary: #f5f5fa;
  --text-muted: #9c9cb8;

  /* Viewport gradient — deep indigo → violet → near-black */
  --bg-gradient-start: #1a1340;
  --bg-gradient-mid: #3a1d6e;
  --bg-gradient-end: #0a0a1a;

  /* Focus + shadow */
  --ring: rgba(236, 72, 153, 0.55);
  --shadow-soft:
    0 10px 30px rgba(0, 0, 0, 0.45),
    0 2px 6px rgba(0, 0, 0, 0.30);

  /* Status colors — slightly lighter to maintain contrast on dark */
  --status-green: #34d399;
  --status-yellow: #fbbf24;
  --status-red: #f87171;

  /* Form surfaces */
  --input-bg: rgba(255, 255, 255, 0.04);

  /* Modal */
  --modal-overlay: rgba(0, 0, 0, 0.55);

  /* Radii */
  --card-radius: 20px;
  --button-radius: 12px;
}
```

- [ ] **Step 3: Manual WCAG AA contrast audit**

Open `index.html` in a browser (after Task 9 has shipped enough JS for the login to render — defer if blocked). For each theme:
- Body text (`--text-primary`) on the gradient region with the LOWEST contrast (typically the lightest gradient stop in light mode, the violet mid-stop in dark mode) — must be ≥ 4.5:1 against the visible background through any glass card.
- Muted text (`--text-muted`) on the same — must be ≥ 3:1 (large-text threshold; muted text is used for secondary labels and timestamps).
- Status pill text — must be ≥ 4.5:1 against the pill's glass background.

If any pair fails, increase the glass-card opacity by 4-6 percentage points until it passes. Document the final opacities in the close-out README.

- [ ] **Step 4: Commit**

```bash
git add src/admin-ui/themes/light.css src/admin-ui/themes/dark.css
git commit -m "feat(admin-ui): light + dark theme custom-property files"
```

---

## Task 9: `app.js` — root `app()` component, ICONS, fetch helpers, auth + theme + polling

**Files:**
- Create: `src/admin-ui/app.js`

The frontend root. Defines the `app()` Alpine component plus shared utilities used by every panel. Components for individual panels are stubs here — Tasks 10-14 fill each one in. Loaded as a classic script (not `type="module"`) so `app()` is globally available to Alpine's `x-data="app()"`.

- [ ] **Step 1: Write the root + shared utilities**

Create `src/admin-ui/app.js`:

```js
// ClaudeMCP Admin UI — vanilla JS + Alpine.js, no build step.
//
// Top-level layout:
//   - ICONS: inline SVG strings (extend as new icons are needed).
//   - PANELS: static metadata table for the sidebar nav.
//   - adminFetch(): wrapper around fetch() that includes the session cookie
//     and bounces back to the login screen on 401.
//   - debounce(): tiny utility used by the archive search panel.
//   - app(): root Alpine component — owns auth state, theme, active panel,
//     and the 5-second /admin/backends poller (shared across all panels via
//     window.__claudemcpBackendsState so each panel can subscribe).
//   - dashboardPanel/backendsPanel/routerPanel/generalPanel/archivePanel():
//     per-panel components. Skeletons here; fleshed out in Tasks 10-14.

// ============================================================
// ICONS — inline SVG strings, replace fill="currentColor" picks up CSS color
// ============================================================
const ICONS = {
  logo:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>`,
  dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>`,
  backends:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="6" rx="2"/><rect x="2" y="15" width="20" height="6" rx="2"/><circle cx="6" cy="6" r="1"/><circle cx="6" cy="18" r="1"/></svg>`,
  router:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M9 12h6M9 12L17 8M9 12L17 16"/></svg>`,
  general:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  archive:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="4" rx="1"/><path d="M5 7v14h14V7M10 12h4"/></svg>`,
  sun:       `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`,
  moon:      `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  logout:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>`,
  refresh:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
  trash:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/></svg>`,
  plus:      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>`,
  check:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`,
  close:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>`,
  search:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>`,
};

const PANELS = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "backends",  label: "Backends",  icon: "backends"  },
  { id: "router",    label: "Router",    icon: "router"    },
  { id: "general",   label: "General",   icon: "general"   },
  { id: "archive",   label: "Archive",   icon: "archive"   },
];

// ============================================================
// ADMIN FETCH WRAPPER
// ============================================================
async function adminFetch(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    credentials: "include",
    headers: {
      "Accept": "application/json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    // Cookie expired or invalid — bounce to login by clearing the shared state.
    window.dispatchEvent(new CustomEvent("claudemcp:logout"));
    throw new Error("session-expired");
  }
  return res;
}

function debounce(fn, delayMs) {
  let h = null;
  return (...args) => {
    if (h !== null) clearTimeout(h);
    h = setTimeout(() => { h = null; fn(...args); }, delayMs);
  };
}

// ============================================================
// SHARED BACKENDS-POLL STATE (single poller for the whole app)
// ============================================================
const backendsState = {
  data: null,            // { instances: [...] } from /admin/backends
  lastFetchedAt: null,
  error: null,
};
const backendsListeners = new Set();
function subscribeBackends(listener) {
  backendsListeners.add(listener);
  if (backendsState.data) listener(backendsState);
  return () => backendsListeners.delete(listener);
}
async function refreshBackends() {
  try {
    const res = await adminFetch("/admin/backends");
    if (!res.ok) throw new Error(`/admin/backends ${res.status}`);
    backendsState.data = await res.json();
    backendsState.lastFetchedAt = Date.now();
    backendsState.error = null;
  } catch (e) {
    backendsState.error = e instanceof Error ? e.message : String(e);
  }
  for (const l of backendsListeners) l(backendsState);
}
let backendsPollHandle = null;
function startBackendsPolling() {
  if (backendsPollHandle !== null) return;
  refreshBackends();
  backendsPollHandle = setInterval(refreshBackends, 5000);
}
function stopBackendsPolling() {
  if (backendsPollHandle !== null) {
    clearInterval(backendsPollHandle);
    backendsPollHandle = null;
  }
}

// ============================================================
// ROOT APP COMPONENT
// ============================================================
function app() {
  return {
    // Auth
    isLoggedIn: false,
    apiKeyInput: "",
    loggingIn: false,
    loginError: "",

    // Theme
    theme: document.documentElement.getAttribute("data-theme") || "dark",

    // Navigation
    panels: PANELS,
    activePanel: "dashboard",

    // Top-bar health
    backendHealthPills: [],

    // Make ICONS accessible from templates.
    ICONS,

    async init() {
      // Probe an /admin endpoint to see if we already have a valid session cookie.
      try {
        const res = await fetch("/admin/backends", { credentials: "include" });
        if (res.ok) {
          this.isLoggedIn = true;
          startBackendsPolling();
          this.subscribeHealth();
        }
      } catch { /* offline — show login */ }

      // Listen for cookie-expiry bounces from any panel's adminFetch.
      window.addEventListener("claudemcp:logout", () => {
        this.isLoggedIn = false;
        stopBackendsPolling();
      });
    },

    async login() {
      this.loggingIn = true;
      this.loginError = "";
      try {
        const res = await fetch("/admin/ui/session", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: this.apiKeyInput }),
        });
        if (res.status === 204) {
          this.apiKeyInput = "";
          this.isLoggedIn = true;
          startBackendsPolling();
          this.subscribeHealth();
        } else if (res.status === 401) {
          this.loginError = "Invalid API key.";
        } else {
          this.loginError = `Login failed: HTTP ${res.status}`;
        }
      } catch (e) {
        this.loginError = `Login failed: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        this.loggingIn = false;
      }
    },

    async logout() {
      try { await fetch("/admin/ui/session", { method: "DELETE", credentials: "include" }); }
      catch { /* best effort */ }
      this.isLoggedIn = false;
      stopBackendsPolling();
    },

    toggleTheme() {
      this.theme = this.theme === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", this.theme);
      try { localStorage.setItem("claudemcp-theme", this.theme); } catch { /* private mode */ }
    },

    setPanel(id) {
      this.activePanel = id;
    },

    panelTitle() {
      const p = this.panels.find(x => x.id === this.activePanel);
      return p ? p.label : "";
    },

    subscribeHealth() {
      subscribeBackends(state => {
        if (!state.data || !state.data.instances) {
          this.backendHealthPills = [];
          return;
        }
        // Group by backend id, color = worst per-instance status.
        const byBackend = new Map();
        for (const inst of state.data.instances) {
          const bid = inst.backendId || inst.backend || "?";
          const cur = byBackend.get(bid) || { name: bid, color: "green" };
          const c = colorForProbeStatus(inst.lastProbeStatus);
          if (rank(c) > rank(cur.color)) cur.color = c;
          byBackend.set(bid, cur);
        }
        this.backendHealthPills = Array.from(byBackend.values());
      });
    },
  };
}

function colorForProbeStatus(status) {
  if (status === "ok") return "green";
  if (status === "stale" || status === "probing") return "yellow";
  return "red";
}
function rank(color) { return color === "red" ? 2 : color === "yellow" ? 1 : 0; }

// ============================================================
// PANEL COMPONENT SKELETONS — Tasks 10-14 fill these in.
// ============================================================
function dashboardPanel() { return { init() { /* see Task 10 */ } }; }
function backendsPanel()  { return { init() { /* see Task 11 */ } }; }
function routerPanel()    { return { init() { /* see Task 12 */ } }; }
function generalPanel()   { return { init() { /* see Task 13 */ } }; }
function archivePanel()   { return { init() { /* see Task 14 */ } }; }

// Expose globally so Alpine's x-data attributes can resolve them without imports.
window.app = app;
window.dashboardPanel = dashboardPanel;
window.backendsPanel  = backendsPanel;
window.routerPanel    = routerPanel;
window.generalPanel   = generalPanel;
window.archivePanel   = archivePanel;
window.ICONS = ICONS;
```

- [ ] **Step 2: Commit**

```bash
git add src/admin-ui/app.js
git commit -m "feat(admin-ui): app.js root — ICONS, fetch helpers, auth + theme + backends polling"
```

---

## Task 10: Dashboard panel

**Files:**
- Modify: `src/admin-ui/app.js` (replace the `dashboardPanel()` stub).
- Modify: `src/admin-ui/index.html` (fill in the `<section x-show="activePanel === 'dashboard'">` block).

The Dashboard shows backend health pills (sticky top bar already covers this — Dashboard reproduces it as the main content too for the at-a-glance view) plus a tile per backend instance:
- Status dot (green/yellow/red)
- Loaded model count
- Requests-in-last-hour (queries `/admin/archive?since=<now-3600000>&limit=1&offset=0` — uses the response's `totalCount` envelope from Plan 05)
- Last probe time

Tiles auto-update via the shared `subscribeBackends()` channel + a periodic 30s refresh of the request-count query.

- [ ] **Step 1: Flesh out `dashboardPanel()` in `app.js`**

Replace the stub:

```js
function dashboardPanel() {
  return {
    instances: [],
    requestCounts: {}, // map instanceKey -> count in last hour
    countsLoadedAt: null,
    unsubscribe: null,
    countInterval: null,

    init() {
      this.unsubscribe = subscribeBackends(state => {
        this.instances = (state.data && state.data.instances) || [];
        this.refreshCounts(); // also runs on each backends-poll tick (5s) — debounced internally
      });
      // Also refresh counts every 30s independently in case backends don't change.
      this.countInterval = setInterval(() => this.refreshCounts(true), 30_000);
    },

    destroy() {
      if (this.unsubscribe) this.unsubscribe();
      if (this.countInterval) clearInterval(this.countInterval);
    },

    refreshCountsRaw: async function () {
      const since = Date.now() - 60 * 60 * 1000;
      const out = {};
      for (const inst of this.instances) {
        const key = `${inst.backendId || inst.backend}/${inst.name}`;
        try {
          const res = await adminFetch(`/admin/archive?backend=${encodeURIComponent(inst.backendId || inst.backend)}&instance=${encodeURIComponent(inst.name)}&since=${since}&limit=1`);
          if (res.ok) {
            const body = await res.json();
            out[key] = body.totalCount ?? body.total ?? (body.entries ? body.entries.length : 0);
          }
        } catch { /* keep previous value */ }
      }
      this.requestCounts = out;
      this.countsLoadedAt = Date.now();
    },

    refreshCounts(force) {
      // Throttle: do at most one refresh every 25 seconds unless forced.
      if (!force && this.countsLoadedAt && Date.now() - this.countsLoadedAt < 25_000) return;
      this.refreshCountsRaw();
    },

    statusColor(inst) { return colorForProbeStatus(inst.lastProbeStatus); },

    keyFor(inst) { return `${inst.backendId || inst.backend}/${inst.name}`; },

    formatTime(ts) {
      if (!ts) return "—";
      const d = new Date(ts);
      return d.toLocaleString();
    },
  };
}
window.dashboardPanel = dashboardPanel;
```

- [ ] **Step 2: Fill in the Dashboard `<section>` in `index.html`**

```html
<section x-show="activePanel === 'dashboard'" x-data="dashboardPanel()" x-init="init()" x-destroy="destroy()">
  <div class="tile-grid">
    <template x-for="inst in instances" :key="keyFor(inst)">
      <article class="glass-card tile">
        <header class="tile-header">
          <span class="status-pill" :class="'status-' + statusColor(inst)">
            <span class="dot"></span>
            <span x-text="(inst.backendId || inst.backend) + ' / ' + inst.name"></span>
          </span>
        </header>
        <dl class="tile-stats">
          <dt>Loaded models</dt><dd x-text="(inst.models && inst.models.length) || 0"></dd>
          <dt>Requests (last hour)</dt><dd x-text="requestCounts[keyFor(inst)] ?? '—'"></dd>
          <dt>Last probe</dt><dd x-text="formatTime(inst.lastProbeAt)"></dd>
        </dl>
      </article>
    </template>
  </div>
</section>
```

Add to `styles.css`:

```css
.tile-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
.tile { padding: 20px; }
.tile-header { margin-bottom: 16px; }
.tile-stats { display: grid; grid-template-columns: 1fr auto; gap: 8px 16px; margin: 0; font-size: 13px; }
.tile-stats dt { color: var(--text-muted); }
.tile-stats dd { margin: 0; font-weight: 500; text-align: right; }
```

- [ ] **Step 3: Commit**

```bash
git add src/admin-ui/app.js src/admin-ui/index.html src/admin-ui/styles.css
git commit -m "feat(admin-ui): Dashboard panel — per-instance tiles with status, model count, last-hour requests"
```

---

## Task 11: Backends panel

**Files:**
- Modify: `src/admin-ui/app.js` (flesh out `backendsPanel()`).
- Modify: `src/admin-ui/index.html` (fill in the Backends `<section>`).

Per-backend block (Claude, Gemini, LM Studio, Ollama). For multi-instance HTTP backends (LM Studio, Ollama): instance list with add/remove buttons. Each instance shows enabled toggle, baseUrl/command, apiKey (masked input with show/hide), priority, timeoutMs, useNativeApi (Ollama only). "Test connection" calls `POST /admin/backends/test`. Live-discovered model list per instance with refresh → `POST /admin/backends/reprobe?instance=...`. Save/Discard buttons → `PATCH /admin/config` with only the changed subtree.

- [ ] **Step 1: Flesh out `backendsPanel()`**

```js
function backendsPanel() {
  return {
    loading: true,
    error: null,
    config: null,          // current server config (apiKey redacted)
    draft: null,           // editable copy
    backendsLive: null,    // /admin/backends snapshot
    unsubscribe: null,
    testing: {},           // map instanceKey -> {status:'ok'|'fail'|'pending', message}
    showApiKey: {},        // map instanceKey -> bool

    async init() {
      await this.reload();
      this.unsubscribe = subscribeBackends(state => { this.backendsLive = state.data; });
    },
    destroy() { if (this.unsubscribe) this.unsubscribe(); },

    async reload() {
      this.loading = true;
      this.error = null;
      try {
        const res = await adminFetch("/admin/config");
        if (!res.ok) throw new Error(`/admin/config ${res.status}`);
        this.config = await res.json();
        this.draft = JSON.parse(JSON.stringify(this.config));
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      } finally {
        this.loading = false;
      }
    },

    addInstance(backendId) {
      const block = this.draft[backendId];
      if (!Array.isArray(block.instances)) block.instances = [];
      const used = new Set(block.instances.map(x => x.name));
      let i = 1;
      while (used.has(`instance-${i}`)) i++;
      block.instances.push({
        name: `instance-${i}`,
        baseUrl: backendId === "lmstudio" ? "http://localhost:1234" : "http://localhost:11434",
        apiKey: "",
        priority: 100,
        timeoutMs: 60000,
        ...(backendId === "ollama" ? { useNativeApi: null } : {}),
      });
    },

    removeInstance(backendId, idx) {
      this.draft[backendId].instances.splice(idx, 1);
    },

    async testConnection(backendId, instance) {
      const key = `${backendId}/${instance.name}`;
      this.testing[key] = { status: "pending", message: "Testing…" };
      try {
        const res = await adminFetch("/admin/backends/test", {
          method: "POST",
          body: JSON.stringify({ backendId, instance }),
        });
        const body = await res.json();
        if (res.ok && body.ok) {
          this.testing[key] = { status: "ok", message: `OK — found ${body.modelCount || 0} models` };
        } else {
          this.testing[key] = { status: "fail", message: body.error || `HTTP ${res.status}` };
        }
      } catch (e) {
        this.testing[key] = { status: "fail", message: e instanceof Error ? e.message : String(e) };
      }
    },

    async reprobeInstance(backendId, instance) {
      try {
        await adminFetch(`/admin/backends/reprobe?instance=${encodeURIComponent(backendId + ":" + instance.name)}`, { method: "POST" });
        await refreshBackends();
      } catch { /* shown via shared error state */ }
    },

    async save() {
      try {
        const patch = computeConfigPatch(this.config, this.draft);
        const res = await adminFetch("/admin/config", { method: "PATCH", body: JSON.stringify(patch) });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          this.error = body.error?.message || `Save failed: HTTP ${res.status}`;
          return;
        }
        await this.reload();
        // Force immediate reprobe of any newly-added instances so model lists populate.
        for (const bid of ["lmstudio", "ollama"]) {
          for (const inst of this.draft[bid]?.instances || []) {
            this.reprobeInstance(bid, inst);
          }
        }
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      }
    },

    discard() {
      this.draft = JSON.parse(JSON.stringify(this.config));
    },

    modelsForInstance(backendId, instanceName) {
      if (!this.backendsLive || !this.backendsLive.instances) return [];
      const inst = this.backendsLive.instances.find(
        x => (x.backendId || x.backend) === backendId && x.name === instanceName
      );
      return inst ? (inst.models || []) : [];
    },

    isDirty() {
      return JSON.stringify(this.config) !== JSON.stringify(this.draft);
    },
  };
}
window.backendsPanel = backendsPanel;

// Compute a deep JSON-merge-patch from base→target. Used for PATCH /admin/config.
function computeConfigPatch(base, target) {
  if (typeof base !== "object" || base === null || Array.isArray(base) ||
      typeof target !== "object" || target === null || Array.isArray(target)) {
    return target;
  }
  const out = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
  for (const k of keys) {
    if (!(k in target)) { out[k] = null; continue; }
    if (!(k in base))   { out[k] = target[k]; continue; }
    if (typeof target[k] === "object" && target[k] !== null && !Array.isArray(target[k]) &&
        typeof base[k]   === "object" && base[k]   !== null && !Array.isArray(base[k])) {
      const sub = computeConfigPatch(base[k], target[k]);
      if (sub && Object.keys(sub).length > 0) out[k] = sub;
    } else if (JSON.stringify(base[k]) !== JSON.stringify(target[k])) {
      out[k] = target[k];
    }
  }
  return out;
}
```

- [ ] **Step 2: Fill in the Backends `<section>` in `index.html`**

```html
<section x-show="activePanel === 'backends'" x-data="backendsPanel()" x-init="init()" x-destroy="destroy()">
  <template x-if="loading"><p class="muted">Loading config…</p></template>
  <template x-if="error"><p class="error" x-text="error"></p></template>

  <template x-if="!loading && draft">
    <div class="backends-grid">

      <!-- Single-instance CLI backends -->
      <template x-for="bid in ['claude', 'gemini']" :key="bid">
        <article class="glass-card backend-block">
          <header class="backend-header">
            <h2 x-text="bid"></h2>
            <label class="toggle"><input type="checkbox" x-model="draft[bid].enabled"> enabled</label>
          </header>
          <div class="form-grid">
            <label>Command<input type="text" x-model="draft[bid].command"></label>
            <label>Priority<input type="number" x-model.number="draft[bid].priority"></label>
            <label>Timeout (ms)<input type="number" x-model.number="draft[bid].timeoutMs"></label>
          </div>
        </article>
      </template>

      <!-- Multi-instance HTTP backends -->
      <template x-for="bid in ['lmstudio', 'ollama']" :key="bid">
        <article class="glass-card backend-block">
          <header class="backend-header">
            <h2 x-text="bid"></h2>
            <label class="toggle"><input type="checkbox" x-model="draft[bid].enabled"> enabled</label>
            <template x-if="bid === 'ollama'">
              <label class="toggle">
                <input type="checkbox" x-model="draft[bid].useNativeApi"> useNativeApi (backend default)
              </label>
            </template>
            <button type="button" class="ghost" @click="addInstance(bid)">
              <span x-html="ICONS.plus"></span> Add instance
            </button>
          </header>

          <template x-for="(inst, idx) in draft[bid].instances" :key="inst.name + idx">
            <div class="instance-card glass-card">
              <div class="form-grid">
                <label>Name<input type="text" x-model="inst.name"></label>
                <label>Base URL<input type="text" x-model="inst.baseUrl"></label>
                <label>
                  API Key
                  <div class="input-with-toggle">
                    <input :type="showApiKey[bid+'/'+inst.name] ? 'text' : 'password'" x-model="inst.apiKey">
                    <button type="button" class="ghost" @click="showApiKey[bid+'/'+inst.name] = !showApiKey[bid+'/'+inst.name]" x-text="showApiKey[bid+'/'+inst.name] ? 'Hide' : 'Show'"></button>
                  </div>
                </label>
                <label>Priority<input type="number" x-model.number="inst.priority"></label>
                <label>Timeout (ms)<input type="number" x-model.number="inst.timeoutMs"></label>
                <template x-if="bid === 'ollama'">
                  <label>useNativeApi
                    <select x-model="inst.useNativeApi">
                      <option :value="null">inherit</option>
                      <option :value="true">true</option>
                      <option :value="false">false</option>
                    </select>
                  </label>
                </template>
              </div>

              <div class="instance-actions">
                <button type="button" class="ghost" @click="testConnection(bid, inst)">Test connection</button>
                <span class="test-result" :class="testing[bid+'/'+inst.name]?.status" x-text="testing[bid+'/'+inst.name]?.message || ''"></span>
                <button type="button" class="ghost" @click="reprobeInstance(bid, inst)">
                  <span x-html="ICONS.refresh"></span> Refresh models
                </button>
                <button type="button" class="danger" @click="removeInstance(bid, idx)">
                  <span x-html="ICONS.trash"></span> Remove
                </button>
              </div>

              <details>
                <summary>Discovered models (<span x-text="modelsForInstance(bid, inst.name).length"></span>)</summary>
                <ul class="model-list">
                  <template x-for="m in modelsForInstance(bid, inst.name)" :key="m.id || m.name">
                    <li x-text="m.id || m.name"></li>
                  </template>
                </ul>
              </details>
            </div>
          </template>
        </article>
      </template>

      <footer class="save-bar glass-card" x-show="isDirty()">
        <button type="button" class="ghost" @click="discard()">Discard</button>
        <button type="button" class="primary" @click="save()">Save changes</button>
      </footer>
    </div>
  </template>
</section>
```

Add the per-panel styles to `styles.css`:

```css
.backends-grid { display: grid; gap: 16px; }
.backend-block { padding: 20px; }
.backend-header { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.backend-header h2 { text-transform: capitalize; margin: 0; flex: 0 0 auto; }
.toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px 16px; }
.instance-card { padding: 16px; margin: 12px 0; }
.instance-actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.input-with-toggle { display: flex; gap: 8px; }
.input-with-toggle input { flex: 1; }
.model-list { list-style: none; padding: 0 0 0 12px; margin: 8px 0 0; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; }
.test-result.ok   { color: var(--status-green); font-size: 12px; }
.test-result.fail { color: var(--status-red);   font-size: 12px; }
.test-result.pending { color: var(--text-muted); font-size: 12px; }
.save-bar { position: sticky; bottom: 16px; padding: 12px 16px; display: flex; justify-content: flex-end; gap: 12px; z-index: 10; }
```

- [ ] **Step 3: Commit**

```bash
git add src/admin-ui/app.js src/admin-ui/index.html src/admin-ui/styles.css
git commit -m "feat(admin-ui): Backends panel — per-backend instance editor with test/refresh/save"
```

---

## Task 12: Router panel

**Files:**
- Modify: `src/admin-ui/app.js` (flesh out `routerPanel()`).
- Modify: `src/admin-ui/index.html` (fill in the Router `<section>`).

`defaultBackend` dropdown populated only from currently-enabled backends whose probe succeeded. Threshold fields: `opusPromptTokens`, `opusToolCount`, `sonnetPromptTokens`. Per-backend `reasoningEffortMap`: pick a model from a dropdown populated by the live model list, then pick an effort level (`minimal`/`low`/`medium`/`high`). Save/Discard mirror the Backends panel.

- [ ] **Step 1: Flesh out `routerPanel()`**

```js
function routerPanel() {
  return {
    loading: true,
    error: null,
    config: null,
    draft: null,
    backendsLive: null,
    unsubscribe: null,

    async init() {
      const res = await adminFetch("/admin/config");
      this.config = await res.json();
      this.draft = JSON.parse(JSON.stringify(this.config));
      this.loading = false;
      this.unsubscribe = subscribeBackends(s => { this.backendsLive = s.data; });
    },
    destroy() { if (this.unsubscribe) this.unsubscribe(); },

    selectableBackends() {
      if (!this.backendsLive || !this.backendsLive.instances) return [];
      const ok = new Set();
      for (const inst of this.backendsLive.instances) {
        if (inst.lastProbeStatus === "ok") ok.add(inst.backendId || inst.backend);
      }
      return Array.from(ok);
    },

    modelsForBackend(backendId) {
      if (!this.backendsLive || !this.backendsLive.instances) return [];
      const out = new Set();
      for (const inst of this.backendsLive.instances) {
        if ((inst.backendId || inst.backend) === backendId && Array.isArray(inst.models)) {
          for (const m of inst.models) out.add(m.id || m.name);
        }
      }
      return Array.from(out).sort();
    },

    addEffortMapping(backendId) {
      if (!this.draft.modelRouter) this.draft.modelRouter = {};
      if (!this.draft.modelRouter.reasoningEffortMap) this.draft.modelRouter.reasoningEffortMap = {};
      if (!this.draft.modelRouter.reasoningEffortMap[backendId]) {
        this.draft.modelRouter.reasoningEffortMap[backendId] = {};
      }
      const m = this.modelsForBackend(backendId);
      const next = m.find(x => !(x in this.draft.modelRouter.reasoningEffortMap[backendId])) || m[0] || "";
      if (next) this.draft.modelRouter.reasoningEffortMap[backendId][next] = "medium";
    },

    removeEffortMapping(backendId, model) {
      delete this.draft.modelRouter.reasoningEffortMap[backendId][model];
    },

    async save() {
      const patch = computeConfigPatch(this.config, this.draft);
      const res = await adminFetch("/admin/config", { method: "PATCH", body: JSON.stringify(patch) });
      if (res.ok) { this.config = JSON.parse(JSON.stringify(this.draft)); }
      else { const b = await res.json().catch(() => ({})); this.error = b.error?.message || `HTTP ${res.status}`; }
    },
    discard() { this.draft = JSON.parse(JSON.stringify(this.config)); },
    isDirty() { return JSON.stringify(this.config) !== JSON.stringify(this.draft); },
  };
}
window.routerPanel = routerPanel;
```

- [ ] **Step 2: Fill in the Router `<section>` in `index.html`**

```html
<section x-show="activePanel === 'router'" x-data="routerPanel()" x-init="init()" x-destroy="destroy()">
  <template x-if="loading"><p class="muted">Loading…</p></template>
  <template x-if="error"><p class="error" x-text="error"></p></template>

  <template x-if="!loading && draft">
    <div class="glass-card" style="padding: 24px;">
      <h2>Routing</h2>
      <div class="form-grid">
        <label>Default backend
          <select x-model="draft.modelRouter.defaultBackend">
            <template x-for="b in selectableBackends()" :key="b">
              <option :value="b" x-text="b"></option>
            </template>
          </select>
        </label>
        <label>opusPromptTokens
          <input type="number" x-model.number="draft.modelRouter.thresholds.opusPromptTokens">
        </label>
        <label>opusToolCount
          <input type="number" x-model.number="draft.modelRouter.thresholds.opusToolCount">
        </label>
        <label>sonnetPromptTokens
          <input type="number" x-model.number="draft.modelRouter.thresholds.sonnetPromptTokens">
        </label>
      </div>

      <h3 style="margin-top: 24px;">Reasoning-effort maps</h3>
      <template x-for="bid in selectableBackends()" :key="bid">
        <div class="effort-map-block">
          <header><strong x-text="bid"></strong>
            <button type="button" class="ghost" @click="addEffortMapping(bid)">
              <span x-html="ICONS.plus"></span> Add mapping
            </button>
          </header>
          <template x-for="(effort, model) in (draft.modelRouter.reasoningEffortMap?.[bid] || {})" :key="bid + ':' + model">
            <div class="effort-row">
              <select :value="model" @change="(e)=>{ const v=e.target.value; const old=model; const map=draft.modelRouter.reasoningEffortMap[bid]; map[v]=map[old]; delete map[old]; }">
                <template x-for="m in modelsForBackend(bid)" :key="m">
                  <option :value="m" x-text="m"></option>
                </template>
              </select>
              <select x-model="draft.modelRouter.reasoningEffortMap[bid][model]">
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
              <button type="button" class="danger" @click="removeEffortMapping(bid, model)">
                <span x-html="ICONS.trash"></span>
              </button>
            </div>
          </template>
        </div>
      </template>

      <footer class="save-bar" x-show="isDirty()" style="margin-top: 24px;">
        <button type="button" class="ghost" @click="discard()">Discard</button>
        <button type="button" class="primary" @click="save()">Save changes</button>
      </footer>
    </div>
  </template>
</section>
```

Add styles:

```css
.effort-map-block { margin-top: 16px; padding: 12px; border: 1px solid var(--glass-border); border-radius: var(--button-radius); }
.effort-map-block header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.effort-row { display: grid; grid-template-columns: 2fr 1fr auto; gap: 8px; margin: 6px 0; }
```

- [ ] **Step 3: Commit**

```bash
git add src/admin-ui/app.js src/admin-ui/index.html src/admin-ui/styles.css
git commit -m "feat(admin-ui): Router panel — defaultBackend, thresholds, per-backend reasoning-effort map"
```

---

## Task 13: General panel

**Files:**
- Modify: `src/admin-ui/app.js` (flesh out `generalPanel()`).
- Modify: `src/admin-ui/index.html` (fill in the General `<section>`).

`apiKey` (write-only — display masked as `***`; the only way to change it is to type a new value in a separate "Update API key" field which then patches the config). Archive/cache/files paths and limits as plain inputs. `adminUi.bindLocalhost` toggle — when the user attempts to disable it, show a confirmation modal explaining the security implication.

- [ ] **Step 1: Flesh out `generalPanel()`**

```js
function generalPanel() {
  return {
    loading: true,
    error: null,
    config: null,
    draft: null,
    newApiKey: "",
    showBindConfirm: false,
    pendingBindToggle: null,

    async init() {
      const res = await adminFetch("/admin/config");
      this.config = await res.json();
      this.draft = JSON.parse(JSON.stringify(this.config));
      this.loading = false;
    },

    requestBindToggle(nextValue) {
      // If disabling (true → false), require confirmation.
      if (this.draft.adminUi.bindLocalhost === true && nextValue === false) {
        this.pendingBindToggle = false;
        this.showBindConfirm = true;
        return;
      }
      this.draft.adminUi.bindLocalhost = nextValue;
    },

    confirmBindToggle() {
      this.draft.adminUi.bindLocalhost = this.pendingBindToggle;
      this.showBindConfirm = false;
      this.pendingBindToggle = null;
    },
    cancelBindToggle() {
      this.showBindConfirm = false;
      this.pendingBindToggle = null;
    },

    async save() {
      const patch = computeConfigPatch(this.config, this.draft);
      if (this.newApiKey.trim().length > 0) {
        patch.apiKey = this.newApiKey;
      }
      const res = await adminFetch("/admin/config", { method: "PATCH", body: JSON.stringify(patch) });
      if (res.ok) {
        this.newApiKey = "";
        const reloaded = await (await adminFetch("/admin/config")).json();
        this.config = reloaded;
        this.draft = JSON.parse(JSON.stringify(reloaded));
      } else {
        const b = await res.json().catch(() => ({}));
        this.error = b.error?.message || `HTTP ${res.status}`;
      }
    },
    discard() { this.draft = JSON.parse(JSON.stringify(this.config)); this.newApiKey = ""; },
    isDirty() { return this.newApiKey.length > 0 || JSON.stringify(this.config) !== JSON.stringify(this.draft); },
  };
}
window.generalPanel = generalPanel;
```

- [ ] **Step 2: Fill in the General `<section>` in `index.html`**

```html
<section x-show="activePanel === 'general'" x-data="generalPanel()" x-init="init()">
  <template x-if="loading"><p class="muted">Loading…</p></template>
  <template x-if="error"><p class="error" x-text="error"></p></template>

  <template x-if="!loading && draft">
    <div class="glass-card" style="padding: 24px;">

      <h2>API key</h2>
      <div class="form-grid">
        <label>Current
          <input type="text" value="***" disabled>
        </label>
        <label>Set new API key (leave blank to keep)
          <input type="password" x-model="newApiKey" autocomplete="new-password">
        </label>
      </div>

      <h2 style="margin-top: 24px;">Archive</h2>
      <div class="form-grid">
        <label>DB path<input type="text" x-model="draft.archive.dbPath"></label>
        <label>Compression level<input type="number" x-model.number="draft.archive.compressionLevel"></label>
      </div>

      <h2 style="margin-top: 24px;">Cache</h2>
      <div class="form-grid">
        <label>File<input type="text" x-model="draft.cache.file"></label>
        <label>TTL (ms)<input type="number" x-model.number="draft.cache.ttlMs"></label>
        <label>Max entries<input type="number" x-model.number="draft.cache.maxEntries"></label>
      </div>

      <h2 style="margin-top: 24px;">Files</h2>
      <div class="form-grid">
        <label>Dir<input type="text" x-model="draft.files.dir"></label>
        <label>TTL (ms)<input type="number" x-model.number="draft.files.ttlMs"></label>
        <label>Max total bytes<input type="number" x-model.number="draft.files.maxTotalBytes"></label>
      </div>

      <h2 style="margin-top: 24px;">Admin UI</h2>
      <div class="form-grid">
        <label class="toggle">
          <input type="checkbox" :checked="draft.adminUi.bindLocalhost" @change="requestBindToggle($event.target.checked)">
          bindLocalhost
        </label>
        <label>sessionTtlMs<input type="number" x-model.number="draft.adminUi.sessionTtlMs"></label>
      </div>

      <footer class="save-bar" x-show="isDirty()" style="margin-top: 24px;">
        <button type="button" class="ghost" @click="discard()">Discard</button>
        <button type="button" class="primary" @click="save()">Save changes</button>
      </footer>
    </div>
  </template>

  <!-- Bind-localhost confirmation modal -->
  <template x-if="showBindConfirm">
    <div class="modal-overlay" @click.self="cancelBindToggle()">
      <div class="modal glass-card">
        <h2>Disable localhost binding?</h2>
        <p>
          With bindLocalhost off, the admin UI accepts requests from any IP address.
          This exposes config editing — including the apiKey set form — to the local
          network. Only proceed if you have other network controls in place (firewall,
          reverse-proxy auth, etc.).
        </p>
        <div class="modal-actions">
          <button type="button" class="ghost" @click="cancelBindToggle()">Cancel</button>
          <button type="button" class="danger" @click="confirmBindToggle()">Disable bindLocalhost</button>
        </div>
      </div>
    </div>
  </template>
</section>
```

Add modal styles:

```css
.modal-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 20px; }
```

- [ ] **Step 3: Commit**

```bash
git add src/admin-ui/app.js src/admin-ui/index.html src/admin-ui/styles.css
git commit -m "feat(admin-ui): General panel — apiKey rotation, archive/cache/files settings, bind-localhost confirm modal"
```

---

## Task 14: Archive viewer panel

**Files:**
- Modify: `src/admin-ui/app.js` (flesh out `archivePanel()`).
- Modify: `src/admin-ui/index.html` (fill in the Archive `<section>`).

Paginated table backed by `GET /admin/archive`. Filters: backend, session, model, since, until, status. Substring search box (debounced 300ms, calls `/admin/archive/search?q=...`). Row click → modal with `GET /admin/archive/{id}` and the full decompressed request + response bodies pretty-printed.

- [ ] **Step 1: Flesh out `archivePanel()`**

```js
function archivePanel() {
  const PAGE_SIZE = 25;
  return {
    rows: [],
    totalCount: 0,
    page: 0,
    pageSize: PAGE_SIZE,
    loading: false,
    error: null,
    filters: { backend: "", session: "", model: "", since: "", until: "", status: "" },
    searchQuery: "",
    detail: null,            // currently-open archive entry (modal contents)
    detailLoading: false,
    debouncedSearch: null,

    init() {
      this.debouncedSearch = debounce(() => { this.page = 0; this.reload(); }, 300);
      this.reload();
    },

    async reload() {
      this.loading = true;
      this.error = null;
      try {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(this.filters)) if (v) qs.set(k, v);
        if (this.searchQuery) qs.set("q", this.searchQuery);
        qs.set("limit", String(this.pageSize));
        qs.set("offset", String(this.page * this.pageSize));
        const path = this.searchQuery ? "/admin/archive/search?" + qs.toString() : "/admin/archive?" + qs.toString();
        const res = await adminFetch(path);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        this.rows = body.entries || [];
        this.totalCount = body.totalCount ?? body.total ?? this.rows.length;
      } catch (e) { this.error = e instanceof Error ? e.message : String(e); }
      finally { this.loading = false; }
    },

    async openDetail(row) {
      this.detail = null;
      this.detailLoading = true;
      try {
        const res = await adminFetch(`/admin/archive/${encodeURIComponent(row.id)}`);
        this.detail = await res.json();
      } catch (e) { this.error = e instanceof Error ? e.message : String(e); }
      finally { this.detailLoading = false; }
    },
    closeDetail() { this.detail = null; },

    onFilterChange() { this.page = 0; this.reload(); },
    onSearchInput() { this.debouncedSearch(); },

    prevPage() { if (this.page > 0) { this.page--; this.reload(); } },
    nextPage() { if ((this.page + 1) * this.pageSize < this.totalCount) { this.page++; this.reload(); } },

    formatTime(ts) { return ts ? new Date(ts).toLocaleString() : "—"; },
    prettyJSON(v) { try { return JSON.stringify(v, null, 2); } catch { return String(v); } },
  };
}
window.archivePanel = archivePanel;
```

- [ ] **Step 2: Fill in the Archive `<section>` in `index.html`**

```html
<section x-show="activePanel === 'archive'" x-data="archivePanel()" x-init="init()">
  <div class="glass-card" style="padding: 16px;">
    <div class="filters-bar">
      <label>Backend
        <select x-model="filters.backend" @change="onFilterChange()">
          <option value="">all</option>
          <option value="claude">claude</option>
          <option value="gemini">gemini</option>
          <option value="lmstudio">lmstudio</option>
          <option value="ollama">ollama</option>
        </select>
      </label>
      <label>Session<input type="text" x-model="filters.session" @input.debounce.300ms="onFilterChange()"></label>
      <label>Model<input type="text" x-model="filters.model" @input.debounce.300ms="onFilterChange()"></label>
      <label>Since (ms epoch)<input type="number" x-model.number="filters.since" @change="onFilterChange()"></label>
      <label>Until (ms epoch)<input type="number" x-model.number="filters.until" @change="onFilterChange()"></label>
      <label>Status
        <select x-model="filters.status" @change="onFilterChange()">
          <option value="">any</option>
          <option value="success">success</option>
          <option value="error">error</option>
          <option value="timeout">timeout</option>
        </select>
      </label>
      <label>
        Search
        <div class="input-with-toggle">
          <span class="search-icon" x-html="ICONS.search"></span>
          <input type="search" placeholder="substring in request prompts" x-model="searchQuery" @input="onSearchInput()">
        </div>
      </label>
    </div>
  </div>

  <div class="glass-card" style="padding: 0; margin-top: 16px; overflow: hidden;">
    <template x-if="loading"><p class="muted" style="padding: 16px;">Loading…</p></template>
    <template x-if="error"><p class="error" style="padding: 16px;" x-text="error"></p></template>
    <table class="archive-table" x-show="!loading && rows.length > 0">
      <thead>
        <tr>
          <th>Timestamp</th><th>Backend</th><th>Model</th><th>Endpoint</th>
          <th>Session</th><th>Status</th><th>Tokens</th><th>Dur</th>
        </tr>
      </thead>
      <tbody>
        <template x-for="row in rows" :key="row.id">
          <tr @click="openDetail(row)">
            <td x-text="formatTime(row.timestamp)"></td>
            <td x-text="row.backend"></td>
            <td x-text="row.modelResolved || row.model"></td>
            <td x-text="row.endpoint"></td>
            <td x-text="row.sessionId"></td>
            <td x-text="row.status"></td>
            <td x-text="(row.inputTokens ?? '?') + '/' + (row.outputTokens ?? '?')"></td>
            <td x-text="row.durationMs + 'ms'"></td>
          </tr>
        </template>
      </tbody>
    </table>

    <div class="pagination" style="padding: 12px;">
      <button class="ghost" :disabled="page === 0" @click="prevPage()">Prev</button>
      <span x-text="`Page ${page + 1} — ${totalCount} total`"></span>
      <button class="ghost" :disabled="(page + 1) * pageSize >= totalCount" @click="nextPage()">Next</button>
    </div>
  </div>

  <template x-if="detail || detailLoading">
    <div class="modal-overlay" @click.self="closeDetail()">
      <div class="modal glass-card">
        <header class="modal-header">
          <h2>Archive entry</h2>
          <button type="button" class="ghost" @click="closeDetail()">
            <span x-html="ICONS.close"></span>
          </button>
        </header>
        <template x-if="detailLoading"><p class="muted">Loading…</p></template>
        <template x-if="detail">
          <div>
            <h3>Metadata</h3>
            <pre x-text="prettyJSON({ id: detail.id, backend: detail.backend, model: detail.modelResolved || detail.model, endpoint: detail.endpoint, sessionId: detail.sessionId, status: detail.status, durationMs: detail.durationMs, inputTokens: detail.inputTokens, outputTokens: detail.outputTokens, timestamp: detail.timestamp })"></pre>
            <h3>Request</h3>
            <pre x-text="prettyJSON(detail.requestBody)"></pre>
            <h3>Response</h3>
            <pre x-text="prettyJSON(detail.responseBody)"></pre>
          </div>
        </template>
      </div>
    </div>
  </template>
</section>
```

Add the per-panel styles:

```css
.filters-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.search-icon { display: inline-flex; align-items: center; color: var(--text-muted); padding: 0 8px; }
.pagination { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
.modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.modal pre { white-space: pre-wrap; word-break: break-word; background: var(--input-bg); padding: 12px; border-radius: var(--button-radius); font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; max-height: 40vh; overflow: auto; }
```

- [ ] **Step 3: Commit**

```bash
git add src/admin-ui/app.js src/admin-ui/index.html src/admin-ui/styles.css
git commit -m "feat(admin-ui): Archive viewer panel — paginated table, filters, substring search, detail modal"
```

---

## Task 15: Inline-SVG icons placeholder documentation

**Files:**
- Create: `src/admin-ui/icons/README.md`

The icons directory in the file map is documentation-only — Plan 12 ships icons as string constants in `app.js` (see Task 9's `ICONS` constant). The directory exists as a placeholder so future plans can adopt a different icon-distribution strategy without restructuring the asset tree.

- [ ] **Step 1: Create the README**

```markdown
# Admin UI icons

Plan 12 ships icons as inline-SVG string constants in `../app.js` under the
`ICONS` object. The reasons for not shipping standalone `.svg` files here:

1. **No build step.** Vanilla browsers cannot `import` non-JS modules without a
   bundler. We could load each `.svg` via `fetch()`, but every icon becomes a
   second network round-trip on first render.
2. **No icon font.** A font shipped here would add a binary asset + a
   `@font-face` declaration; inline SVG is simpler and themes via
   `fill="currentColor"` for free.
3. **No external image requests.** The spec mandates "no external image
   requests beyond the Alpine.js CDN."

## Adding an icon

1. Find or hand-draw a 24×24 SVG.
2. Strip the `width` / `height` attributes; keep `viewBox="0 0 24 24"`.
3. Use `fill="currentColor"` or `stroke="currentColor"` so it picks up CSS color.
4. Paste the resulting markup as a new entry in `../app.js`'s `ICONS` object.
5. Reference it from a template via `x-html="ICONS.your_icon_name"`.

## Future evolution

If the icon set grows past ~30 entries, consider migrating to a separate
`icons.js` module imported by `app.js` (still a single script load, but
separated for readability).
```

- [ ] **Step 2: Commit**

```bash
git add src/admin-ui/icons/README.md
git commit -m "docs(admin-ui): document the inline-SVG icon approach"
```

---

## Task 16: Integration test — `tests/integration/adminUi.test.ts`

**Files:**
- Create: `tests/integration/adminUi.test.ts`

End-to-end test against the live Express app (built via `buildApp`/`main` from `src/server.ts`). Verifies the full HTTP stack: static asset serving, login flow, cookie equivalence with `x-api-key`, expiration, and localhost-bind enforcement.

- [ ] **Step 1: Write the test**

Create `tests/integration/adminUi.test.ts`. Structure (describe blocks + key assertions):

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

// Build a real server.ts app with a fixture config.
async function buildServerForTest(opts: { apiKey: string; bindLocalhost?: boolean; sessionTtlMs?: number }): Promise<{ app: Express; cleanup: () => void }> {
  const dir = mkdtempSync(path.join(tmpdir(), "claudemcp-it-"));
  const configPath = path.join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    apiKey: opts.apiKey,
    adminUi: {
      enabled: true,
      bindLocalhost: opts.bindLocalhost ?? false, // false so supertest can reach it from arbitrary IP
      sessionTtlMs: opts.sessionTtlMs ?? 3_600_000,
    },
    // (Add minimal stubs for every backend config block so loadConfig validates.
    //  Mirror the fixture used in tests/integration/messages.test.ts.)
    // ... omitted for brevity; see existing integration tests for the canonical shape.
  }));
  const { buildApp } = await import("../../src/server.js");
  const app = await buildApp({ configPath });
  return { app, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("adminUi integration — static assets", () => {
  let app: Express; let cleanup: () => void;
  beforeAll(async () => { ({ app, cleanup } = await buildServerForTest({ apiKey: "test-key" })); });
  afterAll(() => cleanup());

  it("GET /admin/ui/ serves index.html with the pinned Alpine CDN script tag", async () => {
    const res = await request(app).get("/admin/ui/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("https://cdn.jsdelivr.net/npm/alpinejs@");
    expect(res.text).toContain("integrity=\"sha384-");
  });

  it("GET /admin/ui/app.js returns application/javascript", async () => {
    const res = await request(app).get("/admin/ui/app.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/javascript/);
  });

  it("GET /admin/ui/styles.css returns text/css", async () => {
    const res = await request(app).get("/admin/ui/styles.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/css/);
  });

  it("GET /admin/ui/themes/light.css and dark.css both resolve", async () => {
    expect((await request(app).get("/admin/ui/themes/light.css")).status).toBe(200);
    expect((await request(app).get("/admin/ui/themes/dark.css")).status).toBe(200);
  });
});

describe("adminUi integration — login flow + cookie equivalence", () => {
  let app: Express; let cleanup: () => void;
  beforeAll(async () => { ({ app, cleanup } = await buildServerForTest({ apiKey: "secret-xyz" })); });
  afterAll(() => cleanup());

  it("POST /admin/ui/session with the right apiKey returns 204 + Set-Cookie", async () => {
    const res = await request(app).post("/admin/ui/session").send({ apiKey: "secret-xyz" });
    expect(res.status).toBe(204);
    expect(res.headers["set-cookie"]).toBeDefined();
  });

  it("session cookie authenticates a subsequent GET /admin/backends", async () => {
    const login = await request(app).post("/admin/ui/session").send({ apiKey: "secret-xyz" });
    const cookie = (login.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
    const res = await request(app).get("/admin/backends").set("Cookie", cookie);
    expect(res.status).toBe(200); // Plan 11 endpoint
  });

  it("x-api-key alone (no cookie) still authenticates /admin/backends", async () => {
    const res = await request(app).get("/admin/backends").set("x-api-key", "secret-xyz");
    expect(res.status).toBe(200);
  });

  it("no auth at all → 401 on /admin/backends", async () => {
    const res = await request(app).get("/admin/backends");
    expect(res.status).toBe(401);
  });

  it("DELETE /admin/ui/session invalidates the cookie", async () => {
    const login = await request(app).post("/admin/ui/session").send({ apiKey: "secret-xyz" });
    const cookie = (login.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
    await request(app).delete("/admin/ui/session").set("Cookie", cookie);
    const res = await request(app).get("/admin/backends").set("Cookie", cookie);
    expect(res.status).toBe(401);
  });
});

describe("adminUi integration — session expiration", () => {
  it("expired session cookie returns 401 on /admin/backends", async () => {
    // Use a 50ms TTL so the cookie expires within the test.
    const { app, cleanup } = await buildServerForTest({ apiKey: "secret", sessionTtlMs: 50 });
    try {
      const login = await request(app).post("/admin/ui/session").send({ apiKey: "secret" });
      const cookie = (login.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
      // Wait past TTL.
      await new Promise(r => setTimeout(r, 80));
      const res = await request(app).get("/admin/backends").set("Cookie", cookie);
      expect(res.status).toBe(401);
    } finally { cleanup(); }
  });
});

describe("adminUi integration — localhost bind enforcement", () => {
  it("bindLocalhost=true rejects non-loopback with 403", async () => {
    const { app, cleanup } = await buildServerForTest({ apiKey: "secret", bindLocalhost: true });
    try {
      // supertest sets req.ip to 127.0.0.1 by default — we need to override.
      // The cleanest path: hit the app directly through Node http to control X-Forwarded-For
      // (the server is built with app.set("trust proxy", true) in Task 5 — see deviations log).
      const res = await request(app).get("/admin/ui/").set("X-Forwarded-For", "8.8.8.8");
      expect(res.status).toBe(403);
    } finally { cleanup(); }
  });

  it("bindLocalhost=true accepts 127.0.0.1", async () => {
    const { app, cleanup } = await buildServerForTest({ apiKey: "secret", bindLocalhost: true });
    try {
      const res = await request(app).get("/admin/ui/");
      expect(res.status).toBe(200);
    } finally { cleanup(); }
  });
});
```

(Note: the `buildServerForTest` minimal config stub needs every required field from Plan 01's `loadConfig` Zod schema. The exact shape lives in the existing `tests/integration/messages.test.ts` fixture — copy the `apiKey` + per-backend `enabled: false` defaults so the build succeeds without requiring real backend processes.)

- [ ] **Step 2: Run tests + typecheck**

```bash
npx vitest run tests/integration/adminUi.test.ts
npx tsc --noEmit
```

Expect ~14 green tests.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/adminUi.test.ts
git commit -m "test(integration): adminUi — static assets, login, cookie equivalence, expiry, bind enforcement"
```

---

## Task 17: Optional Playwright visual regression test (skipped in CI)

**Files:**
- Create: `tests/integration/adminUi.visual.test.ts`
- Create: `tests/integration/adminUi.visual.baseline/.gitkeep`
- Create: `playwright.config.ts`

A self-contained Playwright test that launches headless Chromium, logs in via the UI, toggles the theme, snapshots each panel in both themes, and compares to baselines. Gated behind `RUN_VISUAL=1`. Default-skipped under CI to avoid noisy visual diffs.

- [ ] **Step 1: Write `playwright.config.ts`**

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/integration",
  testMatch: "adminUi.visual.test.ts",
  fullyParallel: false,
  workers: 1,
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  },
  expect: {
    toMatchSnapshot: { threshold: 0.02 },
  },
  snapshotPathTemplate: "tests/integration/adminUi.visual.baseline/{arg}{ext}",
});
```

- [ ] **Step 2: Write the test**

Create `tests/integration/adminUi.visual.test.ts`. Skeleton:

```ts
import { test, expect } from "@playwright/test";

const RUN = process.env.RUN_VISUAL === "1";
const BASE = process.env.ADMIN_URL || "http://127.0.0.1:8899";
const API_KEY = process.env.ADMIN_API_KEY || "test-key";

test.describe("Admin UI — visual regression", () => {
  test.skip(!RUN, "Skipped in CI. Run `npm run test:visual` against a live server.");

  for (const theme of ["light", "dark"] as const) {
    test.describe(`${theme} theme`, () => {
      test.beforeEach(async ({ page }) => {
        await page.goto(`${BASE}/admin/ui/`);
        // Set theme preference before login so initial paint matches.
        await page.evaluate((t) => localStorage.setItem("claudemcp-theme", t), theme);
        await page.reload();
        await page.fill("#apikey", API_KEY);
        await page.click("button.primary");
        await page.waitForSelector(".app-shell");
      });

      for (const panel of ["dashboard", "backends", "router", "general", "archive"]) {
        test(`${panel} panel`, async ({ page }) => {
          await page.click(`.nav-item:has-text("${panel.charAt(0).toUpperCase() + panel.slice(1)}")`);
          await page.waitForTimeout(500); // allow paint
          await expect(page).toHaveScreenshot(`${theme}-${panel}.png`);
        });
      }
    });
  }
});
```

- [ ] **Step 3: Document the manual run procedure**

In the close-out README (Task 18):
1. Start the server: `npm run dev`.
2. Set `ADMIN_API_KEY=<your-key>` and `ADMIN_URL=http://127.0.0.1:8899`.
3. Run `npm run test:visual`.
4. On first run, Playwright generates the baselines under `tests/integration/adminUi.visual.baseline/`. On subsequent runs, it diffs.
5. To accept new baselines: `npx playwright test --update-snapshots`.

- [ ] **Step 4: Commit**

```bash
git add playwright.config.ts tests/integration/adminUi.visual.test.ts tests/integration/adminUi.visual.baseline/.gitkeep
git commit -m "test(visual): optional Playwright visual regression for admin UI — gated behind RUN_VISUAL=1"
```

---

## Task 18: Plan-12 close-out documentation

**Files:**
- Create: `docs/plan-12-admin-ui-readme.md`

- [ ] **Step 1: Write the document**

Create `docs/plan-12-admin-ui-readme.md`:

```markdown
# Plan 12 — Admin UI: what shipped

Plan 12 added the localhost-only web admin SPA on top of Plan 11's admin REST
endpoints. Operators now open `http://127.0.0.1:8899/admin/ui` in a browser
and get a five-panel, themeable, glassmorphism UI for managing the server.

## Modules added

| Path | Purpose | Lines (approx.) |
|---|---|---|
| `src/admin/session.ts` | In-memory session-token store with TTL eviction (`issue/validate/revoke/sweep`) | ~120 |
| `src/admin/ui.ts` | Express Router: static asset serving from `src/admin-ui/`, `POST/DELETE /session`, localhost-bind guard | ~180 |
| `src/server.ts` (extended) | cookie-parser middleware, SessionStore construction + sweep interval, sessionAuthMiddleware ahead of every `/admin/*` route, mount `createAdminUiHandler` at `/admin/ui`, startup warning when bindLocalhost is false | +60 |
| `src/admin-ui/index.html` | SPA shell — pinned Alpine.js CDN+SRI, both theme stylesheets loaded unconditionally, FOUC-prevention inline script, login template + authenticated shell template | ~140 |
| `src/admin-ui/app.js` | Alpine.js root `app()`, ICONS string-export table, `adminFetch` wrapper, `debounce` utility, shared `/admin/backends` poller, five panel components | ~520 |
| `src/admin-ui/styles.css` | Base reset, viewport gradient, layout grid, top bar, sidebar, glass surfaces, buttons, inputs, status pills, tables, modals, login shell, `prefers-reduced-motion`, backdrop-filter fallback, per-panel styles | ~580 |
| `src/admin-ui/themes/light.css` | `[data-theme="light"]` custom-property values — pastel lavender → soft pink → pale cyan, white-tinted glass | ~50 |
| `src/admin-ui/themes/dark.css` | `[data-theme="dark"]` custom-property values — deep indigo → violet → near-black, smoky translucent glass | ~50 |
| `src/admin-ui/icons/README.md` | Documents the inline-SVG icon distribution + how to add an icon | ~30 |

## Test infrastructure added

| Path | Purpose |
|---|---|
| `tests/unit/admin/session.test.ts` | 12 cases: token format, uniqueness, TTL boundaries, revoke, sweep, lazy eviction, constructor validation |
| `tests/unit/admin/ui.test.ts` | ~22 cases: isLoopback, bind enforcement, static serving + content types, login/logout flows, cookie attributes |
| `tests/integration/adminUi.test.ts` | ~14 cases through the real Express app: static assets resolve, login → cookie → /admin/backends works, cookie OR x-api-key both succeed, no auth → 401, session expiration, bindLocalhost rejects non-loopback |
| `tests/integration/adminUi.visual.test.ts` (optional) | Playwright snapshots of all 5 panels × 2 themes = 10 baselines. Gated behind RUN_VISUAL=1. |
| `playwright.config.ts` | Playwright config for the visual suite — single worker, fixed 1440×900 viewport, 0.02 diff threshold |

Run all (default): `npm test`. Expect prior-plan count + ~48 new tests.
Run optional visual suite: `RUN_VISUAL=1 npm run test:visual` (requires a
running dev server and an API key in `ADMIN_API_KEY`).

## Dependencies added

- `cookie-parser@^1.4.6` (runtime) — `Cookie` header parsing.
- `@types/cookie-parser@^1.4.7` (dev).
- `@playwright/test@^1.48.0` (dev) — for the opt-in visual suite. Not required for `npm test`.

## Alpine.js pinning

Alpine.js is loaded from jsDelivr at a pinned version with an SRI hash:

```html
<script
  defer
  src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js"
  integrity="sha384-<HASH>"
  crossorigin="anonymous"
></script>
```

To bump the version: change the URL AND recompute the hash via
`curl -sL <URL> | openssl dgst -sha384 -binary | openssl base64 -A`, prepend
`sha384-`, paste back into the integrity attribute. Both must land in the same
commit.

## Auth model

- `/admin/ui/*` (static HTML/CSS/JS, login endpoint) — NO auth required.
- `/admin/*` (all other JSON endpoints from Plan 05 + Plan 11) — auth required
  via EITHER `x-api-key: <key>` header OR `Cookie: claudemcp_session=<token>`.
  The session middleware checks both; either succeeds.

Cookie attributes set by `POST /admin/ui/session`:
- `HttpOnly` — not readable from JS, prevents XSS exfiltration.
- `SameSite=Strict` — not sent on cross-origin requests.
- `Path=/admin` — only sent to admin endpoints.
- `Max-Age=<config.adminUi.sessionTtlMs / 1000>` — browser auto-evicts at TTL.

In-memory session store — no persistence across restarts. Operators re-log-in.

## Localhost bind enforcement

`config.adminUi.bindLocalhost: true` (default) rejects any request whose
`req.ip` is not `127.0.0.1` / `::1` / `::ffff:127.0.0.1` with HTTP 403.
Disabling requires checking the box in the General panel + confirming a
warning modal. A startup log line warns when bindLocalhost is false.

## Theme system

Both `themes/light.css` and `themes/dark.css` are loaded unconditionally. Each
wraps its custom-property declarations in a `[data-theme="..."]` attribute
selector on `<html>`, so only one matches at any moment. Theme switching is a
single `document.documentElement.setAttribute("data-theme", t)` call.

First-visit default honors `window.matchMedia("(prefers-color-scheme: light)")`.
Persisted to `localStorage["claudemcp-theme"]`. An inline `<script>` in
`<head>` runs the theme detection BEFORE any stylesheet rule paints, so there
is no flash-of-unstyled-content.

## CSS architecture

Every paintable property in `styles.css` reads from a CSS custom property
(`--glass-bg`, `--glass-border`, `--accent`, etc.). No literal color values
live in `styles.css`. The two theme files are the only place real colors
appear. See the "CSS architecture overview" table in `plans/2026-05-16-plan-12-admin-ui.md`
for the full property list.

## Mount-order load-bearing detail

In `src/server.ts`, the mount order is:

```ts
app.use(cookieParser());
// ... other middleware ...
app.use("/admin/ui", createAdminUiHandler({ ... }));     // mounted FIRST
app.use("/admin", sessionAuthMiddleware);                 // mounted SECOND
app.use("/admin/archive", createArchiveAdminHandler({ ... }));
app.use("/admin/backends", createBackendsAdminHandler({ ... }));
app.use("/admin/config", createConfigAdminHandler({ ... }));
```

The `/admin/ui` Router must mount BEFORE the `/admin` catch-all auth
middleware. Express matches routers in declaration order; this is what keeps
the unauthenticated SPA + login endpoint reachable while every JSON `/admin/*`
endpoint stays gated.

## Plan-12 scope boundary (what does NOT ship here)

- Log streaming over WebSocket — deferred (spec open question).
- In-UI request replay — deferred.
- In-UI prompt playground — deferred.
- Multi-user audit log — deferred.
- Theme customization beyond light/dark — deferred.
- Server-Sent-Events for live UI updates — UI polls instead.
- Persistent session store — in-memory only; sessions clear on restart.
- Headless-browser CI gate — Playwright suite is opt-in via `npm run test:visual`.
- New `/admin/*` JSON endpoints — Plan 12 only adds `/admin/ui/*` static + session.

## Open questions surfaced during Plan 12

1. **Alpine.js version drift.** The pinned `3.14.1` may drift behind the current
   stable by the time the plan executes. The implementer should bump to whatever
   `3.x` is current at write time and recompute the SRI hash. The plan's
   architecture does not change.
2. **bindLocalhost behind a reverse proxy.** When the operator runs ClaudeMCP
   behind an nginx reverse proxy with `proxy_set_header X-Forwarded-For ...`,
   the literal `req.ip` is the proxy's address. `app.set("trust proxy", true)`
   in `server.ts` is required for the bind guard to honor `X-Forwarded-For`.
   Document in the operator README.
3. **PATCH /admin/config diff semantics with arrays.** `computeConfigPatch` in
   `app.js` emits a full-array replacement when an array changes (not a
   per-element merge). Plan 11's PATCH endpoint must agree. Spot-checked but a
   future plan could add explicit instance-id-keyed array merging if reordering
   becomes a need.
4. **Visual regression baseline ownership.** The Playwright baselines under
   `tests/integration/adminUi.visual.baseline/` are intentionally not
   committed initially (`.gitkeep` only). The decision to commit baselines is
   a release-process question — Plan 12 leaves it open.
5. **Embedded font for monospace `<pre>` blocks.** The archive detail modal
   uses the system monospace stack. If consistency across operator machines
   matters, a future plan could embed a single open-source mono font under
   `src/admin-ui/fonts/` — but that adds a binary asset the spec currently
   forbids.
6. **CSP for the Alpine.js CDN.** The current setup has no Content-Security-Policy
   header. Tightening to `default-src 'self'; script-src 'self' https://cdn.jsdelivr.net
   'sha384-<HASH>'; style-src 'self' 'unsafe-inline'` is a follow-up — the
   `unsafe-inline` is required because Alpine.js evaluates inline `x-data` /
   `x-show` attribute expressions, which CSP treats as inline scripts.

## Deviations from this plan that landed during execution

(Filled in by the implementer / reviewer during the actual task cycles. Expected
items typically include: SRI hash value once computed, any divergence in
Plan 11's `/admin/config` PATCH semantics requiring computeConfigPatch
adjustment, any divergence in Plan 11's `/admin/backends` JSON envelope shape
requiring panel selector changes, test-count reconciliation, and the actual
WCAG contrast values chosen for the worst-case gradient regions in each theme.)
```

- [ ] **Step 2: Commit**

```bash
git add docs/plan-12-admin-ui-readme.md
git commit -m "docs: add Plan 12 close-out README documenting admin UI scope, auth model, theme system"
```

---

## Plan 12 — Self-review checklist

Before declaring Plan 12 done, run through this checklist:

- [ ] `npm test` — all tests green, no skips (except the explicitly-skipped Playwright suite). Reconcile actual vs expected count in the close-out doc.
- [ ] `npx tsc --noEmit` — no type errors. Pay particular attention to:
  - `noUncheckedIndexedAccess` on cookie parsing in `ui.ts` (the manual `split("=")` returns possibly-undefined values).
  - The `Request & { cookies?: ... }` cast in `readSessionCookie` — confirm cookie-parser populates `req.cookies` at runtime.
  - The `(login.headers["set-cookie"] as unknown as string[])[0]` pattern in tests — supertest types `set-cookie` as `string | string[]` depending on version.
- [ ] `git status` — clean tree, all changes committed.
- [ ] `git log --oneline -20` — commits read sensibly: deps, session, ui handler, ui tests, server wiring, html shell, base CSS, themes, app.js root, dashboard, backends, router, general, archive, icons README, integration tests, visual suite, README.
- [ ] `src/admin/` directory contains: `archive.ts` (Plan 05), `backends.ts` (Plan 11), `config.ts` (Plan 11), `session.ts` (Plan 12), `ui.ts` (Plan 12) — no others.
- [ ] `src/admin-ui/` directory contains: `index.html`, `app.js`, `styles.css`, `themes/light.css`, `themes/dark.css`, `icons/README.md` — no others, no `.svg` files (icons are string constants in app.js per Task 15).
- [ ] `package.json` lists `cookie-parser` under `dependencies` and `@types/cookie-parser` + `@playwright/test` under `devDependencies`. `test:visual` script present.
- [ ] `src/server.ts` mounts `/admin/ui` BEFORE the `/admin` catch-all auth middleware. (Reverse order breaks login.)
- [ ] `src/admin-ui/index.html` has BOTH theme stylesheets loaded unconditionally; the inline `<script>` in `<head>` sets `data-theme` BEFORE the stylesheet rules paint.
- [ ] `src/admin-ui/index.html`'s Alpine.js `<script>` tag includes a `sha384-...` SRI hash (NOT the literal placeholder string from the plan).
- [ ] `src/admin-ui/styles.css` declares zero literal color values — every color reads from a `var(--*)` reference.
- [ ] `themes/light.css` and `themes/dark.css` declare the same set of custom properties — no key drift between the two files.
- [ ] `prefers-reduced-motion` media query disables the gradient drift + card hover-lift in `styles.css`.
- [ ] `@supports not (backdrop-filter)` fallback in `styles.css` sets a higher-opacity solid background per theme.
- [ ] No `.svg` files added under `src/admin-ui/icons/` (icons are string exports in `app.js`).
- [ ] No external image / font / script requests beyond the pinned Alpine.js CDN. (Check the Network panel in browser devtools after a fresh load.)
- [ ] `POST /admin/ui/session` Set-Cookie includes `HttpOnly`, `SameSite=Strict`, `Path=/admin`, and a numeric `Max-Age`.
- [ ] `bindLocalhost: true` rejects 8.8.8.8 with 403 in both unit and integration tests.
- [ ] `bindLocalhost: false` triggers a startup warning log line.
- [ ] Session sweep interval is `.unref()`'d so it doesn't keep the process alive.
- [ ] Manual WCAG AA contrast audit run for both themes; results noted in the close-out README.
- [ ] `dist/` directory is untouched (compare `git log dist/ -5` — last touch should predate this plan).
- [ ] No source file under `src/admin/` exceeds 200 lines (`ui.ts` ≈ 180 is the largest).
- [ ] No frontend file under `src/admin-ui/` exceeds 600 lines (`styles.css` ≈ 580 is the largest).
- [ ] No new admin JSON endpoints added — only `/admin/ui/session` (which is part of the auth flow, not a data endpoint).
- [ ] Prior-plan tests still pass unchanged (no regression from the cookie-parser + sessionAuthMiddleware additions).

If all check, Plan 12 is shipped. The admin UI is live on `http://127.0.0.1:8899/admin/ui`. Plan 13 (compat tests) is the final phase.
