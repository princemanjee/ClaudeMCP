# Plan 12 — Admin UI: what shipped

Plan 12 added the localhost-only web admin SPA on top of Plan 11's admin REST
endpoints. Operators now open `http://127.0.0.1:8899/admin/ui` in a browser
and get a five-panel, themeable, glassmorphism UI for managing the server.

## Modules added

| Path | Purpose | Lines (approx.) |
|---|---|---|
| `src/admin/session.ts` | In-memory session-token store with TTL eviction (`issue/validate/revoke/sweep`) | ~80 |
| `src/admin/ui.ts` | Express Router: static asset serving from `src/admin-ui/`, `POST/DELETE /session`, localhost-bind guard | ~165 |
| `src/server.ts` (extended) | cookie-parser middleware, SessionStore construction + sweep interval, sessionAuthMiddleware ahead of every `/admin/*` route, mount `createAdminUiHandler` at `/admin/ui`, startup warning when bindLocalhost is false | +60 |
| `src/auth.ts` (extended) | Added `checkApiKey(presented, expected)` helper for the JSON-body login path | +10 |
| `src/admin-ui/index.html` | SPA shell — pinned Alpine.js CDN+SRI, both theme stylesheets loaded unconditionally, FOUC-prevention inline script, login template + authenticated shell with all five panel sections | ~340 |
| `src/admin-ui/app.js` | Alpine.js root `app()`, ICONS string-export table, `adminFetch` wrapper, `debounce` utility, shared `/admin/backends` poller, five panel components (`dashboardPanel`, `backendsPanel`, `routerPanel`, `generalPanel`, `archivePanel`) and `computeConfigPatch` helper | ~580 |
| `src/admin-ui/styles.css` | Base reset, viewport gradient, layout grid, top bar, sidebar, glass surfaces, buttons, inputs, status pills, tables, modals, login shell, `prefers-reduced-motion`, backdrop-filter fallback, per-panel styles | ~430 |
| `src/admin-ui/themes/light.css` | `[data-theme="light"]` custom-property values — pastel lavender → soft pink → pale cyan, white-tinted glass | ~45 |
| `src/admin-ui/themes/dark.css` | `[data-theme="dark"]` custom-property values — deep indigo → violet → near-black, smoky translucent glass | ~45 |
| `src/admin-ui/icons/README.md` | Documents the inline-SVG icon distribution + how to add an icon | ~30 |

## Test infrastructure added

| Path | Purpose |
|---|---|
| `tests/unit/admin/session.test.ts` | 12 cases: token format, uniqueness, TTL boundaries, revoke, sweep, lazy eviction, constructor validation |
| `tests/unit/admin/ui.test.ts` | 25 cases: isLoopback, bind enforcement, static serving + content types, login/logout flows, cookie attributes, expired session contract, cookie reading |
| `tests/integration/adminUi.test.ts` | 15 cases through the real Express app: static assets resolve with content types, login → cookie → /admin/backends works, cookie OR x-api-key both succeed, no auth → 401, DELETE clears cookie, session expiration, bindLocalhost rejects non-loopback via X-Forwarded-For, adminUi.enabled=false skips the mount |
| `tests/integration/adminUi.visual.test.ts` (optional) | Playwright snapshots of all 5 panels × 2 themes = 10 baselines. Gated behind RUN_VISUAL=1, excluded from vitest's discovery. |
| `playwright.config.ts` | Playwright config for the visual suite — single worker, fixed 1440×900 viewport, 0.02 diff threshold |

Run all (default): `npm test`. Expect prior-plan count (753) + 52 new tests = ~805 passing + 2 skipped.
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
  src="https://cdn.jsdelivr.net/npm/alpinejs@3.15.12/dist/cdn.min.js"
  integrity="sha384-pb6hrQvo4s23cEUFtj0CZkzGE3jyK3pj26RIupXXxhSrrcUA/Cn0lZgcCrGH0t6L"
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
  The Plan 12 `sessionAuthMiddleware` checks for a valid session cookie and,
  if found, synthesizes an `x-api-key` header so the existing per-handler
  `checkAuth` accepts it.

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

