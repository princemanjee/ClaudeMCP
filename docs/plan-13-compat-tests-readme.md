# Plan 13 — Compat Tests: what shipped

Plan 13 added the cross-SDK × cross-backend compatibility matrix: real first-party SDKs (`@anthropic-ai/sdk`, `openai`, `@google/generative-ai`) pointed at the ClaudeMCP server with mock backends, exercising each SDK's documented API surface. The SDKs' own parsers fail loud on any envelope drift, so this suite is the highest-signal "1:1 replacement" check in the test pyramid.

## Modules added

| Path | Purpose | Lines (approx.) |
|---|---|---|
| `tests/compat/setup.ts` | Helper: `buildCompatServer({enabledBackends})` boots a configured ClaudeMCP server on port 0 with the chosen backends registered against their mock fixtures. Returns `{baseURL, apiKey, registry, teardown}`. | ~300 |
| `tests/compat/anthropic-sdk.test.ts` | Real `@anthropic-ai/sdk` × 4 backends. messages.create (stream + non-stream + raw events), countTokens, Anthropic-shape models list (via raw fetch — see deviations), beta.files.* lifecycle. | ~185 |
| `tests/compat/openai-sdk.test.ts` | Real `openai` × 4 backends for chat; × {lmstudio, ollama} only for embeddings. Skipped cells for embeddings × {claude, gemini} carry reason strings. Usage assertions made conditional — see deviations. | ~145 |
| `tests/compat/google-generative-ai-sdk.test.ts` | Real `@google/generative-ai` × 4 backends. generateContent + generateContentStream active. countTokens + files.* skipped per cell with documented reasons — see deviations. | ~135 |

No `src/` changes — Plan 13 is entirely additive in `tests/`.

## Pinned SDK versions

| Package | Version | Notes |
|---|---|---|
| `@anthropic-ai/sdk` | `^0.96.0` | Default ESM import: `import Anthropic, {toFile} from "@anthropic-ai/sdk"`. Files API lives at `client.beta.files.*` (not the top-level `files` namespace shown in older plan drafts). |
| `openai` | `^6.38.0` | Default ESM import: `import OpenAI from "openai"`. `ChatCompletionChunk` type imported explicitly from `"openai/resources/chat/completions"` because the `OpenAI.Chat.Completions` namespace export was reorganized in 5.x → 6.x. |
| `@google/generative-ai` | `^0.24.1` | Used despite Google's migration to `@google/genai@2.x`. See "Package choice" below. |

### Package choice: `@google/generative-ai` vs `@google/genai`

Google has published `@google/genai` as a successor; `@google/generative-ai` had its last release in 2025-04 and shows no activity since. Plan 13 nonetheless pins the legacy package because:

1. **The Gemini shim was built against the legacy package's API.** Request/response envelopes, model-path quoting, `usageMetadata`, the `generateContent` body shape — all of these match `@google/generative-ai`'s expectations. The new `@google/genai` SDK has a structurally different API surface (different namespace organization, different request/response types, different file management) that the shim does not implement.
2. **The legacy package is still on npm and not deprecated.** No `deprecated` marker was set on the 0.24.1 release; npm install resolves cleanly without warnings.
3. **Coverage is what matters here.** Switching to `@google/genai` would require either rewriting `src/geminiShim/` (out of scope for Plan 13) or rewriting the test against a SDK whose envelope the shim doesn't speak. The legacy package preserves end-to-end SDK round-trips against the existing shim.

If `src/geminiShim/` is later modernized to match `@google/genai`'s envelope, this package pin and the import in `google-generative-ai-sdk.test.ts` should flip together.

## Coverage matrix

|              | Anthropic SDK | OpenAI SDK (chat) | OpenAI SDK (embed) | Google GenAI SDK (gen) | Google GenAI SDK (count) | Google GenAI SDK (files) |
|--------------|:-------------:|:-----------------:|:------------------:|:----------------------:|:------------------------:|:------------------------:|
| **Claude**   | ✓             | ✓                 | skip (no embed)    | ✓                      | skip (envelope mismatch) | skip (no /upload route)  |
| **Gemini**   | ✓             | ✓                 | skip (deferred)    | ✓                      | skip (envelope mismatch) | skip (no /upload route)  |
| **LM Studio**| ✓             | ✓                 | ✓                  | ✓                      | skip (envelope mismatch) | skip (no /upload route)  |
| **Ollama**   | ✓             | ✓                 | ✓                  | ✓                      | skip (envelope mismatch) | skip (no /upload route)  |

42 active cells (test runs) + 10 skipped (documented). Each cell instantiates a single-backend test server (`enabledBackends: [backend]`) so a regression in one backend doesn't smear into others.

## Test infrastructure

