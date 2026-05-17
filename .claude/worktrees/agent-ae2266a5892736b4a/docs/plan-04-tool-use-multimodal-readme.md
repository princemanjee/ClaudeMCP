# Plan 04 — Native `tool_use` + Multimodal + Stop Sequences + Tool Choice: what shipped

Plan 04 upgraded the Anthropic shim and the Claude backend so the routes Plan 03 mounted now honor the full text-plus-tools-plus-vision request surface. No new endpoints; no new modules of consequence (a tiny `createStopSequenceMatcher` helper is the only net-new exported symbol).

## What was previously rejected and is now honored

The Plan-03 request translator returned 400 for any of: `image`, `document`, `tool_use`, `tool_result` content blocks; non-empty `tools`; non-empty `stop_sequences`; `tool_choice`. Plan 04 replaces those rejections with real translation. The Claude backend's `assertPlan02Scope` guard is gone; the same content/fields flow through to the CLI invocation and out as Anthropic-shaped SSE or buffered responses.

## Modules touched

| Path | Change |
|---|---|
| `src/backends/claudeBackend.ts` | Removed scope guard. Added envelope-serialization of image/document/tool_use/tool_result blocks into the folded prompt. Added `tool_choice` directive helper. Forwarded `tools` and `stopSequences` to the stream runner. Emit `tool_use_*` `NormalizedEvent` triple on CLI tool_use blocks. Translate cutter sentinel into `message_stop` with `stopReason: "stop_sequence"`. |
| `src/runners/claudeStreamRunner.ts` | Added `createStopSequenceMatcher` (rolling-tail buffer). Wired the matcher into the runner's data handler. Extended `buildStreamArgs` with `--tools <json>` and `--stop-sequences <json>` flags. |
| `src/runners/types.ts` | Added `tools` and `stopSequences` to `ClaudeStreamOptions`. |
| `src/anthropicShim/types.ts` | Typed the `image`, `document`, `tool_use`, `tool_result` variants; added `AnthropicToolDef`, `AnthropicToolChoice`; extended response content block union with `tool_use`. |
| `src/anthropicShim/requestTranslator.ts` | Replaced 7 fail-loud branches with passthrough translation. `thinking`, `cache_control`, `image source.type 'url'`, `image source.type 'file'`, `document source.type 'url'`, `document source.type 'file'` still 400. |
| `src/anthropicShim/responseTranslator.ts` | Emit Anthropic `content_block_start/delta/stop` for `tool_use_*` events. Aggregate `tool_use` content blocks in the non-streaming response body with parsed input JSON. |

## Test infrastructure added

| Path | Coverage |
|---|---|
| `tests/fixtures/mock-claude/index.mjs` | EXTENDED with `MOCK_TOOL_USE(...)`, `MOCK_STOP_SEQUENCE_AT(...)`, `MOCK_VISION_REQUEST`, `MOCK_TOOL_RESULT_ECHO` triggers + argv inspection on `--tools` and `--stop-sequences`. Also bumped the system-prompt echo slice from 32 → 256 chars so tool_choice directives fit in the echoed text. |
| `tests/unit/anthropicShim/types.test.ts` | NEW — type-level smoke test for the typed content block union and tool defs. |
| `tests/unit/runners/claudeStreamRunner.test.ts` | EXTENDED — matcher helper coverage (7 cases), arg construction for `--tools`/`--stop-sequences` (4 cases), runtime sentinel emission against mock (3 cases). |
| `tests/unit/backends/claudeBackend.test.ts` | EXTENDED — tools forwarded, image/document inlined, tool_result re-inlined, tool_choice directives, stop_sequence end-to-end, tool_use event triple emitted. Plan-02 fail-loud tests removed. |
| `tests/unit/anthropicShim/requestTranslator.test.ts` | Plan-03 fail-loud tests for image/document/tool_use/tool_result/tools/tool_choice/stop_sequences DELETED. Passthrough tests added. `thinking`/`cache_control` rejections retained. |
| `tests/unit/anthropicShim/responseTranslator.test.ts` | EXTENDED — tool_use SSE emission, tool_use aggregation, stop_sequence stop_reason. |
| `tests/unit/anthropicShim/messages.test.ts` | UPDATED — 3 Plan-03 fail-loud HTTP tests (image, tools, stop_sequences) flipped to assert 200 OK now that the translator passes them through. |
| `tests/unit/anthropicShim/countTokens.test.ts` | UPDATED — 1 Plan-03 fail-loud HTTP test (image content rejection) flipped to assert 200 OK now that the translator accepts it. |
| `tests/integration/toolUse.test.ts` | NEW — non-streaming + streaming tool_use end-to-end, plus stop_sequences end-to-end. |
| `tests/integration/multimodal.test.ts` | NEW — image, document, and tool_result re-inlining end-to-end. |

Run all: `npm test`.

## Plan-04 scope boundary (still NOT shipped)

The request translator still 400s on:

- `image` / `document` `source: { type: "url" }` — URL fetching lands in Plan 05.
- `image` / `document` `source: { type: "file" }` — `file_<hash>` resolution lands in Plan 05.
- `cache_control` on any block — response cache lands in Plan 05.
- `thinking` field — extended thinking lands in a follow-up sub-task (see Open questions).

The backend still:

- Doesn't write to the `Archive` (Plan 05 wires the writers).
- Doesn't consult the response cache (Plan 05).
- Doesn't read from `fileStore` (Plan 05).

The OpenAI shim retains prompt-engineered tool emulation — explicitly out of scope per the spec.

## Capability matrix change

None. `ClaudeBackend.capabilitiesFor()` reports the same flags Plan 02 set:
`toolUse: true`, `multimodal: true`, `stopSequences: "server-side-cut"`. Plan 02 made those aspirational; Plan 04 makes them load-bearing.

