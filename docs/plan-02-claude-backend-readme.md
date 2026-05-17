# Plan 02 — Claude Backend Refactor: what shipped

Plan 02 added the first concrete `Backend` implementation on top of the Plan 01 foundation. Nothing about the existing `dist/server.js` runtime changed; new `src/` code coexists with the legacy compiled output until Plan 03 introduces a new server entry point.

## Modules added

| Path | Purpose | Lines (approx.) |
|---|---|---|
| `src/runners/types.ts` | Shared option/result types for both Claude runners | ~45 |
| `src/runners/claudeRunner.ts` | One-shot CLI invoker (`claude -p --output-format json`) | ~90 |
| `src/runners/claudeStreamRunner.ts` | Streaming CLI invoker (`--output-format stream-json`) with NDJSON parsing | ~95 |
| `src/backends/claudeBackend.ts` | `Backend` implementation: id, capabilitiesFor, listModels, countTokens, invoke | ~180 |

## Test infrastructure added

| Path | Purpose |
|---|---|
| `tests/fixtures/mock-claude/index.mjs` | Hermetic mock CLI keyed off prompt substrings for deterministic behavior |
| `tests/fixtures/mock-claude/package.json` | Tiny shim so the fixture can run via `node tests/fixtures/mock-claude/index.mjs` |
| `tests/unit/runners/types.test.ts` | Type-level construction tests (5 cases) |
| `tests/unit/runners/claudeRunner.test.ts` | buildArgs unit tests + spawn tests against mock-claude (10 cases) |
| `tests/unit/runners/claudeStreamRunner.test.ts` | buildStreamArgs + stream iteration tests (7 cases) |
| `tests/unit/backends/claudeBackend.test.ts` | Capability matrix, listModels, countTokens, invoke (12 cases) |
| `tests/integration/claudeBackend.test.ts` | End-to-end through `BackendRegistry` (2 cases) |

Run all: `npm test` — expect 93 tests passing.

## Plan-02 scope boundary (what does NOT ship here)

The `Backend.invoke()` method explicitly throws on any of the following — they land in **Plan 04 (Native tool_use + multimodal)**:

- Image content blocks (`type: "image"`)
- Document content blocks (`type: "document"`)
- Tool-use content blocks (`type: "tool_use"`)
- Tool-result content blocks (`type: "tool_result"`)
- Any non-empty `tools` array on the request
- Any non-empty `stopSequences` array on the request

This is a deliberate fail-loud choice: rather than silently producing wrong output, the backend rejects requests it can't honor in Plan-02 scope. Callers can detect this via the thrown error message.

## What the next plan (Plan 03 — Anthropic shim core) needs

- A working `src/server.ts` (Express bootstrap) that:
  - Loads config via `loadConfig`
  - Constructs a `BackendRegistry` and registers the `ClaudeBackend`
  - Calls `registry.startPeriodicProbe(config.router.localProbeIntervalMs)`
  - Wires the new Anthropic shim's `/v1/messages` endpoint to dispatch through the registry
- `src/anthropicShim/` with `messages.ts`, `requestTranslator.ts`, `responseTranslator.ts`
- Plan 03 should leave the existing `dist/server.js` alone — both servers can coexist on different ports for a transitional period if needed

## Deviations from this plan that landed during execution

(Filled in by the implementer / reviewer during the actual task cycles. Notable items typically include comment clarifications, additional defensive tests, or minor type tightening discovered during code-quality review.)