Each `describe.each` block spins up its own server in `beforeAll` and tears it down in `afterAll`. Mock fixtures (mock-claude, mock-gemini, mock-lmstudio, mock-ollama) are the same ones used by their respective per-backend unit/integration tests — no new fixtures introduced. Port-0 binding keeps parallel Vitest workers from colliding.

The setup helper:
- Constructs the full `Config` literal directly (not via `loadConfig` — sidesteps the requirement for a JSON file on disk).
- Builds `Archive`, `FileStore`, `ResponseCache`, `ConfigSnapshotStore` for the chosen subset.
- Registers exactly the requested backends (default = all four).
- Calls `registry.probe()` synchronously so the model map is populated before any HTTP request hits.
- Does NOT start the periodic re-probe — a slow CLI subprocess re-probe could overwrite the model map mid-test.
- Binds to `127.0.0.1:0` and reports the kernel-assigned port.

## Runtime (measured at write time, 2026-05-17)

- Full compat suite (`npm run test:compat`): **~1.0s** test execution, ~1.7s wall.
- Full `npm test` (including prior plans): **~3.6s** test execution, ~4.3s wall.
- `npm run test:nocompat`: **~3.2s** wall (matches pre-Plan-13 baseline exactly: 753 + 2 skipped).
- Per-SDK file: ~0.4-0.5s each, all parallelized by Vitest's default worker pool.

The compat suite is fast because: every mock is in-process (mock-lmstudio) or a quickly-spawned subprocess (mock-ollama, mock-claude, mock-gemini exit immediately after one response), each cell only enables one backend, and the SDK round-trips are lightweight.

## Skip semantics

`it.skip` with a literal reason string carries forward in the Vitest reporter, so a future contributor can see at a glance why a cell isn't exercised:

- `embeddings × claude`, `embeddings × gemini` — these backends have no embeddings endpoint per spec Phase 10 routing rules.
- `countTokens × all backends (Google SDK)` — the SDK always wraps the request as `{generateContentRequest: {contents: [...]}}`; the Gemini shim's `/v1beta/models/:model[:]countTokens` handler accepts only the bare `{contents: [...]}` shape and rejects the wrapped form with `400: contents is required`. The shim could be extended to recognize both shapes; deferred to a future plan.
- `files.* × all backends (Google SDK)` — the SDK's `GoogleAIFileManager.uploadFile` uses Google's resumable upload protocol (POST `/upload/v1beta/files`, two-step init+upload). The Gemini shim implements only the simpler `/v1beta/files` surface used by direct curl uploads; it does not mount `/upload/v1beta/files`. List/get/delete on `/v1beta/files` DO work; they're covered by `tests/integration/crossShimFiles.test.ts` at the HTTP level.

## Plan-13 scope boundary (what does NOT ship here)

- **No real-API verification.** Manual smoke test in `docs/smoke-test.md` (a future doc) covers a real Claude Max / real Gemini CLI / real LM Studio / real Ollama installation. The compat suite uses mocks exclusively.
- **No load testing.** Future plan if a use case appears.
- **No mock-fidelity tests.** Verifying the mocks perfectly mimic the real APIs is ongoing; each backend plan owns its own mock and updates it when the upstream API moves.
- **No exhaustive option coverage per SDK call.** This is wire-shape parity, not behavior exhaustion.
- **No streaming back-pressure / cancellation tests.** Per-shim unit tests cover those.
- **No tool-use round-trip across the full matrix.** The Anthropic shim's tool-use round-trip is exercised by Plan 04's tests; Plan 13 doesn't re-verify it across every (SDK × backend).
- **No OpenAI Responses API (`responses.create`).** The OpenAI shim only implements `chat.completions` and `embeddings` per Plan 10.
- **No Anthropic message batches or citations.** Both surface 501 per the spec's error policy.
- **No admin endpoints exercised through the SDKs.** Admin routes are non-SDK; covered by Plan 11's integration tests.

## How to add a fifth backend (or a fourth SDK)

To add a new backend:

1. Add it to the `CompatBackendId` union and the `COMPAT_MODELS` constant in `tests/compat/setup.ts`.
2. Add a fixture-spawn branch in `buildCompatServer()` for the new `enabled.has("<new>")` block.
3. Add it to the `BACKENDS` constant in each SDK file. The `describe.each` block picks it up automatically.
4. If the new backend doesn't support embeddings, add it to the embedding-skip list in `openai-sdk.test.ts`.

To add a new SDK (e.g., `cohere-ai`):

1. Add the SDK to `devDependencies` in `package.json`.
2. Create `tests/compat/<sdk>-sdk.test.ts` following the pattern of the existing files.
3. Decide which backends the SDK is meaningful against and parameterize accordingly.
4. Update this README's coverage matrix.

## Deviations from the as-designed plan that landed during execution

The plan was written before the exact SDK versions and shim implementations existed. The following deviations were necessary:

