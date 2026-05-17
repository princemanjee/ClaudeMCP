# Plan 03 — Anthropic Shim Core: what shipped

Plan 03 added the first HTTP surface on top of the Plan-01 foundation and the Plan-02 Claude backend. The server is now reachable on `http://127.0.0.1:3210` (or the `--port` value) and speaks Anthropic's Messages API end-to-end for text-only requests.

## Endpoints live

| Method | Path | Status |
|---|---|---|
| POST | `/v1/messages` | streaming + non-streaming, text-only |
| POST | `/v1/messages/count_tokens` | delegates to `backend.countTokens` |
| GET  | `/v1/models` | cross-backend list, Anthropic envelope |
| GET  | `/v1/models/{id}` | single-entry lookup |
| GET  | `/health` | liveness check |

All endpoints accept `x-api-key`, `Authorization: Bearer`, `x-goog-api-key`, or `?key=` (via the Plan-01 `checkAuth`).

## Modules added

| Path | Purpose |
|---|---|
| `src/server.ts` | Express bootstrap; `main()` and `buildApp()` |
| `src/bin.ts` | CLI entry (`--config <path> [--port <n>]`) |
| `src/anthropicShim/types.ts` | Anthropic Messages API shapes |
| `src/anthropicShim/errors.ts` | Error envelope helpers + `ShimRequestError` |
| `src/anthropicShim/requestTranslator.ts` | Anthropic body → `NormalizedRequest` |
| `src/anthropicShim/responseTranslator.ts` | `NormalizedEvent` → Anthropic SSE / buffered body |
| `src/anthropicShim/messages.ts` | `POST /v1/messages` handler factory |
| `src/anthropicShim/countTokens.ts` | `POST /v1/messages/count_tokens` handler factory |
| `src/anthropicShim/models.ts` | `GET /v1/models` + `GET /v1/models/{id}` handlers |
| `src/tokenEstimator.ts` | Char/4 skeleton |

## Test infrastructure added

| Path | Purpose |
|---|---|
| `tests/unit/tokenEstimator.test.ts` | Char/4 estimator coverage |
| `tests/unit/anthropicShim/errors.test.ts` | Envelope shape parity |
| `tests/unit/anthropicShim/requestTranslator.test.ts` | All request shapes + scope rejections |
| `tests/unit/anthropicShim/responseTranslator.test.ts` | SSE sequence + buffered aggregation |
| `tests/unit/anthropicShim/messages.test.ts` | Handler behavior in isolation |
| `tests/unit/anthropicShim/countTokens.test.ts` | Token counting endpoint |
| `tests/unit/anthropicShim/models.test.ts` | Models listing + get |
| `tests/integration/messages.test.ts` | Full HTTP stack against mock-claude |

Run all: `npm test`.

## Plan-03 scope boundary (what does NOT ship here)

The request translator rejects any of these with a 400 `invalid_request_error`:

- `image` and `document` content blocks (lands in Plan 04)
- `tool_use` and `tool_result` content blocks in the request (Plan 04)
- Non-empty `tools` array (Plan 04)
- `tool_choice` field (Plan 04)
- Non-empty `stop_sequences` (Plan 04)
- `thinking` field (Plan 04)
- `cache_control` on any block (Plan 05)

Server-internal deferrals:

- The `Archive` is opened on startup but never written to (Plan 05 wires the writers in).
- No response cache (Plan 05).
- No Files API (Plan 05).
- No admin endpoints (Plan 11).
- Other shims — the OpenAI surface stays on the legacy `dist/` server for now; Gemini shim lands in Plan 06.

## What the next plan (Plan 04 — Native tool_use + multimodal) needs

- Extend `ClaudeBackend.invoke()` to forward `tools`, `tool_choice`, image/document blocks, and `stop_sequences` to the CLI.
- Extend the request translator to accept image/document/tool_use/tool_result blocks instead of rejecting them.
- Extend the response translator to emit `content_block_start/delta/stop` for `tool_use` blocks (with `input_json_delta` deltas).
- Add a `stop_sequence` server-side cut in the Claude runner (rolling-tail buffer + `tree-kill`).
- Add tests for each new content-block shape across both streaming and non-streaming paths.

## Operational notes

- Default port is 3210.
- `CLAUDE_MCP_API_KEY` env var overrides the config's `apiKey` (per Plan 01's `loadConfig`).
- The mock-claude fixture from Plan 02 is the only test backend; Plan 04 can keep using it once it learns to emit tool_use blocks.
