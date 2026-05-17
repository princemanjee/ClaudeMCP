# Plan 07 — Gemini Shim: what shipped

Plan 07 adds the Google Gemini-shaped HTTP surface on top of the Plans 01-06 baseline. After Plan 07, any client built on `@google/generative-ai` can reach the server, AND the cross-shim × cross-backend dispatch is closed in both directions.

## Endpoints live

| Method | Path | Status |
|---|---|---|
| POST | `/v1beta/models/{model}:generateContent` | Non-streaming generation across all enabled backends |
| POST | `/v1beta/models/{model}:streamGenerateContent` | Streaming generation (Gemini SSE `data: <JSON>\n\n` chunks) |
| POST | `/v1beta/models/{model}:countTokens` | Token counting |
| GET  | `/v1beta/models` | Cross-backend model list (Gemini-shaped envelope) |
| GET  | `/v1beta/models/{id}` | Single-entry model lookup |
| POST | `/v1beta/files` | Multipart upload, shares storage with `/v1/files` |
| GET  | `/v1beta/files` | Paginated list |
| GET  | `/v1beta/files/{id}` | Metadata; `uri` points at `:download` |
| GET  | `/v1beta/files/{id}:download` | Stream bytes |
| DELETE | `/v1beta/files/{id}` | Delete |

Both `model: "gemini-pro"` and `model: "models/gemini-pro"` are accepted (the prefix is stripped). Both `files/<24hex>` and `file_<24hex>` IDs are accepted everywhere a file is referenced.

## Modules added

| Path | Purpose |
|---|---|
| `src/geminiShim/types.ts` | Gemini API request/response/file shapes (subset honored by Plan 07) |
| `src/geminiShim/errors.ts` | Gemini envelope helpers + `ShimRequestError` |
| `src/geminiShim/modelPath.ts` | `stripModelsPrefix`, `parseModelMethodPath` |
| `src/geminiShim/requestTranslator.ts` | Gemini body → `NormalizedRequest` (async — touches FileStore) |
| `src/geminiShim/responseTranslator.ts` | `NormalizedEvent` → Gemini SSE / buffered body |
| `src/geminiShim/generateContent.ts` | `:generateContent` + `:streamGenerateContent` handler factory |
| `src/geminiShim/countTokens.ts` | `:countTokens` handler factory |
| `src/geminiShim/files.ts` | All 5 `/v1beta/files/*` handlers |
| `src/geminiShim/models.ts` | `/v1beta/models` list + get handlers |
| `src/fileStore.ts` (extended) | `resolveById`, `normalizeFileId`, `toGeminiFileId` |
| `src/backends/geminiBackend.ts` (extended) | `toolUse: true`, functionCall event translation, prompt-fold extension for multimodal/tool blocks |
| `src/server.ts` (extended) | Mounts all 10 new routes; registers `GeminiBackend` in `buildRegistry` |

## Cross-shim × cross-backend dispatch — fully closed

| Client SDK | Sends model | Resolves to backend | Response shape |
|---|---|---|---|
| `@anthropic-ai/sdk` | `claude-opus-4-7` | Claude (CLI) | Anthropic SSE |
| `@anthropic-ai/sdk` | `gemini-pro` | Gemini (CLI) | Anthropic SSE |
| `@google/generative-ai` | `gemini-pro` | Gemini (CLI) | Gemini SSE |
| `@google/generative-ai` | `claude-opus-4-7` | Claude (CLI) | Gemini SSE |

The four-cell matrix is exercised by the Plan 07 integration tests.

## Plan-07 scope boundary (deferrals)

The request translator returns 400 `INVALID_ARGUMENT` on these:

- `tools[].googleSearchRetrieval` (Gemini grounding)
- `tools[].codeExecution`
- `generationConfig.responseSchema` / `responseMimeType: "application/json"` (JSON mode)
- `generationConfig.candidateCount > 1`
- `cachedContent` (Gemini context caching)

Server-internal deferrals:

- `tools[]` ARE forwarded to the Gemini backend, but `geminiStreamRunner` does NOT yet pass them as `--tools` to the CLI. The mock fixture demonstrates the full event pipeline regardless.
- Archive writes from the Gemini shim. The Plan-05 archive writer is mounted on the Anthropic shim only; Gemini-shim `:generateContent` calls do not yet land in the archive.
- LM Studio / Ollama backend dispatch (Plans 08/09). Routing path is correct; backends not yet registered.
- Batches API (`:batchGenerateContent`).
- Real-time streaming WebSocket.

## Operational notes

- Default port stays at 3210. Gemini routes mount alongside Anthropic routes.
- `x-goog-api-key` header and `?key=<key>` query are both accepted everywhere (Plan-01 `checkAuth` already supports them).
- The `files/<24hex>` / `file_<24hex>` cross-format aliasing is transparent to clients of either SDK.

---

## Deviations from the as-designed plan

The implementation broadly follows the plan as written; the following deviations are corrections to plan-stated facts that turned out not to match reality, plus environmental adaptations. None change the surface area or scope.

### 1. `multer` is not a project dependency — used `busboy` (already present)

The plan's Task 8 references the `multer` package (`import multer from "multer"`) for multipart upload parsing and includes a check item ("Multer dependency check ... Plan 05 added `multer`") in open questions. In practice, Plan 05 shipped with `busboy` (not `multer`) — `package.json` declares `"busboy": "^1.6.0"` only. The Gemini shim's `src/geminiShim/files.ts` mirrors the existing Anthropic shim's `readMultipart` Busboy helper rather than introducing a new dependency. Same wire behavior; same `Buffer`-in-memory result.

### 2. Express `path-to-regexp` colon-escape uses `[:]` bracket form, not `\\:`

The plan's Task 10 prescribes `app.post("/v1beta/models/:model\\:generateContent", handler)` — the `\\:` literal-colon escape. Under the version of `path-to-regexp` bundled with Express 4 in this repo (the legacy 0.1.x line), the `\\:` form parses but `:method` is captured AS a sibling param of `:model`, leaving `:download` / `:generateContent` exposed as another param name. The working idiom is the `[:]` bracket character-class form. Verified empirically by mounting both `:id\\:download` and `:id[:]download` and exercising them:

- `:id\\:download` → `params.id = "abc"`, `params.download = "bc123:download"` (broken)
- `:id[:]download` → `params.id = "abc123"` (correct)

`src/server.ts` uses `:model[:]${action}` and `:id[:]download` for the same reason. The plan's regex-route siblings for the `models/`-prefixed double-wrap form also use a literal `:` (no escape) in the regex source: `new RegExp(\`^/v1beta/models/(models/[^:]+):${action}$\`)`.

Additionally, route mount order matters: the `:id[:]download` route is mounted BEFORE the bare `:id` route, because path-to-regexp 0.1.x matches the bare route greedily — it will swallow the literal `:download` into the `:id` param if mounted first. Same trick is applied in `src/server.ts` and in the unit test's `buildApp`.

### 3. `GeminiBackend` was also gated on multimodal content (Plan 06 baseline) — Task 5 removed that throw too

Task 5's text addresses removing the `tools` and `stopSequences` scope throws, with multimodal/tool_result throws mentioned only obliquely ("image/document content blocks — actually now allowed; remove the throw"). The Plan-06 baseline `assertPlan06Scope` actually threw on FOUR things: `tools`, `stopSequences`, `thinking`, AND multimodal/tool_use/tool_result content blocks. Plan 07 removed the throws for all of them except `thinking` (which is still future-plan) and replaced the helper with `assertSupportedScope`. The Plan-06 multimodal-throw test (`invoke throws on multimodal content`) was deleted along with the two named tests and replaced with a `invoke accepts multimodal content blocks without throwing (Plan 07)` test.

### 4. `GeminiBackend.invoke` exact-optional-property TypeScript discipline

The plan's Task 5 streamOpts construction uses bare `req.system`, `req.samplingParams?.temperature`, etc. as object values. The repo's tsconfig has `exactOptionalPropertyTypes` (or close to it) enabled, so the field can't be assigned `undefined` directly. The implementation uses the spread-with-condition idiom (`...(x !== undefined ? { field: x } : {})`) that mirrors what Plan 06's original code did. No behavior change.

### 5. `requestTranslator.ts` — duplicate property access used record casts

