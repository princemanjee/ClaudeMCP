# Plan 01 — Foundation: what shipped

> **Note on design vs built.** Plan 01 was executed against the spec at
> `docs/superpowers/plans/2026-05-16-plan-01-foundation.md`, but the execution
> went through several review-and-fix cycles. Every module in this README ships
> with hardening fixes on top of its base implementation, and there are small
> deviations from the spec (e.g. the `NormalizedRole` type was tightened, the
> router emits a `cli-sentinel` reason distinct from `default-backend`, the
> backend registry uses a conditional spread for the optional `instance` field,
> etc.). Treat the plan file as the **as-designed** spec and this README plus
> the actual source as the **as-built** record. When the two disagree, the code
> wins.

Plan 01 left the project with the following working pieces:

## Modules

| Path | What it does | What it does NOT do yet |
|---|---|---|
| `src/backends/types.ts` | Defines `Backend`, capabilities, normalized request/event/embedding types | No implementations |
| `src/config.ts` | Zod-validated multi-backend config loader, env-var overrides, deep freeze | Does not wire the config into a running server (no `server.ts` yet) |
| `src/auth.ts` | `checkAuth()` accepting x-api-key, Bearer, x-goog-api-key, ?key= | Not wired into any HTTP route |
| `src/archive.ts` | Opens SQLite at the configured path, runs idempotent schema migration | No write/read methods — Plan 05 adds those |
| `src/modelRouter.ts` | `identifyBackend()` for prefix/alias/sentinel resolution | Does NOT pick a specific model id or resolve registry lookups |
| `src/backends/registry.ts` | `BackendRegistry` skeleton — register, probe, periodic probe, priority-based collision resolution | No backends registered yet |

## Tests

All under `tests/`:
- `unit/backends/types.test.ts` — 6 tests
- `unit/config.test.ts` — 7 tests
- `unit/auth.test.ts` — 13 tests
- `unit/archive.test.ts` — 6 tests
- `unit/modelRouter.test.ts` — 12 tests
- `unit/backends/registry.test.ts` — 9 tests
- `integration/foundation.test.ts` — 1 test
- **Total: 54 tests**

Run all: `npm test`

## What does NOT exist yet

- `src/server.ts` (no Express bootstrap)
- Any `src/backends/<id>Backend.ts` implementation
- Any shim (`src/anthropicShim/`, `src/openaiShim/`, `src/geminiShim/`)
- Any HTTP route handlers
- The existing `dist/` directory from the original ClaudeMCP iteration is untouched and not consumed by the new code — Plan 02 will refactor `claudeRunner.ts` / `claudeStreamRunner.ts` behind the `Backend` interface.

## What the next plan (Plan 02 — Claude backend refactor) needs

- Move `dist/claudeRunner.js` and `dist/claudeStreamRunner.js` source equivalents into `src/runners/`
- Implement `src/backends/claudeBackend.ts` against the `Backend` interface from `src/backends/types.ts`
- Register the Claude backend into `BackendRegistry` at server startup
- No HTTP behavior change yet — Plan 03 adds `/v1/messages`