1. **`@google/generative-ai` instead of `@google/genai`.** The plan anticipated the rename: "If `@google/generative-ai` is fully deprecated and replaced with a successor (e.g., `@google/genai`), document the migration and use the successor's API. Don't ship without a Google SDK round-trip." Per the rationale in "Package choice" above, the legacy package is the correct choice here because the shim's wire envelope matches it. The successor would require shim modifications out of Plan 13's scope.

2. **Anthropic SDK `beta.files.*` instead of top-level `files.*`.** In SDK 0.96.0 the files API moved to the `beta` namespace. The plan's example code (`client.files.upload(...)`, `client.files.list(...)`, etc.) was written against an earlier API surface. Updated to use `client.beta.files.upload(...)` etc.; `toFile` is still a top-level export.

3. **Anthropic SDK `models.list()` exercised via raw fetch.** The plan called `client.models.list({limit: 20})` against the Anthropic-shape models endpoint. The server's canonical `/v1/models` returns OpenAI shape (see `src/server.ts` header — the SDK-dominant target). The Anthropic-shape lives at `/v1/anthropic/models`, but the Anthropic SDK has no per-call baseURL override that cleanly rewrites just one resource's path while leaving messages/files routes alone. Test exercises the Anthropic-shape surface via raw `fetch` instead of through the SDK, asserting the same shape. The SDK's models.list against `/v1/models` would return OpenAI shape and fail the SDK's own type assertions; that path is already covered by the OpenAI SDK tests.

4. **OpenAI SDK `usage` assertions made conditional.** The plan asserted `completion.usage` defined and shape-checked on every chat-completion response; same for `embeddings.create`. The OpenAI shim populates `usage` only when the backend emits token counts in its `message_stop` event. mock-claude doesn't emit token counts, so the shim omits `usage` (which the SDK's own type marks optional). For embeddings, the shim never emits `usage` (the implementation predates Plan 13 and the `OpenAIEmbeddingsResponse` type marks the field optional). Tests now skip the assertion when `usage` is undefined and still shape-check it when present. The SDK's own parser does NOT throw on a missing `usage` field — so the "wire-shape drift detector" goal is preserved.

5. **Google SDK `countTokens` skipped across all backends.** The SDK always wraps the request as `{generateContentRequest: {contents}}`; the Gemini shim accepts only the bare `{contents}` shape. Plan 13 surfaces this as exactly the kind of drift it's designed to catch. Documented as a follow-up rather than a fix because the directive is "Do NOT modify any source under `src/`."

6. **Google SDK `files.*` lifecycle skipped across all backends.** The SDK uploads via `/upload/v1beta/files` (Google's resumable upload pattern); the shim mounts only `/v1beta/files`. Same disposition as #5.

7. **`FileStore` `sweepIntervalMs: 0` in setup helper.** Test cells are short-lived; a background sweep timer would outlive teardown and leak into the next test if Vitest's worker isolation didn't catch it. Setting `sweepIntervalMs: 0` is supported by `FileStoreOptions` and disables the timer cleanly.

8. **Periodic probe disabled in compat setup.** The setup calls `registry.probe()` synchronously once but does not call `startPeriodicProbe()`. A periodic re-probe could overwrite the model map mid-test if a mock-CLI subprocess responded slowly to a re-probe. Teardown still calls `registry.stop()` defensively.

9. **5/5 clean iterations on the flake-proofing loop (Task 7).** No flakes observed in five consecutive runs of `npm run test:compat`. No fixes applied; no resilience commit.

## Coverage and follow-ups (suggested future work)

- **Google countTokens envelope.** Extend `src/geminiShim/countTokens.ts` to accept `{generateContentRequest: {contents}}` in addition to bare `{contents}`. Will enable 4 currently-skipped cells.
- **Google resumable upload.** Implement `/upload/v1beta/files` in the Gemini shim with the two-step init+upload flow. Will enable 4 currently-skipped cells.
- **OpenAI `usage` parity.** Decide whether mock backends should emit token counts so the OpenAI shim always populates `usage`. Either change mocks (preferred — closer to real upstream behavior) or add synthesized fallback usage in the shim.
- **Anthropic SDK `models.list` via SDK.** Either expose `/anthropic/v1/models` as an alias for `/v1/anthropic/models` (so SDK with `baseURL = ${baseURL}/anthropic` works), or add a per-call baseURL override path to the SDK call. Neither is urgent — the same response shape is asserted via raw fetch.
- **OpenAI Responses API.** If consumers start using `client.responses.create`, add a 4th test cell. Currently 501 by design.

## File map at end of plan

```
tests/compat/
├── setup.ts                         (~300 lines)
├── anthropic-sdk.test.ts            (~185 lines)
├── openai-sdk.test.ts               (~145 lines)
└── google-generative-ai-sdk.test.ts (~135 lines)
```

Plus `package.json` (`devDependencies` + scripts), `README.md` (1 paragraph), and this document.
