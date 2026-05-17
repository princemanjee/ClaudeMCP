# Deferred-Item Fix Sprint Summary

This document summarizes the six deferred items surfaced by the executors of
Plans 05, 07, 10, and 13, and the fixes applied. Each issue was committed
separately with TDD discipline (failing test first, then fix, then re-run).

## Baseline

- Before: 847 passing, 12 skipped (full suite); 8 skipped in Google SDK
  compat, 2 skipped in OpenAI SDK compat.
- After: 862 passing, 4 skipped (full suite); 0 skipped in Google SDK compat,
  2 still skipped in OpenAI SDK compat (out of scope).
- `npx tsc --noEmit` clean throughout.

## Issue 1 — `config.archive.compressionLevel` was a no-op

**Files:** `src/archive.ts`, `src/server.ts`, `tests/unit/archive.test.ts`.

**Fix:** Threaded an `ArchiveOptions.compressionLevel` argument through the
`Archive` constructor into `zstdCompressSync` via
`{params: {[zlib.constants.ZSTD_c_compressionLevel]: level}}`. Bootstrap in
`src/server.ts` passes `config.archive.compressionLevel`.

**Test:** New unit test in `tests/unit/archive.test.ts` writes the same large,
varied payload to two archives configured at level 1 and level 22 respectively
and asserts that the level-22 blob is strictly smaller than the level-1 blob.

## Issue 2 — Archive writes missing from OpenAI shim handlers

**Files:** `src/admin/recordCompletion.ts` (new), `src/openaiShim/chatCompletions.ts`,
`src/openaiShim/embeddings.ts`, `src/server.ts`,
`tests/integration/openaiShim/{chatCompletions,embeddings}.test.ts`.

**Fix:** Extracted a shared `recordCompletion` helper that fire-and-forgets
an archive write (synthesizing a stable SHA-256 request hash from the request
body + backend + model). Both handlers now invoke it on success and on error,
in streaming and buffered paths. The streaming `chatCompletions` handler tees
the normalized event iterator so the archived response body is the
fully-aggregated final response (matching the buffered shape).

**Test:** One integration assertion added to each suite — after a successful
call, the archive contains an entry tagged with the right endpoint
(`/v1/chat/completions`, `/v1/embeddings`) and backend.

## Issue 3 — Archive writes missing from Gemini shim handlers

**Files:** `src/geminiShim/generateContent.ts`, `src/geminiShim/countTokens.ts`,
`src/server.ts`, `tests/integration/generateContent.test.ts`.

**Fix:** Same `recordCompletion` helper wired into both Gemini handlers. The
streaming `generateContent` path uses the same tee pattern as the OpenAI
shim so the archived body is the aggregated final response. Endpoint strings
include the action suffix (`...gemini-pro:generateContent`,
`...gemini-pro:streamGenerateContent`, `...gemini-pro:countTokens`) so
observability can distinguish them by row.

**Test:** Single integration assertion that one `:generateContent` and one
`:countTokens` call each produce an archive entry with the correct endpoint +
backend tagging.

## Issue 4 — Google SDK `countTokens` envelope mismatch

**Files:** `src/geminiShim/countTokens.ts`,
`tests/unit/geminiShim/countTokens.test.ts`,
`tests/compat/google-generative-ai-sdk.test.ts`.

**Fix:** The Google `@google/generative-ai` SDK serializes
`model.countTokens(...)` as `{generateContentRequest: {contents: [...]}}`,
not the bare `{contents: [...]}` the shim previously required. The handler now
unwraps one envelope level when `body.generateContentRequest` is present and
`body.contents` is absent. The bare shape still works unchanged.

**Test:** Two new unit tests cover both shapes. The 4 previously-skipped
Google SDK compat cells (one per backend) are now active and passing.

## Issue 5 — Google SDK files `/upload/v1beta/files` route absence

**Files:** `src/server.ts`, `src/geminiShim/files.ts`,
`tests/compat/google-generative-ai-sdk.test.ts`.

**Fix:** The Google SDK's `GoogleAIFileManager.uploadFile` posts a one-shot
`multipart/related` envelope to `/upload/v1beta/files`. The shim now mounts
the SDK URL as an alias against the same upload handler. The handler's
`readMultipart` was extended to dispatch between `multipart/form-data` (the
existing Busboy path, unchanged for curl callers) and `multipart/related` (a
new in-memory parser that extracts the JSON `{file: {mimeType, displayName}}`
metadata part and the raw bytes part).

**Test:** The 4 previously-skipped Google SDK files-upload compat cells are
now active. They drive a real SDK upload through the shim, assert the
returned file resource shape, and clean up after themselves.

**Scope note:** The full Google resumable-upload handshake (separate init
URL → upload URL two-step) was NOT implemented — the SDK only uses the
single-POST shape in practice, so the simpler one-shot implementation
suffices for SDK compatibility. If a future client requires the two-step
protocol, the resumable handshake would need to be added.

## Issue 6 — OpenAI `usage` shape on embeddings

**Files:** `src/openaiShim/embeddings.ts`,
`tests/integration/openaiShim/embeddings.test.ts`.

**Fix:** Real OpenAI service always populates `{prompt_tokens, total_tokens}`
on embeddings responses; some SDK versions are tightening this from
optional to required. The handler now computes a char/4 estimate via the
existing `tokenEstimator.estimateTokens` helper (summed across each input
string) and populates `usage` on every successful response. Embeddings have
no completion tokens, so `total_tokens === prompt_tokens`.

**Test:** One integration assertion that the response contains
`usage.prompt_tokens` as a number > 0 and that `total_tokens` matches.

## Remaining work / not in scope

- The 2 still-skipped OpenAI SDK compat cells are pre-existing skips
  unrelated to this sprint.
- Google resumable-upload two-step protocol is intentionally unimplemented
  (see Issue 5 scope note).
- Token estimates for embeddings use the existing char/4 approximation;
  Plan 05's planned `@anthropic-ai/tokenizer` swap would refine this.

## Commits

```
fix(archive): wire config.archive.compressionLevel through to zstd
fix(openaiShim): archive every chat completion and embedding request
fix(geminiShim): archive every generateContent and countTokens request
fix(geminiShim): accept Google SDK's countTokens envelope wrapper
fix(geminiShim): accept Google SDK's resumable /upload/v1beta/files route
fix(openaiShim): populate usage field on embeddings responses
docs: summarize deferred-item fix sprint
```