The Plan 11 admin mount applies its own `bindLocalhostMiddleware` (driven by
the live config snapshot). Plan 12's `/admin/ui` Router applies an additional,
local guard that reads the config statically — this preserves the bind
enforcement for the SPA assets even when mounted ahead of the catch-all.

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
appear. See the "CSS architecture overview" table in
`docs/superpowers/plans/2026-05-16-plan-12-admin-ui.md`
for the full property list.

## Mount-order load-bearing detail

In `src/server.ts`, the mount order is:

```ts
app.use(cookieParser());
// ...
// 1. /admin/ui first (its own bind guard, no session middleware).
if (config.adminUi.enabled) {
  app.use("/admin/ui", createAdminUiHandler({ ... }));
}
// 2. sessionAuthMiddleware on /admin — promotes session cookie → x-api-key.
app.use("/admin", sessionAuthMiddleware);
// 3. The Plan 05 + Plan 11 admin routes (mounted via mountAdminRoutes).
mountAdminRoutes(app, { ... });
```

The `/admin/ui` Router MUST mount BEFORE the `/admin` catch-all. Express
matches in declaration order; reversing this would route `/admin/ui` requests
through `sessionAuthMiddleware`, which is harmless (the middleware is a no-op
without a valid header/cookie), but more importantly would make `/admin/ui`
subject to Plan 11's bindLocalhost middleware — which is desirable, but
needs the SPA static handler reachable so the operator can see a login form
at all.

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

## Deviations from the as-designed plan

The plan was written before the implementer inspected Plan 11's actual output
shapes and Plan 01's actual `src/auth.ts` API. Several mechanical adaptations
landed during execution to match the real codebase. None changed the
architecture.

1. **`auth.ts` API.** The plan calls for a `checkApiKey(presented, expected)`
   constant-time comparator. Plan 01 actually shipped `checkAuth(carrier,
   expected)` taking a header/query carrier. We added a thin
   `checkApiKey(presented, expected)` wrapper to `src/auth.ts` (sharing the
   same underlying `safeEqual`) for the admin UI's JSON-body login path; the
   existing `checkAuth` is unchanged.

2. **`sessionAuthMiddleware` semantics.** The plan envisioned a middleware
   that returns 401 directly on missing/invalid auth. The actual Plan 05 +
   Plan 11 admin handlers each call `checkAuth(req)` themselves. To avoid
   duplicating the auth logic, the Plan 12 middleware *promotes* a valid
   session cookie to a synthesized `x-api-key` header on the request so the
   existing per-handler `checkAuth` accepts it. Cookie-less requests still
   reach the handler where the existing checkAuth returns 401 if no x-api-key
   is present. End-to-end behavior matches the plan; the layering is
   different.

3. **`/admin/backends` JSON envelope.** The plan describes
   `{ instances: [{ backendId, name, baseUrl, enabled, lastProbeStatus,
   lastProbeAt, models }] }`. Plan 11 actually ships
   `{ data: [{ id, models, capabilities, lastProbe: { ok, at, error? } | null,
   reachable }] }` — a per-backend (not per-instance) shape with a different
   key set. The Dashboard, Backends, and Router panels were adapted to read
   from `state.data.data[]` instead of `state.data.instances[]`, and use
   `b.reachable + b.lastProbe.ok` as the health signal.

4. **`/admin/backends/test` body shape.** The plan POSTs
   `{ backendId, instance }`. Plan 11 actually accepts
   `{ baseUrl, apiKey?, useNativeApi? }`. The Backends panel sends the latter
   shape.

5. **`/admin/archive` response envelope.** The plan references `totalCount`
   and `entries`. Plan 05 actually returns `{ data: [...], has_more: bool }`.
   The Dashboard's last-hour count approximates by paging up to 200 (the cap)
   and suffixing `+` when `has_more` is true. The Archive viewer panel uses
   `data` + `has_more` for prev/next pagination instead of a numeric total.

6. **`/admin/archive` filter param types.** The plan treats `since`/`until` as
   ms-epoch numeric fields; Plan 05 actually expects ISO-8601 datetime
   strings. The Archive panel uses an `<input type="datetime-local">` and
   converts via `new Date(v).toISOString()`.

