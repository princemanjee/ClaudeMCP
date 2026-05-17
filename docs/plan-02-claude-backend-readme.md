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

The following minimal corrections were applied during execution to fix plan bugs or platform-specific issues. None changed the design; all were the smallest fix needed to make tests pass and tsc check.

### 1. Mock-claude `MOCK_SLEEP_FOREVER` — `await new Promise(() => {})` exits immediately

**File:** `tests/fixtures/mock-claude/index.mjs`

**Plan said:**
```js
if (prompt.includes("MOCK_SLEEP_FOREVER")) {
  await new Promise(() => {}); // never resolves
}
```

**What actually happens:** Node.js ESM modules detect "unsettled top-level await" and exit cleanly with code 13 within ~40ms, printing a warning. This defeated the Task 3 timeout test (`runClaude` expected `timedOut: true` but the mock had already exited cleanly long before the 250ms timer fired).

**Fix:** Replace the bare hung promise with a `setInterval` that keeps the event loop alive:
```js
if (prompt.includes("MOCK_SLEEP_FOREVER")) {
  await new Promise((_resolve) => {
    setInterval(() => {}, 1_000_000);
  });
}
```

This is the smallest change that makes the mock actually hang as the plan intended. Verified the Task 3 timeout test (`runClaude times out and kills the process`) and the Task 4 timeout test (`runClaudeStream stops iterating after timeout kills the process`) both pass.

### 2. `noUncheckedIndexedAccess` — `queue.shift()` returns `unknown | undefined`

**File:** `src/runners/claudeStreamRunner.ts`

**Plan said:** `yield queue.shift();`

**What `tsc` would see:** With `noUncheckedIndexedAccess` enabled in `tsconfig.json`, `Array#shift()` widens to `T | undefined`, so the generator's yield type would have to be `unknown | undefined` instead of `unknown`. The async iterator's element type would no longer match.

**Fix:** Add a non-null assertion — safe because the surrounding `if (queue.length > 0)` guard guarantees a value:
```ts
yield queue.shift()!;
```

This is the minimum tightening required.

### 3. Test count in Task 6: 12 instead of 13

**File:** `tests/unit/backends/claudeBackend.test.ts`

**Plan said:** Task 6 Step 2 expects "8 original tests pass, 5 new tests FAIL" → "Expected: PASS — all 13 tests green (8 original + 5 new)."

**Reality:** The original Task 5 skeleton suite has 8 tests including `invoke() throws — landed in Task 6`. Task 6 replaces the invoke() implementation so it no longer throws — that test cannot survive Task 6 as-written. The cleanest fix is to replace the placeholder test with the 5 new tests instead of appending alongside it, yielding 7 surviving skeleton tests + 5 new invoke tests = 12 total in the file.

This brings the final suite total to **93 tests** (57 from Plan 01 + 36 new), not the 94 the plan predicted. The discrepancy is exactly the removed placeholder.

### 4. Windows file mode for `tests/fixtures/mock-claude/index.mjs`

**File:** `tests/fixtures/mock-claude/index.mjs`

**Plan said:** Self-review checklist line: "Mock-claude fixture is executable on macOS (`-rwxr-xr-x` permission visible via `git ls-files --stage`)."

**Reality:** The implementer's environment is Windows, where `chmod +x` is a no-op against `core.filemode=false`. Git records the file as `100644` regardless. This will need to be fixed on a Unix host before macOS CI / direct-shebang invocation will work; for now it doesn't affect tests because they always invoke via `node tests/fixtures/mock-claude/index.mjs` (the explicit `node` prefix bypasses the shebang and the executable bit).

**Fix:** None applied — recording for future reference. On a macOS or Linux host, run:
```bash
git update-index --chmod=+x tests/fixtures/mock-claude/index.mjs
git commit -m "chore: mark mock-claude executable for macOS"
```

### Summary

- 1 mock-fixture bug fix (top-level await never sleeps)
- 1 type assertion to satisfy `noUncheckedIndexedAccess`
- 1 test-count reconciliation (12 vs 13, 93 vs 94 total)
- 1 platform deferral (file mode on Windows)

No changes to the documented architecture, the `Backend` interface, the runner argv shapes, or the event-normalization logic.

