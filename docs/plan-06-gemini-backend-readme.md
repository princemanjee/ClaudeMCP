# Plan 06 — Gemini Backend: what shipped

Plan 06 added the second concrete `Backend` implementation on top of the Plan 01 foundation, mirroring the structure Plan 02 established for Claude. Both backends now coexist in the registry; no Gemini-shaped HTTP shim exists yet (Plan 07).

## Modules added

| Path | Purpose | Lines (approx.) |
|---|---|---|
| `src/runners/types.ts` (extended) | Added `GeminiRunOptions`, `GeminiRunResult`, `GeminiStreamOptions` alongside the existing Claude types | +50 |
| `src/runners/geminiRunner.ts` | One-shot CLI invoker (`gemini --prompt ... --output-format json`) | ~145 |
| `src/runners/geminiStreamRunner.ts` | Streaming CLI invoker (`--output-format stream`) with NDJSON parsing | ~125 |
| `src/backends/geminiBackend.ts` | `Backend` implementation: id, capabilitiesFor, listModels, countTokens, invoke | ~230 |

## Test infrastructure added

| Path | Purpose |
|---|---|
| `tests/fixtures/mock-gemini/index.mjs` | Hermetic mock CLI keyed off prompt substrings for deterministic behavior, emits Gemini-shaped `candidates[].content.parts[]` output |
| `tests/fixtures/mock-gemini/package.json` | Tiny shim so the fixture can run via `node tests/fixtures/mock-gemini/index.mjs` |
| `tests/unit/runners/types.test.ts` (extended) | +6 Gemini type construction tests |
| `tests/unit/runners/geminiRunner.test.ts` | buildArgs unit tests + spawn tests against mock-gemini (12 cases) |
| `tests/unit/runners/geminiStreamRunner.test.ts` | buildStreamArgs + stream iteration tests (10 cases) |
| `tests/unit/backends/geminiBackend.test.ts` | Capability matrix, listModels, countTokens, invoke (15 cases) |
| `tests/integration/geminiBackend.test.ts` | End-to-end through `BackendRegistry`, coexistence with Claude backend (3 cases) |

Run all: `npm test`.

## Capability matrix delta vs Claude

The most important divergence is the `samplingParams` row — the entire point of having a per-backend capability matrix.

| Capability | Claude | Gemini |
|---|---|---|
| toolUse | true (Plan 04) | **false (Plan 07)** |
| multimodal | true | true |
| thinking | true | **false (future plan)** |
| cacheControl | "none" | "none" |
| samplingParams.temperature | **false** | **true** |
| samplingParams.topP | **false** | **true** |
| samplingParams.topK | **false** | **true** |
| stopSequences | "server-side-cut" | **"native"** |
| embeddings | false | false (deferred; see open question) |

