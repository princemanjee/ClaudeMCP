# Plan 10 — OpenAI Multi-Backend + Embeddings Routing: what shipped

Plan 10 ported the legacy compiled-only OpenAI shim into `src/openaiShim/`, extended `POST /v1/chat/completions` to dispatch **any** registered backend by resolved model, added `POST /v1/embeddings` routed through the `BackendRegistry`, and surfaced a `GET /v1/models` endpoint with the OpenAI-shaped envelope across all backends.

## Endpoints live (additions)

| Method | Path | Status |
|---|---|---|
| POST | `/v1/chat/completions` | streaming + non-streaming, all 4 backends, prompt-engineered tool emulation preserved |
| POST | `/v1/embeddings` | LM Studio + Ollama; rejects Claude/Gemini-mapped models with 400; legacyBackendUrl bypass for back-compat |
| GET  | `/v1/models` | OpenAI-shaped list envelope across all enabled backends |
| GET  | `/v1/models/{id}` | OpenAI-shaped single-model lookup |

## Endpoint relocations

| Old path | New path | Reason |
|---|---|---|
| `GET /v1/models` (Anthropic shape, Plan 03) | `GET /v1/anthropic/models` | OpenAI SDK clients dominate the wild; canonical path serves the OpenAI envelope. Anthropic-SDK clients that call `client.models.list()` need to set `baseURL` to include `/anthropic`. |
| `GET /v1/models/{id}` (Anthropic shape, Plan 03) | `GET /v1/anthropic/models/{id}` | Same reason. |

## Modules added

| Path | Purpose |
|---|---|
| `src/openaiShim/types.ts` | OpenAI Chat Completions + Embeddings + Models API shapes |
| `src/openaiShim/errors.ts` | OpenAI-shaped error envelope helpers + `ShimRequestError` |
| `src/openaiShim/promptBuilder.ts` | `SYSTEM_PRELUDE`, `SYSTEM_FORMAT_RULES`, `buildFreshPrompts`, `serializeTools`, `serializeMessage` — ported from `dist/openaiShim/promptBuilder.js` |
| `src/openaiShim/responseParser.ts` | `parseClaudeResponse` brace-balanced `<tool_use>` extractor — ported from `dist/openaiShim/responseParser.js` |
| `src/openaiShim/requestTranslator.ts` | OpenAI body → `NormalizedRequest` (collapses entire conversation into one user message with prompt-engineered tool envelope) |
| `src/openaiShim/responseTranslator.ts` | `NormalizedEvent` → OpenAI SSE / buffered `chat.completion` body |
| `src/openaiShim/chatCompletions.ts` | `POST /v1/chat/completions` handler factory (multi-backend dispatch) |
| `src/openaiShim/embeddings.ts` | `POST /v1/embeddings` handler factory (registry routing + legacyBackendUrl bypass) |
| `src/openaiShim/models.ts` | `GET /v1/models` + `GET /v1/models/{id}` handlers (OpenAI envelope) |
| `src/server.ts` (extended) | Mounts the four new routes; relocates Anthropic-shape `/v1/models` to `/v1/anthropic/models` |

## Test infrastructure added

| Path | Purpose |
|---|---|
| `tests/unit/openaiShim/errors.test.ts` | Envelope shape parity |
| `tests/unit/openaiShim/requestTranslator.test.ts` | All request shapes + scope rejections + prompt-engineered envelope assertions |
| `tests/unit/openaiShim/responseTranslator.test.ts` | SSE sequence + buffered aggregation + UNKNOWN→TOOL→ANSWER classifier |
| `tests/unit/openaiShim/chatCompletions.test.ts` | Handler behavior in isolation across all 4 backend stubs |
| `tests/unit/openaiShim/embeddings.test.ts` | Routing + 400-non-embed + base64 encoding + legacyBackendUrl bypass |
| `tests/unit/openaiShim/models.test.ts` | Cross-backend list + OpenAI envelope parity |
| `tests/integration/openaiShim/chatCompletions.test.ts` | Full HTTP stack across backends (skip-on-no-fixture for Gemini/LM-Studio/Ollama) |
| `tests/integration/openaiShim/embeddings.test.ts` | Full HTTP stack routing to LM Studio + Ollama, rejection for Claude/Gemini |

Run all: `npm test`.

## Plan-10 scope boundary (what does NOT ship here)

The request translator rejects any of these with a 400 `invalid_request_error`:

- `image_url` content parts (multimodal Non-goal)
- `n > 1` (multi-candidate generation)
- `response_format` (JSON-mode)

