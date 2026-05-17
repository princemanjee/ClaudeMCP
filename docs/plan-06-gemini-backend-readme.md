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

(Filled in by the implementer / reviewer during the actual task cycles. Expected items typically include flag-name corrections discovered against the real CLI, additional defensive parsing for unexpected chunk shapes, or test-count reconciliation if a placeholder test needed replacement rather than appending.)