When the same `NormalizedRequest` is sent to both backends with `samplingParams: { temperature: 0.7 }`, Claude silently ignores it (capability matrix says it doesn't honor it) and Gemini forwards it as `--temperature 0.7` to the CLI.

## Plan-06 scope boundary (what does NOT ship here)

`GeminiBackend.invoke()` explicitly throws on any of the following — they land in **Plan 07 (Gemini shim)** unless otherwise noted:

- Image content blocks (`type: "image"`)
- Document content blocks (`type: "document"`)
- Tool-use content blocks (`type: "tool_use"`)
- Tool-result content blocks (`type: "tool_result"`)
- Non-empty `tools` array on the request
- Non-empty `stopSequences` array on the request (CLI supports stop seqs natively, but end-to-end wiring lives with the shim)
- Truthy `thinking` field

Server-internal deferrals:

- No `src/geminiShim/` or `/v1beta/models/*` endpoints — Plan 07.
- No cross-backend dispatch (Anthropic shim routing `gemini-pro` to Gemini backend) — Plan 07. The Plan-03 Anthropic shim already gates on `identifyBackend("gemini-...")` returning `"gemini"`; once Plan 07 registers `GeminiBackend` in `src/server.ts`'s startup, that gate lights up.
- No OpenAI-shim Gemini support — Plan 10.
- No grounding metadata / safety ratings translation — Plan 07.
- No Gemini embeddings — deferred; see open question below.

## What the next plan (Plan 07 — Gemini shim) needs

- A working `src/server.ts` that registers `GeminiBackend` alongside `ClaudeBackend` at startup.
- `src/geminiShim/` with:
  - `requestTranslator.ts` (`generateContentRequestToNormalized`)
  - `responseTranslator.ts` (normalized events → Gemini SSE / non-streaming response body)
  - `generateContent.ts` (handler for `POST /v1beta/models/{model}:generateContent` and `:streamGenerateContent`)
  - `countTokens.ts` (handler for `POST /v1beta/models/{model}:countTokens`)
  - `models.ts` (handler for `GET /v1beta/models`)
- Native tool_use wiring: capability matrix flips `toolUse: true` for Gemini, scope-boundary throws for `tools` / `tool_use` / `tool_result` are removed, and translation maps to/from Gemini's `functionDeclarations` and `functionCall` / `functionResponse` parts.
- Multimodal via the Files API (uploaded artifacts referenced by `file_<hash>`).
- Stop-sequence end-to-end (request → CLI `--stop` → backend honors natively → response).
- Grounding metadata + safety ratings translation (synthesized defaults when the originating backend isn't Gemini, per the spec's hybrid policy).

## Open questions surfaced during Plan 06

1. **Exact Gemini CLI flag names.** This plan assumes `--prompt`, `--output-format {json,stream}`, `--system`, `--model`, `--temperature`, `--top-p`, `--top-k`, `--stop`, `--resume`. The real `gemini` CLI's surface should be verified at implementation time and the runners + mock updated in lockstep if reality differs.
2. **Gemini conversation resume.** The Gemini CLI may or may not support `--resume <sessionId>`. The runner types include `resumeSessionId` for parity with Claude, but the backend's `invoke()` does not currently pass it through (would land in a Plan 06.5 or Plan 07 follow-up once the CLI's session model is confirmed).
3. **`text-embedding-004` support.** Gemini does expose embeddings, but the Gemini CLI may or may not have an embeddings subcommand. Plan 06's capability matrix sets `embeddings: false`; if the CLI exposes them, a follow-up can flip this and add an `embed()` implementation. Currently only LM Studio and Ollama support embeddings.
4. **Real tokenizer dependency.** Plan 06 ships char/4 fallback for `countTokens`. The `@google/generative-ai` package has a real tokenizer; Plan 05 or a later plan can swap it in.
5. **Stream output format name.** Plan 06 assumes `--output-format stream` with NDJSON `{candidates: [...]}` chunks. The real CLI might emit SSE-flavored output or use a different format name. The mock fixture and runner parse NDJSON; if reality differs, both need a coordinated update.

## Deviations from this plan that landed during execution

The plan was executed largely as written. The following minor deviations were observed and are documented here for the record:

### 1. Type-only test "should fail" step (Task 2) did not produce a vitest failure

The plan's Task 2 Step 2 expected `npx vitest run tests/unit/runners/types.test.ts` to FAIL because the new Gemini type symbols were not yet exported from `src/runners/types.js`. In practice, vitest's esbuild transform erases TypeScript type-only imports at runtime, so the file loaded and the tests passed even before the implementation existed. Only a `tsc --noEmit` run would have caught the missing symbols at the type level.

This is a property of how Vitest handles TypeScript type-only imports, not a bug in the plan. The implementation immediately followed (Step 3) and the tests now meaningfully exercise the types via the `as`-cast/structural-assignment patterns each test uses. Final count: 6 new Gemini type tests + 5 existing Claude type tests = 11, matching the plan.

### 2. Task 6 placeholder test replacement (matches Plan-02 deviation §3)

As foreshadowed by the plan itself (and execution Rule 9), Task 5's placeholder test `"invoke() throws — landed in Task 6"` was removed (not appended) when Task 6 landed the real `invoke()` implementation. This was done at the same time the 8 new invoke tests were added, so the test count went from 8 (Task 5) → 15 (Task 6) rather than 16. Plan's expected counts (7 surviving + 8 new = 15) match the actual result.

### 3. No real Gemini CLI verification performed

Per execution Rule 11 and the plan's own pre-flight note: the runners and mock-gemini fixture were implemented against the plan's documented assumptions for `gemini` CLI flag names (`--prompt`, `--output-format`, `--system`, `--temperature`, `--top-p`, `--top-k`, `--stop`, `--resume`, `--model`). No verification against a real `gemini` binary was attempted; that is a follow-up task if/when assumptions diverge from reality. The leading comment in `src/runners/geminiRunner.ts` records this disclaimer.

### 4. Test count reconciliation

Final test count: **236 total** (baseline 190 + 46 new), matching the plan's projection exactly:
- 6 new types tests
- 12 geminiRunner tests
- 10 geminiStreamRunner tests
- 15 geminiBackend unit tests
- 3 integration tests