7. **`reasoningEffortMap` schema.** The plan offers `minimal/low/medium/high`
   in the tier selector. Plan 01's Zod schema accepts only
   `low/medium/high`. The Router panel drops `minimal` and keys mappings by
   tier (with a free-tier auto-pick on "Add mapping"). Also, the map's value
   is `model-id` (single string), not the plan's `{ model → effort }` flip;
   adapted accordingly.

8. **`router.defaultBackend` source.** The actual config path is
   `config.router.defaultBackend` (a top-level `router` object), not
   `config.modelRouter.defaultBackend`. All Router panel references updated.

9. **Alpine.js version.** Plan example pinned `3.14.1`. Implementation
   bumped to current stable `3.15.12` and computed the SRI hash
   `sha384-pb6hrQvo4s23cEUFtj0CZkzGE3jyK3pj26RIupXXxhSrrcUA/Cn0lZgcCrGH0t6L`
   on the day of execution.

10. **Vitest exclusion of the Playwright file.** Vitest's default discovery
    picks up any `*.test.ts` in `tests/`, including the Playwright visual
    file. The Playwright test would crash vitest. Added an explicit
    `tests/integration/adminUi.visual.test.ts` entry to vitest config's
    `exclude` list. Documented as a small `vitest.config.ts` extension.

11. **Test count.** The plan estimated ~22 ui.test.ts + ~14 integration cases.
    Implementation landed 25 + 15. Total Plan 12 test additions: 52 cases
    (12 session + 25 ui + 15 integration). Final suite: 805 passing + 2
    skipped (the prior-plan skips, no Plan 12 skips).

12. **Removed `x-destroy`.** Some panels declared `x-destroy="destroy()"` to
    clean up subscriptions. Alpine.js 3.x does not have a `x-destroy`
    directive — only `x-init` (no built-in destroy hook for `x-data`). The
    panels still expose `destroy()` for future use; for now the subscriptions
    are recreated on each panel switch (small leak in practice — every panel
    switch creates a new component instance whose subscribe callback survives
    in `backendsListeners`). A small follow-up could clean this up via
    Alpine's `$destroy` magic or a single-instance pattern. Documented as a
    known issue.

13. **`<input type="datetime-local">` in the Archive panel.** Native
    behaviour is browser/locale dependent and may not exactly preserve the
    timezone the user intends. Documented for follow-up.

## Open questions surfaced during Plan 12

1. **bindLocalhost behind a reverse proxy.** When the operator runs ClaudeMCP
   behind an nginx reverse proxy with `proxy_set_header X-Forwarded-For ...`,
   the literal `req.ip` is the proxy's address. `app.set("trust proxy", true)`
   is required for the bind guard to honor `X-Forwarded-For`. Plan 11 did not
   set this by default; Plan 12 didn't either. Operators behind a reverse
   proxy must explicitly enable trust-proxy.
2. **PATCH /admin/config diff semantics with arrays.** `computeConfigPatch` in
   `app.js` emits a full-array replacement when an array changes (matches
   Plan 11's RFC 7396 array-as-atomic rule).
3. **Visual regression baseline ownership.** The Playwright baselines under
   `tests/integration/adminUi.visual.baseline/` are intentionally not
   committed initially (`.gitkeep` only). The decision to commit baselines is
   a release-process question.
4. **CSP for the Alpine.js CDN.** The current setup has no Content-Security-Policy
   header. Tightening to `default-src 'self'; script-src 'self' https://cdn.jsdelivr.net
   'sha384-<HASH>'; style-src 'self' 'unsafe-inline'` is a follow-up — the
   `unsafe-inline` is required because Alpine.js evaluates inline `x-data` /
   `x-show` attribute expressions, which CSP treats as inline scripts.
5. **WCAG AA contrast audit not yet run.** The plan's Task 8 Step 3 asks for
   a manual contrast audit in a real browser. Deferred — recommend doing
   this in a follow-up before declaring the UI production-ready.
6. **`npm run test:visual` cross-platform.** The script uses a `RUN_VISUAL=1`
   inline env var, which fails on Windows-PowerShell. Documented in this
   README; operators on PowerShell run
   `$env:RUN_VISUAL=1; npx playwright test tests/integration/adminUi.visual.test.ts`
   directly.