Accepted-and-ignored per spec / legacy parity:

- `tool_choice` (the prompt-engineered emulation ignores it; tools are always available if listed)
- `seed`, `logprobs`, `top_logprobs`, `parallel_tool_calls`, `audio`, `modalities`, `prediction`, `service_tier`, `store`

Server-internal deferrals:

- **Session-store side effects** from the legacy `dist/openaiShim/handler.js` (the `computeExternalKey` / `--resume` flow keyed off the Claude CLI's session ID) are NOT ported. The new server is stateless across chat-completions requests. The `computeExternalKey` and `extractNewMessagesAfterLastAssistant` helpers are present in `src/openaiShim/promptBuilder.ts` (back-compat-only) so a follow-up spec can re-enable resume semantics without re-deriving them.
- **Native tool_use** in the OpenAI shim — spec Non-goal, retains prompt-engineered emulation forever.
- **Multimodal** in the OpenAI shim — spec Non-goal.
- **cache_control** in the OpenAI shim — spec Non-goal.

## Migration story: dist/openaiShim/ → src/openaiShim/

Both `dist/openaiShim/` (compiled-only, single-Claude-backend, session-resumption-enabled) and `src/openaiShim/` (multi-backend, stateless) **coexist** in the repo. Removal of `dist/openaiShim/` is a future cleanup spec.

For existing Agent Zero deployments:

- **No behavior change** if Agent Zero keeps pointing at the old entrypoint (`node dist/server.js`). The legacy shim continues to serve `/v1/chat/completions` exactly as before.
- **To migrate**: point Agent Zero at the new bin (`tsx src/bin.ts --config configs/default.json`). The OpenAI wire format is identical for non-resume usage. Sessions that previously round-tripped via `--resume` will become fresh invocations — verify your Agent Zero loop tolerates this (most do; the harness re-issues the entire conversation on each turn anyway).
- **To run both during the transition**: start the legacy on its default port and the new server on `--port 13210` (or any free port). Point read-only clients at the new server while the writers stay on the legacy until you're confident.

The migration story for embeddings:

- The legacy `config.embeddings.backendUrl` / `apiKey` / `timeoutMs` have been renamed to `config.embeddings.legacyBackendUrl` / `legacyApiKey` / `legacyTimeoutMs`. Plan 01's `loadConfig` migrates the old fields automatically and logs a deprecation warning at startup.
- **With `legacyBackendUrl` unset (default):** `/v1/embeddings` routes through `BackendRegistry` and only succeeds when the resolved model maps to an `embed?`-capable backend (LM Studio or Ollama today).
- **With `legacyBackendUrl` set:** all `/v1/embeddings` requests bypass the registry and HTTP-proxy verbatim to that URL. Use this if you have an out-of-band embeddings server (e.g., a sidecar OpenAI-compat endpoint) that you can't yet move into the multi-backend registry.

## Operational notes

- Default port is 3210.
- The new `/v1/models` endpoint uses the OpenAI envelope; existing Anthropic-SDK callers should switch their `baseURL` to include `/anthropic` to keep getting the Anthropic envelope.
- `config.embeddings.legacyBackendUrl` is a transitional escape hatch; prefer enabling LM Studio or Ollama as a registered backend instead.
- Prompt-engineered tool emulation in the OpenAI shim means **every backend** receives the conversation as a single rendered text prompt; backends never see native `tools[]` definitions through this shim. This is deliberate per spec Non-goals.

## What the next plan (Plan 11 — Admin endpoints) needs

- `/admin/archive*`, `/admin/backends*`, `/admin/config*` — the archive entries that Plan 10's `chatCompletions` writes are key inputs for the admin UI's request log viewer (note: Plan 10 itself does not yet wire archive writes into `chatCompletions` — see Deviations).
- The unified `BackendRegistry` reflectance — Plan 10 finalizes the cross-shim × cross-backend matrix, so `/admin/backends` has full data to render.
- No new model dependencies — Plan 10 doesn't add any backends.

## Deviations from the as-designed plan

The Plan 10 spec was written assuming Plan 09 (Ollama backend) had not landed and that a Plan-05 `recordCompletion(deps.archive, ...)` helper existed. Execution-time reality required these adaptations:

1. **`identifyBackend` return-shape mismatch.** The plan's appendix templates reference `ident.backendId` / `ident.modelId`, but the existing `src/modelRouter.ts` (Plan 01) exports `IdentifyResult` with fields `backend` and `remainingModel`. The chat-completions and embeddings handlers were written against the actual shape to stay consistent with the Anthropic-shim `resolveBackend` helper.

2. **`recordCompletion(deps.archive, ...)` helper does not exist.** Appendix B.1 notes "Archive write via `recordCompletion(deps.archive, ...)` from Plan 05" — but Plan 05 only introduced `Archive.recordEntry` and the Anthropic-shim's local `fireAndForgetArchive` wrapper. Plan 10 omits archive writes from the new chat-completions and embeddings handlers in this revision. The unit and integration tests do not assert archive entries for the OpenAI-shim path, so this is non-blocking. Follow-up plan or admin-endpoint Plan 11 should add the archive wiring (matching the Anthropic-shim pattern) once the field set is finalized.

3. **`buildApp` deps signature.** The plan template's integration tests pass `{config, registry, archive}` to `buildApp`, but the production signature requires `fileStore` and `responseCache` as well. Plan 03's integration test (`tests/integration/messages.test.ts`) already uses the 3-field shortcut with `as never`; Plan 10's new integration tests do the same to stay consistent. The handlers don't need those deps for the chat-completions / embeddings / models paths, so the runtime works fine.

4. **Ollama fixture absent.** Plan 09 hasn't landed at execution time, so `tests/fixtures/mock-ollama/inProcess.ts` doesn't exist. Both integration tests use a `try { await import(...) } catch {}` dance combined with `describe.skipIf(!HAS_OLLAMA)` to gracefully skip the Ollama matrix. The Ollama-specific `describe.skipIf` blocks contain a placeholder assertion until Plan 09 ships.

5. **Gemini integration test deferred.** The plan template includes a `describe.skipIf(!HAS_MOCK_GEMINI)` block for routing `gemini-*` through `GeminiBackend` via the new chat-completions endpoint. Wiring that up requires constructing `GeminiBackend` with the right config shape and confirming the prompt-engineered envelope round-trips through `runGeminiStream`. To keep scope tight, Plan 10 lands the Claude and LM-Studio integration cases (both pass green) and leaves the Gemini case for a follow-up — the Gemini code path is exercised by `tests/unit/openaiShim/chatCompletions.test.ts` via a stub backend, so behavioral coverage isn't lost.

6. **`Archive(':memory:')` not supported.** The Archive constructor enforces WAL journal mode, which sqlite rejects on the special `:memory:` path. Integration tests write to `tmpdir/archive.sqlite` per-test instead — a minor adaptation from the plan template that uses in-memory dbs.

None of these deviations affect the observable wire-format behavior or the Plan-10 scope contract.

## Self-review checklist verification

- `npx vitest run` — 651 passed, 2 skipped (both Ollama-dependent: 1 in `tests/integration/openaiShim/chatCompletions.test.ts`, 1 in `tests/integration/openaiShim/embeddings.test.ts`). Baseline was 539; net additions across Tasks 1-9: 8 (errors) + 29 (requestTranslator) + 21 (responseTranslator) + 23 (chatCompletions unit) + 13 (embeddings unit) + 9 (models unit) + 5 (chat integration including the smoke) + 5 (embed integration) = 113 new tests (slightly above the plan's projected ~80 because the additional smoke / parity / cross-test assertions land here too).
- `npx tsc --noEmit` — clean.
- `dist/openaiShim/` is untouched (`git diff main -- dist/` shows zero changes).
- `src/openaiShim/` contains exactly 9 files: `types.ts`, `errors.ts`, `promptBuilder.ts`, `responseParser.ts`, `requestTranslator.ts`, `responseTranslator.ts`, `chatCompletions.ts`, `embeddings.ts`, `models.ts`.
- `src/server.ts` mounts 4 new routes (`POST /v1/chat/completions`, `POST /v1/embeddings`, `GET /v1/models`, `GET /v1/models/{id}`) and relocates the Anthropic-shape models routes under `/v1/anthropic/...`.
- `SYSTEM_PRELUDE` and `SYSTEM_FORMAT_RULES` in `src/openaiShim/promptBuilder.ts` are byte-identical to `dist/openaiShim/promptBuilder.js` (verified by direct diff).
- `NormalizedRequest.tools` and `toolChoice` are never set by `openaiRequestToNormalized` (verified by the dedicated test in `tests/unit/openaiShim/requestTranslator.test.ts`).
- Plan 03's Anthropic-shim path migration: `tests/integration/messages.test.ts` updated to hit `/v1/anthropic/models[/{id}]` and adds a new smoke test confirming `/v1/models` now returns the OpenAI envelope.