## What the next plan (Plan 05 — Files API + Archive writes + Response cache) needs

- The Plan-04 translators are the only code that reads `block.source.type`. Plan 05's `file` and `url` source handling slots in by replacing the `bad(...)` calls in `requestTranslator.ts` with fetches / file-store lookups.
- The `cache_control` rejection stays the only request-shape gate Plan 05 needs to drop.
- `Archive` write hooks belong in the `messages.ts` handler (post-invoke), not in the translators or the backend.

## Open questions

These were known at write-time and are still open going into execution:

1. **CLI image input flag.** Plan 04 ships the assumption that the Claude CLI accepts inlined image data via a `[image:<mediaType>;base64,...]` envelope in the prompt body (passed via `-p <prompt>`). If the real CLI supports a dedicated `--image <path>` or stdin-based image input that produces better model fidelity, Plan 06+ should revisit the envelope choice. The current shape is the lowest-coupling option that works through the existing `-p`-only CLI surface.

2. **CLI tool definitions flag.** Plan 04 ships `--tools <json>` as a passthrough flag. The actual Claude CLI surface for tool definitions has not been verified at write time; if the real flag is `--tool-defs`, `--tool-spec`, or requires a file path instead of inline JSON, only `buildStreamArgs` and the integration tests need updating.

3. **CLI stop-sequences flag.** Same caveat as `--tools`: Plan 04 ships `--stop-sequences <json>` as a passthrough. The cutter is belt-and-braces — if the CLI honors the flag natively, the cutter is a no-op; if it doesn't, the cutter terminates the child on the first match. Either way, the wire-shape contract holds.

4. **Native `input_json_delta` streaming from Claude.** The mock-claude fixture emits a single fully-formed `tool_use` block per turn. Real Claude streams `input_json_delta` chunks as the model generates the tool input. The Plan-04 backend already handles multi-delta accumulation correctly (the test `aggregates a tool_use block into content[] with parsed input` exercises two-chunk delivery). If the real CLI's stream-json output uses a different intermediate shape (e.g., `input_json_delta` events instead of full content blocks), the assistant-content branch in `invoke()` needs a small adapter; the test suite catches the regression.

5. **`thinking` field.** The spec puts extended thinking in the same phase as tool_use + multimodal, but the implementation phasing note narrows Plan 04 to tool_use + multimodal + stop_sequences + tool_choice. `thinking` still 400s. A follow-up sub-task (call it Plan 04.5) can extend the request translator + backend invoke path to honor it; the `NormalizedEvent.thinking_delta` variant is not yet in Plan-01's union, so that sub-task lands a foundation type addition first.

6. **`tool_choice: { type: "tool", name: "X" }` enforcement.** Plan 04 ships the directive-on-system-prompt approach per the spec. It's best-effort. If a strict caller needs hard enforcement, the path is (a) inspect outgoing `tool_use_start` events and (b) drop / replace any that name a different tool. That belongs in a future plan once we measure how often the model honors the directive.

7. **Tool-result with image content.** Anthropic's docs allow `tool_result.content` to wrap images. Plan 04 only honors string and text-block-array content — image content arrays throw 400. Plan 05 should revisit (probably folding into the same code path as request-side images).

---

## Deviations from the as-designed plan

These are minimal corrections to plan-shipped code that I applied at execution time. Each is small, isolated, and preserves intent.

1. **Task 1 — type-test discriminant guards.** The plan's `types.test.ts` reads bare properties off the widened `AnthropicContentBlock` (e.g. `widened.id`, `widened.tool_use_id`). The TypeScript union narrows by discriminant; bare access without a `type === "tool_use"` guard would fail typecheck once the union becomes strictly typed. Replaced bare accesses with discriminant ternaries (`widened.type === "tool_use" ? widened.id : ""`). Pure refactor — runtime semantics identical.

2. **Task 1 — vitest erases types.** The plan's Step 2 expects `npx vitest run` to FAIL before implementation because the imported types don't exist. Vitest only runs JS (types are erased), so the test passed even before the types were added. Documented for awareness; the type-correctness of the test only becomes load-bearing when tests are typechecked (they're currently excluded from `tsc` via `tsconfig.json#exclude`).

3. **Task 2 — sleep idiom for MOCK_STOP_SEQUENCE_AT.** The plan calls `await new Promise((r) => setTimeout(r, 5000))` but Plan 02 deviation #1 (per the executor brief) found bare `new Promise(() => {})` triggers Node's unsettled-top-level-await detection. Used the `setInterval(() => {}, 1_000_000)` keep-alive idiom inside a settling Promise so the mock stays alive for 5s without tripping Node's exit-13 path.

4. **Task 5 — mock-claude system slice bumped 32 → 256.** The mock echoes `system.slice(0, 32)` (Plan 02 chose 32 chars). The Plan-04 `tool_choice` test directives ("be precise\n\nYou must call exactly one tool this turn.") get cut mid-directive at 32 chars, so the regex assertions never match. Bumped the slice to 256. Plan-02 tests only check the `[system:` prefix; no Plan-02 test depends on the 32-char cap.

5. **Task 7 — messages.test.ts and countTokens.test.ts not in plan's file map.** The plan instructs deleting 7 Plan-03 fail-loud tests from `requestTranslator.test.ts` but does not mention `tests/unit/anthropicShim/messages.test.ts` (3 HTTP-level fail-loud tests for image/tools/stop_sequences) or `tests/unit/anthropicShim/countTokens.test.ts` (1 HTTP-level fail-loud test for image). Those tests regressed once the translator stopped throwing. Updated them in-place to assert 200 OK (passthrough behavior) instead of 400, matching Plan 04's intent. Documented in the test files' renamed `it("accepts ...")` titles.