Plan-03/Plan-06 baseline TypeScript settings include `noUncheckedIndexedAccess`. The plan's request translator body sometimes accesses `inline["mimeType"]` after type-narrowing the parent — the compiler needed explicit `(inline as Record<string, unknown>)["mimeType"]` casts a couple of places. Behaviorally identical.

### 6. `checkAuth(req, ...)` requires an `as unknown as AuthCarrier` cast in handlers

The plan's handlers call `checkAuth(req, deps.config.apiKey)`, but Express's `Request` does not structurally match the project's `AuthCarrier` shape (the `query: ParsedQs` type doesn't widen to `Record<string, string | string[] | undefined>`). The Anthropic shim handlers already use `as unknown as AuthCarrier` casts; the Gemini shim handlers do the same. Required for `tsc --noEmit` to pass.

### 7. Supertest body parser for binary `:download` route

Supertest's default response parser tries to JSON-decode any non-text response and the test was getting an `Object` back instead of bytes. The download test uses an explicit `.buffer(true).parse((response, callback) => ...)` to collect chunks into a `Buffer`. Documented inline in the test.

### 8. `unauthenticatedError`-returning helper exists but `notFoundError` envelope was used in `getMetadata` for missing-auth-on-bad-format edge

When a malformed id comes in on a route that requires auth, the handler returns 401 first (auth before parse) — this matches Anthropic shim semantics. The `notFoundError` envelope is only returned on `404 NOT_FOUND` paths where auth succeeded.

### 9. `tests/unit/geminiShim/files.test.ts` does not test the `_<hash>` Anthropic-format download path via supertest

The plan's Task 8 lists a cross-shim acceptance test asserting that `GET /v1beta/files/file_<hash>` returns the same file as `GET /v1beta/files/files/<hash>`. The unit test exercises only the bare-hash path and the `file_<hash>` GET path (the metadata route); the `files/<hash>` double-prefix form is exercised by the integration test in `crossShimFiles.test.ts` via direct fetch. Reason: the Express `:id` param matches only a single path segment, so neither `files/<hash>` nor `file_<hash>` (the latter has no slash but does have an underscore — that one works fine; `files/<hash>` would need a different route mount). The integration test demonstrates the end-to-end behavior anyway.

### 10. Mock-gemini `MOCK_FUNCTION_CALL(name|argsJson)` trigger

Added per Task 5 with one minor adjustment: the trigger only fires when `outputFormat === "stream"`, since `geminiBackend.invoke` always requests stream format (other formats aren't exercised by Plan 07's surface). The non-stream branch keeps the original echo behavior for backward compatibility with Plan 06's tests.

---

## Test count

After all 13 Plan 07 tasks: **491 tests passing** (355 baseline + 136 net new):

- 5 fileStore cross-format tests (Task 1)
- 5 errors tests + 13 modelPath tests (Task 2)
- 36 requestTranslator tests (Task 3)
- 19 responseTranslator tests (Task 4)
- 4 geminiBackend new tests, capabilities test flipped, 3 obsolete throwing tests removed (Task 5; net +1 over baseline)
- 17 generateContent handler tests (Task 6)
- 6 countTokens handler tests (Task 7)
- 14 files handler tests (Task 8)
- 9 models handler tests (Task 9)
- 7 integration generateContent tests (Task 11)
- 4 integration crossShimFiles tests (Task 12)

`npx tsc --noEmit` clean.

## Open questions surfaced during Plan 07

Same as the plan's stated open questions; left for follow-up:

1. Shared archive writer helper (extract `src/archive/recordCompletion.ts`).
2. End-to-end `tools[]` against the real Gemini CLI (extend `geminiStreamRunner.buildStreamArgs`).
3. Synthesized `call_<base64url>` IDs vs `toolu_*` canonicalization.
4. `fileData.mimeType` truthiness vs the stored file's mime.
5. Gemini SSE format pinning (line-delimited JSON arrays vs `data: <JSON>\n\n`).
6. `models/` double-wrap regex routes — drop if real-world clients never send this form.
7. Real `safetyRatings` surface (Plan 07 always emits `[]`).
8. Multer / Busboy library choice (now resolved: project uses Busboy).
