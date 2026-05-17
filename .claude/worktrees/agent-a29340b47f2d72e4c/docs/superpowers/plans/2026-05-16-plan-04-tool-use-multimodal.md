# Plan 04: Native `tool_use` + Multimodal + `stop_sequences` + `tool_choice` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the load-bearing surface of the Anthropic shim live up to its capability matrix. The Claude backend learns to translate native `tool_use` round-trips, image/document content blocks, server-side `stop_sequences` cuts, and `tool_choice` directives. The Anthropic shim's request and response translators stop fail-loud-rejecting those features and start passing them through end-to-end. No new endpoints land here; this plan upgrades the two artifacts already in flight (the Claude backend from Plan 02 and the Anthropic shim core from Plan 03) so that the routes already mounted in `src/server.ts` honor the full text-plus-tools-plus-vision request surface.

**Architecture:** Three discrete extensions, all within the existing Plan-02/03 module layout:

1. **`ClaudeBackend.invoke()` upgrade.** Remove the Plan-02 `assertPlan02Scope` guard. Translate `tools` → CLI tool-definition argv flag; translate `tool_choice` → system-prompt directive concatenated onto `req.system`; serialize `image` / `document` blocks into the existing folded prompt (base64 inline, mediaType-tagged); thread `stopSequences` through to the stream runner. Then learn to **emit** Plan-01's `tool_use_start` / `tool_use_delta` / `tool_use_stop` `NormalizedEvent`s when the CLI's `stream-json` reports `tool_use` content blocks. Re-inline downstream `tool_result` blocks into the next CLI invocation's prompt.
2. **`claudeStreamRunner` cutter.** Add a `stopSequences?: string[]` option to `ClaudeStreamOptions`. When set, the runner buffers a rolling tail of `max(stopSeq.length) - 1` bytes across stream chunks; on each new text-content chunk, it searches `(tail + chunk)` for any of the sequences. On match: emit text up to the match start, signal `stop_sequence`, then `tree-kill` the child. Surfaced via a new `kind: "_cut_at"` internal marker (or a paired-out-band callback — see Task 4 for the chosen shape) that `ClaudeBackend.invoke()` translates into `message_stop` with `stopReason: "stop_sequence"`.
3. **Anthropic shim translators.** `requestTranslator.ts` stops throwing on `image`, `document`, `tool_use`, `tool_result`, `tools`, `tool_choice`, and `stop_sequences`. Each becomes a typed passthrough into `NormalizedRequest`. `responseTranslator.ts` learns to emit Anthropic's `content_block_start` (with `content_block: { type: "tool_use", id, name, input: {} }`), `content_block_delta` (with `delta: { type: "input_json_delta", partial_json: "..." }`), and `content_block_stop` for the new `tool_use_*` `NormalizedEvent`s. The non-streaming aggregator assembles a single `tool_use` content block per `(index)` group. The `stop_reason: "stop_sequence"` path is now reachable end-to-end.

**Tech Stack:** Same as Plans 01-03 — Node.js 20+, TypeScript 5 (NodeNext ESM), `cross-spawn`, `tree-kill`, Express 4, Vitest + Supertest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md` (Phase 4: Native tool_use + multimodal; also §"Stop sequences", §"Tool calling — native round-trip", §"`tool_choice` enforcement").

**Builds on:**
- **Plan 01** (`docs/superpowers/plans/2026-05-16-plan-01-foundation.md`) — `Backend`, `BackendCapabilities`, `NormalizedRequest`, `NormalizedEvent` (notably the `tool_use_start`/`tool_use_delta`/`tool_use_stop` variants and `stopReason: "stop_sequence"`), `NormalizedContentBlock` (`image`, `document`, `tool_use`, `tool_result`), `NormalizedToolDef`, `NormalizedToolChoice`. `BackendCapabilities.toolUse` already true on the Claude backend.
- **Plan 02** (`docs/superpowers/plans/2026-05-16-plan-02-claude-backend.md`) — `ClaudeBackend.invoke()` with its `assertPlan02Scope` guard, `claudeStreamRunner.ts`, the `mock-claude` fixture at `tests/fixtures/mock-claude/index.mjs`.
- **Plan 03** (`docs/superpowers/plans/2026-05-16-plan-03-anthropic-shim.md`) — `src/anthropicShim/requestTranslator.ts`, `src/anthropicShim/responseTranslator.ts`, `src/anthropicShim/types.ts`, `src/anthropicShim/messages.ts`, `src/server.ts`.

The Plan-03 plan file is the **authority** on the shim's existing shape — Plan 04 modifies the same files. If Plan 03's open questions remain unresolved at execution time (Anthropic version header, streaming error envelope, `display_name`, `created_at`, Windows subprocess test, JSON body size, probe concurrency), treat them as still-open — do not try to resolve them here.

---

## Scope boundary for Plan 04

What this plan **does** land:

| Feature on the request | Plan 04 disposition |
|---|---|
| `image` content blocks (request side) | Inlined into Claude CLI invocation as base64, mediaType-tagged |
| `document` content blocks (request side) | Inlined into Claude CLI invocation as base64, mediaType-tagged |
| `tool_use` content blocks (assistant turn, request side) | Folded into prompt history with a documented serialization |
| `tool_result` content blocks (user turn, request side) | Folded into prompt history under the matching `tool_use_id` |
| `tools` array | Forwarded to CLI via `--tools` flag (JSON-encoded array) |
| `tool_choice` field | Appended to `req.system` as a directive per the spec's table |
| `stop_sequences` array | Plumbed through to the stream runner; server-side cut on match |
| `tool_use` content blocks (response side, emitted by Claude) | Translated to `NormalizedEvent` `tool_use_*` triple |
| Anthropic SSE `content_block_*` for `tool_use` | Emitted by the response translator |
| Anthropic non-streaming `content[]` with `tool_use` blocks | Emitted by the response translator |
| `stop_reason: "stop_sequence"` on the wire | End-to-end |

What this plan does **not** land (out of scope, deferred to later plans):

- `/v1/files` endpoints (Plan 05).
- `file_<hash>` resolution in the request translator (Plan 05; until then, `file_<hash>` references in image/document blocks still 400 with a descriptive message).
- Response cache and `cache_control` reinterpretation (Plan 05; cache_control still rejected by the request translator with a 400 — same as Plan 03).
- Archive writes (Plan 05).
- `thinking` field on the request (Plan 04 leaves the request translator's existing 400 rejection in place — the spec puts native thinking in the same phase as tool_use, but the implementation phasing note in the spec scopes Plan 04 to tool_use + multimodal + stop_sequences + tool_choice only; `thinking` is a separate sub-task tracked in the open questions).
- The Gemini backend's tool_use / multimodal (Plans 06 + 07).
- LM Studio / Ollama tool calling (Plans 08 / 09).
- The OpenAI shim's tool_use upgrade — explicitly out of scope per the design spec (the OpenAI shim stays on prompt-engineered emulation forever per Non-goals).

**Capability matrix changes:** None. `ClaudeBackend.capabilitiesFor()` already returns `toolUse: true`, `multimodal: true`, `stopSequences: "server-side-cut"` — Plan 02 made those aspirational; Plan 04 makes them load-bearing. No new flags introduced.

**`tool_choice: { type: "tool", name: "X" }` handling:** Implemented as a system-prompt directive per the spec's `tool_choice enforcement` table. Best-effort; not a hard constraint on the CLI. The Claude CLI has no flag to force a specific tool name; the directive `"If you call a tool, only call \`X\`."` is appended to the system prompt.

---

## File map

| File | Change |
|---|---|
| `src/backends/claudeBackend.ts` | Remove `assertPlan02Scope`. Add a new `applyToolChoiceDirective(system, toolChoice)` helper. Extend `foldMessagesToPrompt` to serialize `image`, `document`, `tool_use`, `tool_result` blocks into the folded prompt. Forward `req.tools` into the stream runner via a new `tools` option. Forward `req.stopSequences` into the stream runner. Translate CLI `tool_use` content blocks into the `tool_use_start` / `tool_use_delta` / `tool_use_stop` `NormalizedEvent` triple. Translate the cutter's `_cut_at` internal marker into `message_stop` with `stopReason: "stop_sequence"`. |
| `src/runners/claudeStreamRunner.ts` | Add the stop-sequence cutter. Add `tools` and `stopSequences` to `ClaudeStreamOptions`. Update `buildStreamArgs` to emit `--tools <json>` when `tools` is non-empty. The cutter implementation lives in a small helper `createStopSequenceMatcher(stopSequences)` exported for direct unit testing. On match, the runner yields a sentinel `{ type: "_internal", subtype: "stop_sequence_match", at: <byte-offset-into-current-chunk> }` event before tree-killing the child. |
| `src/runners/types.ts` | Add `tools?: NormalizedToolDef[]` and `stopSequences?: string[]` to `ClaudeStreamOptions`. Import `NormalizedToolDef` from `../backends/types.js`. |
| `src/anthropicShim/types.ts` | Tighten `AnthropicContentBlock` to fully type the `image`, `document`, `tool_use`, and `tool_result` variants (no `unknown source`). Add `AnthropicImageSource`, `AnthropicDocumentSource`. Add `AnthropicToolDef`, `AnthropicToolChoice`. Extend `AnthropicResponseContentBlock` to include `tool_use`. |
| `src/anthropicShim/requestTranslator.ts` | Replace the `bad("...")` branches for `image`, `document`, `tool_use`, `tool_result`, `tools`, `tool_choice`, and `stop_sequences` with real translation into the `NormalizedContentBlock` / `NormalizedToolDef` / `NormalizedToolChoice` shapes. |
| `src/anthropicShim/responseTranslator.ts` | Emit `content_block_start` + `content_block_delta` (with `input_json_delta`) + `content_block_stop` for `tool_use_*` `NormalizedEvent`s. Aggregate `tool_use` blocks into the non-streaming `content[]`. Map `stopReason: "stop_sequence"` correctly (Plan 03's `mapStopReason` already handles this, but the wiring's first end-to-end test lands here). |
| `tests/fixtures/mock-claude/index.mjs` | EXTEND: add `MOCK_TOOL_USE` prompt trigger that emits assistant events containing `tool_use` content blocks. Add `MOCK_STOP_SEQUENCE_AT(X)` to emit text containing the literal `X` mid-stream. Add `MOCK_VISION_REQUEST` that asserts inbound argv carries an image-bearing input payload (writes a JSON receipt to stderr the test can parse). Add `MOCK_TOOL_RESULT_ECHO` that echoes back tool_result content found in the prompt so re-inlining is verifiable. |
| `tests/unit/runners/claudeStreamRunner.test.ts` | Add tests for `createStopSequenceMatcher`: not present → completes normally, present mid-chunk → reports cut at offset, split across two chunks → still caught by tail buffer. Add `--tools` arg construction tests. Add an end-to-end test against the mock that the runner emits the `_internal stop_sequence_match` sentinel and exits when the mock prints `STOP-NOW` and `stopSequences: ["STOP-NOW"]` is set. |
| `tests/unit/backends/claudeBackend.test.ts` | Add tests: `tools` array translated to CLI `--tools` flag, image block inlined into prompt with mediaType marker, document block inlined, tool_use round-trip emits `tool_use_*` event triple, tool_result re-inlined into prompt with `[tool_result:<id>]` envelope, `stop_sequences` cut triggers `message_stop` with `stopReason: "stop_sequence"`, `tool_choice` directive appended to system prompt for each of `auto` (noop), `any`, `none`, and `{type: "tool", name: "X"}`. Remove the four "throws on Plan-02-out-of-scope" tests. |
| `tests/unit/anthropicShim/requestTranslator.test.ts` | Replace the seven Plan-03 fail-loud tests (image, document, tool_use, tool_result, tools, tool_choice, stop_sequences) with passthrough tests that assert the translator produces the correct `NormalizedRequest`. Keep the `cache_control`, `thinking`, `file_<hash>` rejections — those are still scoped to later plans. |
| `tests/unit/anthropicShim/responseTranslator.test.ts` | Add tests for `tool_use_*` SSE emission (the full Anthropic event triple per `tool_use` block, with `input_json_delta` carrying the accumulated partial JSON), non-streaming aggregation of `tool_use` content blocks, and `stop_reason: "stop_sequence"` end-to-end. |
| `tests/integration/toolUse.test.ts` | NEW: end-to-end `POST /v1/messages` with a `tools` array and a `MOCK_TOOL_USE` prompt. Verify the Anthropic-SDK-shaped non-streaming response carries a `tool_use` content block with the expected `id`, `name`, and `input`. Verify the streaming variant emits the documented `content_block_*` triple. Uses mock-claude. |
| `tests/integration/multimodal.test.ts` | NEW: end-to-end `POST /v1/messages` with an `image` content block. Verifies the request reaches the CLI invocation. Uses the `MOCK_VISION_REQUEST` trigger so the mock can write a stderr receipt showing the image payload arrived. |
| `docs/plan-04-tool-use-multimodal-readme.md` | Close-out documentation. |

---

## Pre-flight check

Before starting Task 1, confirm the Plans 01-03 baseline is in place:

- [ ] `git log --oneline -20` shows Plan 03's commits merged (look for `feat(anthropicShim): add /v1/messages handler with streaming + non-streaming paths`).
- [ ] `npm test` passes the full Plan-03 suite (Plan 02's count + Plan 03's ~85 new tests).
- [ ] `npx tsc --noEmit` clean.
- [ ] `src/backends/claudeBackend.ts` exports `ClaudeBackend` and contains a `private assertPlan02Scope(req)` method that throws on `tools`, `stopSequences`, `image`, `document`, `tool_use`, `tool_result`.
- [ ] `src/anthropicShim/requestTranslator.ts` exports `anthropicRequestToNormalized` and throws `ShimRequestError` on `image`, `document`, `tool_use`, `tool_result`, `tools`, `tool_choice`, `stop_sequences`, `thinking`, `cache_control`.
- [ ] `src/anthropicShim/responseTranslator.ts` exports `normalizedEventsToSSE` and `normalizedEventsToFinalResponse`, both of which currently ignore `tool_use_*` `NormalizedEvent`s with a comment to that effect.
- [ ] `src/runners/claudeStreamRunner.ts` exports `buildStreamArgs` and `runClaudeStream` but has no `stopSequences` / `tools` knowledge.
- [ ] `tests/fixtures/mock-claude/index.mjs` exists and supports the Plan-02 triggers (`MOCK_ERROR`, `MOCK_SLEEP_FOREVER`, `MOCK_INVALID_JSON`).

If any check fails, stop and resolve before proceeding.

---

## Task 1: Extend the Anthropic shim type surface

**Files:**
- Modify: `src/anthropicShim/types.ts`
- Test: (none — type-only changes are exercised by Task 6 onwards. A `tests/unit/anthropicShim/types.test.ts` smoke file lands as part of this task to catch regressions in the union shape.)
- Create: `tests/unit/anthropicShim/types.test.ts`

Plan 03's `AnthropicContentBlock` uses `unknown` placeholders for non-text variants. Plan 04 needs typed shapes so the request translator can read them without `as` casts. This task lands those types plus the `AnthropicToolDef` / `AnthropicToolChoice` / `AnthropicResponseContentBlock` extensions.

- [ ] **Step 1: Write the failing type-level smoke test**

Create `tests/unit/anthropicShim/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicDocumentBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicToolDef,
  AnthropicToolChoice,
  AnthropicResponseContentBlock
} from "../../../src/anthropicShim/types.js";

describe("AnthropicContentBlock union — Plan 04 typed variants", () => {
  it("admits a typed image block with base64 source", () => {
    const block: AnthropicImageBlock = {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "iVBORw0KGgo="
      }
    };
    const widened: AnthropicContentBlock = block;
    expect(widened.type).toBe("image");
  });

  it("admits a typed document block with base64 source", () => {
    const block: AnthropicDocumentBlock = {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "JVBERi0="
      }
    };
    const widened: AnthropicContentBlock = block;
    expect(widened.type).toBe("document");
  });

  it("admits a typed tool_use block with id, name, input", () => {
    const block: AnthropicToolUseBlock = {
      type: "tool_use",
      id: "toolu_01ABC",
      name: "calculator",
      input: { x: 1, y: 2 }
    };
    const widened: AnthropicContentBlock = block;
    expect(widened.id).toBe("toolu_01ABC");
  });

  it("admits a typed tool_result block with string content shorthand", () => {
    const block: AnthropicToolResultBlock = {
      type: "tool_result",
      tool_use_id: "toolu_01ABC",
      content: "3"
    };
    const widened: AnthropicContentBlock = block;
    expect(widened.tool_use_id).toBe("toolu_01ABC");
  });

  it("admits a typed tool_result block with content-block array", () => {
    const block: AnthropicToolResultBlock = {
      type: "tool_result",
      tool_use_id: "toolu_01ABC",
      content: [{ type: "text", text: "the answer is 3" }]
    };
    expect(Array.isArray(block.content)).toBe(true);
  });

  it("constructs AnthropicToolDef with description + input_schema", () => {
    const def: AnthropicToolDef = {
      name: "calculator",
      description: "Adds two numbers",
      input_schema: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"]
      }
    };
    expect(def.name).toBe("calculator");
  });

  it("constructs every AnthropicToolChoice variant", () => {
    const auto: AnthropicToolChoice = { type: "auto" };
    const any: AnthropicToolChoice = { type: "any" };
    const none: AnthropicToolChoice = { type: "none" };
    const named: AnthropicToolChoice = { type: "tool", name: "calculator" };
    expect([auto, any, none, named]).toHaveLength(4);
  });

  it("AnthropicResponseContentBlock includes tool_use", () => {
    const responseBlock: AnthropicResponseContentBlock = {
      type: "tool_use",
      id: "toolu_01",
      name: "calc",
      input: { x: 1 }
    };
    expect(responseBlock.type).toBe("tool_use");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/anthropicShim/types.test.ts`
Expected: FAIL — types `AnthropicImageBlock`, `AnthropicDocumentBlock`, etc. don't yet exist.

- [ ] **Step 3: Extend `src/anthropicShim/types.ts`**

Replace the existing `AnthropicContentBlock` union with typed variants and add the new exports. The file currently reads (excerpt):

```ts
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | { type: "image"; source: unknown }
  | { type: "document"; source: unknown }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown };
```

Replace with:

```ts
// ---- Source shapes for image/document -----------------------------------

export interface AnthropicBase64Source {
  type: "base64";
  media_type: string;
  data: string;
}

export interface AnthropicUrlSource {
  type: "url";
  url: string;
}

/**
 * Anthropic also allows `{ type: "file"; file_id: "file_<hash>" }` for the
 * Files API; Plan 04 admits the type but the request translator rejects it
 * with a 400 until Plan 05 lands the file store. Listed here for the type
 * system, not for honoring.
 */
export interface AnthropicFileRefSource {
  type: "file";
  file_id: string;
}

export type AnthropicImageSource =
  | AnthropicBase64Source
  | AnthropicUrlSource
  | AnthropicFileRefSource;
export type AnthropicDocumentSource =
  | AnthropicBase64Source
  | AnthropicUrlSource
  | AnthropicFileRefSource;

// ---- Typed content block variants ---------------------------------------

export interface AnthropicImageBlock {
  type: "image";
  source: AnthropicImageSource;
}

export interface AnthropicDocumentBlock {
  type: "document";
  source: AnthropicDocumentSource;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/**
 * `content` may be a plain string (shorthand) OR an array of nested content
 * blocks (typically text). Anthropic's docs allow tool_result to also wrap
 * images, but Plan 04 only honors the string and text-block-array shapes.
 */
export type AnthropicToolResultContent =
  | string
  | Array<AnthropicTextBlock>;

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: AnthropicToolResultContent;
  /**
   * Optional flag Anthropic uses when the tool reported failure. Plan 04
   * forwards into the prompt envelope; the model decides what to do with it.
   */
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;
```

Then add the tool def + tool choice shapes (after the response shapes block):

```ts
// ---- Tool definitions + tool_choice -------------------------------------

export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema: unknown; // JSON Schema
}

export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "none" }
  | { type: "tool"; name: string };
```

Finally extend `AnthropicResponseContentBlock`:

```ts
// Was: export type AnthropicResponseContentBlock = AnthropicResponseTextBlock;
export interface AnthropicResponseToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export type AnthropicResponseContentBlock =
  | AnthropicResponseTextBlock
  | AnthropicResponseToolUseBlock;
```

And update `AnthropicMessagesRequest.tools` and `.tool_choice` to use the new typed shapes (replace the `unknown[]` and `unknown` placeholders Plan 03 used):

```ts
export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: AnthropicSystem;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicToolDef[];
  tool_choice?: AnthropicToolChoice;
  metadata?: Record<string, unknown>;
  thinking?: unknown;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/anthropicShim/types.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Run the Plan-03 type-checking baseline**

Run: `npx tsc --noEmit`
Expected: Clean. (The request translator still uses `bad(...)` for these block types, so the type narrowing inside that switch may need an explicit cast. If `tsc` complains, accept the cast — Task 6 will rewrite the affected branches anyway.)

- [ ] **Step 6: Commit**

```bash
git add src/anthropicShim/types.ts tests/unit/anthropicShim/types.test.ts
git commit -m "feat(anthropicShim/types): type image/document/tool_use/tool_result/tool_choice variants"
```

---

## Task 2: Mock-claude fixture extensions

**Files:**
- Modify: `tests/fixtures/mock-claude/index.mjs`

Plan 02 shipped the fixture with prompt-substring triggers (`MOCK_ERROR`, `MOCK_SLEEP_FOREVER`, `MOCK_INVALID_JSON`). Plan 04 adds four new triggers so the new test suites can deterministically force tool_use, stop-sequence, vision, and tool-result-echo behaviors without standing up a real Claude subscription.

- [ ] **Step 1: Read the existing fixture**

Confirm the file matches Plan 02's shape. The relevant section is the trigger ladder near the top (after argv parsing and before the "Normal output" block).

- [ ] **Step 2: Extend the fixture**

Add the following triggers inside `tests/fixtures/mock-claude/index.mjs`, **between** the existing `MOCK_INVALID_JSON` block and the `// Normal output` comment. Also wire up two new flag-value parses (`--tools` and `--stop-sequences`) so the mock can record what argv arrived for inspection by the new tests.

Near the top, alongside the existing `flagValue` reads:

```js
const toolsFlag = flagValue("--tools");
const stopSequencesFlag = flagValue("--stop-sequences");
```

Then below the existing triggers:

```js
// ---- Plan 04 triggers --------------------------------------------------

// MOCK_TOOL_USE(<name>,<id>,<json-input>)
// Emits an assistant event with a tool_use content block, then a result.
// Example: MOCK_TOOL_USE(calculator,toolu_01,{"x":1,"y":2})
const toolUseMatch = prompt.match(/MOCK_TOOL_USE\(([^,]+),([^,]+),(\{[^)]*\})\)/);
if (toolUseMatch) {
  if (outputFormat !== "stream-json") {
    stderr.write("MOCK_TOOL_USE requires --output-format stream-json\n");
    exit(2);
  }
  const [, toolName, toolId, inputJson] = toolUseMatch;
  stdout.write(
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model }) +
      "\n"
  );
  // Emit the tool_use block in two delta-style chunks so the stream runner's
  // tool_use_delta path is exercised. The mock just sends the full JSON in
  // the first event for simplicity; real Claude streams partial_json.
  stdout.write(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: toolId,
            name: toolName,
            input: JSON.parse(inputJson)
          }
        ]
      }
    }) + "\n"
  );
  stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      stop_reason: "tool_use",
      result: ""
    }) + "\n"
  );
  exit(0);
}

// MOCK_STOP_SEQUENCE_AT(<literal>)
// Emits ordinary text that contains <literal> in the middle. Use with
// stop_sequences: ["<literal>"] to drive the runner's cutter.
const stopMatch = prompt.match(/MOCK_STOP_SEQUENCE_AT\(([^)]+)\)/);
if (stopMatch) {
  const [, literal] = stopMatch;
  if (outputFormat !== "stream-json") {
    stderr.write("MOCK_STOP_SEQUENCE_AT requires --output-format stream-json\n");
    exit(2);
  }
  stdout.write(
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model }) +
      "\n"
  );
  // Emit three text chunks: the second one contains the sentinel. The third
  // chunk is what we want the cutter to drop.
  stdout.write(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "before " }] }
    }) + "\n"
  );
  stdout.write(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: `mid${literal}rest` }]
      }
    }) + "\n"
  );
  stdout.write(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: " AFTER-SHOULD-BE-DROPPED" }] }
    }) + "\n"
  );
  // We deliberately do NOT emit a `result` event for this trigger — the
  // cutter is expected to terminate the child before it gets here. The
  // child process sleeps for ~5s so the cutter has time to act; if the
  // cutter doesn't fire, the runner's own timeout will eventually expire.
  await new Promise((r) => setTimeout(r, 5000));
  exit(0);
}

// MOCK_VISION_REQUEST
// Writes a JSON receipt to stderr summarizing the inbound argv so the
// integration test can assert image payloads arrived intact. Emits a normal
// text response so the rest of the pipeline behaves.
if (prompt.includes("MOCK_VISION_REQUEST")) {
  const receipt = {
    promptLength: prompt.length,
    promptHasImageMarker: /\[image:/i.test(prompt),
    promptImageMediaTypes: Array.from(
      prompt.matchAll(/\[image:([^\];]+)/gi),
      (m) => m[1]
    ),
    promptHasDocumentMarker: /\[document:/i.test(prompt),
    toolsFlag: toolsFlag ?? null,
    stopSequencesFlag: stopSequencesFlag ?? null
  };
  stderr.write(`MOCK_VISION_RECEIPT ${JSON.stringify(receipt)}\n`);
  // Fall through to the Normal output block so the integration test still
  // gets a well-formed response body.
}

// MOCK_TOOL_RESULT_ECHO
// Searches the prompt for [tool_result:<id>] envelopes and echoes them
// back in the response so re-inlining is verifiable end-to-end.
if (prompt.includes("MOCK_TOOL_RESULT_ECHO")) {
  const matches = Array.from(prompt.matchAll(/\[tool_result:([^\]]+)\]([^\[]*)/g));
  const echoed = matches
    .map(([, id, body]) => `echo[tool_result:${id}]=${body.trim()}`)
    .join("; ");
  const echoText = echoed || "no tool_result blocks found";
  if (outputFormat === "stream-json") {
    stdout.write(
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model }) +
        "\n"
    );
    stdout.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: echoText }] }
      }) + "\n"
    );
    stdout.write(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: sessionId,
        result: echoText
      }) + "\n"
    );
  } else {
    stdout.write(JSON.stringify({ session_id: sessionId, model, result: echoText }));
  }
  exit(0);
}
```

- [ ] **Step 3: Smoke-test each new trigger directly**

Run each of:

```
node tests/fixtures/mock-claude/index.mjs -p "MOCK_TOOL_USE(calculator,toolu_01,{\"x\":1})" --output-format stream-json
node tests/fixtures/mock-claude/index.mjs -p "MOCK_VISION_REQUEST: hello" --output-format json
node tests/fixtures/mock-claude/index.mjs -p "MOCK_TOOL_RESULT_ECHO [tool_result:t1]hi" --output-format stream-json
```

Expected:
- First emits 3 NDJSON lines (system init, assistant with tool_use, result).
- Second prints the normal `{session_id, model, result}` JSON on stdout AND a `MOCK_VISION_RECEIPT {...}` line on stderr.
- Third emits a 3-line stream where the assistant text contains `echo[tool_result:t1]=hi`.

Do **not** smoke-test `MOCK_STOP_SEQUENCE_AT` directly here — it intentionally sleeps for 5s waiting for the cutter; Task 4's tests verify it.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/mock-claude/index.mjs
git commit -m "test(fixture): extend mock-claude with tool_use, stop-sequence, vision, tool-result-echo triggers"
```

---

## Task 3: Add `tools` + `stopSequences` to `ClaudeStreamOptions` and `buildStreamArgs`

**Files:**
- Modify: `src/runners/types.ts`
- Modify: `src/runners/claudeStreamRunner.ts` (only `buildStreamArgs` here; the cutter lands in Task 4)
- Modify: `tests/unit/runners/claudeStreamRunner.test.ts`

Extend the option shapes and the pure arg-builder. This is the smallest possible step that lets the Claude backend forward `req.tools` and `req.stopSequences` into the CLI invocation; the runtime cutter behavior comes in Task 4.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/runners/claudeStreamRunner.test.ts` inside the existing `describe("buildStreamArgs", ...)` block:

```ts
  it("emits --tools <json> when tools is non-empty", () => {
    const args = buildStreamArgs({
      prompt: "hi",
      tools: [
        {
          name: "calculator",
          description: "Adds numbers",
          inputSchema: { type: "object", properties: { x: { type: "number" } } }
        }
      ],
      timeoutMs: 1000,
      claudeCommand: "claude"
    });
    expect(args).toContain("--tools");
    const json = args[args.indexOf("--tools") + 1];
    expect(typeof json).toBe("string");
    const parsed = JSON.parse(json as string) as Array<{ name: string }>;
    expect(parsed[0]?.name).toBe("calculator");
  });

  it("omits --tools when tools is undefined or empty", () => {
    expect(
      buildStreamArgs({
        prompt: "hi",
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).not.toContain("--tools");
    expect(
      buildStreamArgs({
        prompt: "hi",
        tools: [],
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).not.toContain("--tools");
  });

  it("emits --stop-sequences <json> when stopSequences is non-empty", () => {
    const args = buildStreamArgs({
      prompt: "hi",
      stopSequences: ["STOP", "END"],
      timeoutMs: 1000,
      claudeCommand: "claude"
    });
    expect(args).toContain("--stop-sequences");
    const json = args[args.indexOf("--stop-sequences") + 1];
    expect(JSON.parse(json as string)).toEqual(["STOP", "END"]);
  });

  it("omits --stop-sequences when stopSequences is undefined or empty", () => {
    expect(
      buildStreamArgs({
        prompt: "hi",
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).not.toContain("--stop-sequences");
    expect(
      buildStreamArgs({
        prompt: "hi",
        stopSequences: [],
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).not.toContain("--stop-sequences");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/runners/claudeStreamRunner.test.ts`
Expected: FAIL — the new tests fail because `tools` and `stopSequences` aren't accepted by `buildStreamArgs`.

- [ ] **Step 3: Extend `src/runners/types.ts`**

Add the import near the top of the file:

```ts
import type { NormalizedToolDef } from "../backends/types.js";
```

Then extend `ClaudeStreamOptions`:

```ts
export interface ClaudeStreamOptions extends Omit<ClaudeRunOptions, never> {
  /** Optional system prompt passed via `--system`. */
  systemPrompt?: string;
  /**
   * Tool definitions to expose to the CLI. When non-empty, serialized as JSON
   * and passed via `--tools <json>`. The CLI's expected flag and format is
   * documented as an OPEN QUESTION in the Plan 04 spec — the value may need
   * to be a file path, stdin, or a different flag name when verified against
   * the real CLI surface.
   */
  tools?: NormalizedToolDef[];
  /**
   * Stop sequences. Passed verbatim to the CLI via `--stop-sequences <json>`
   * AND used by the stream runner's local cutter for the server-side-cut
   * capability (see Task 4). Both layers are belt-and-braces: if the CLI
   * honors the flag natively, the cutter is a no-op; if it doesn't, the
   * cutter terminates the child on the first match.
   */
  stopSequences?: string[];
}
```

- [ ] **Step 4: Extend `buildStreamArgs` in `src/runners/claudeStreamRunner.ts`**

Modify the function to append the new flags AFTER the existing `--output-format stream-json` flag and BEFORE the `--dangerously-skip-permissions` / `--allowed-tools` flag handling so the order matches what tests expect:

```ts
export function buildStreamArgs(opts: ClaudeStreamOptions): string[] {
  const args: string[] = [];
  if (opts.systemPrompt !== undefined) {
    args.push("--system", opts.systemPrompt);
  }
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }
  args.push("-p", opts.prompt);
  args.push("--output-format", "stream-json");
  if (opts.tools && opts.tools.length > 0) {
    args.push("--tools", JSON.stringify(opts.tools));
  }
  if (opts.stopSequences && opts.stopSequences.length > 0) {
    args.push("--stop-sequences", JSON.stringify(opts.stopSequences));
  }
  if (opts.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else if (opts.allowedTools !== undefined) {
    args.push("--allowed-tools", opts.allowedTools);
  }
  return args;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/runners/claudeStreamRunner.test.ts`
Expected: PASS — original Plan-02 tests still green, plus 4 new tests for tools/stopSequences arg construction.

- [ ] **Step 6: Run the full Plan-02/03 suite to confirm no regressions**

Run: `npx vitest run`
Expected: All tests pass; new tests added without breaking existing ones.

- [ ] **Step 7: Commit**

```bash
git add src/runners/types.ts src/runners/claudeStreamRunner.ts tests/unit/runners/claudeStreamRunner.test.ts
git commit -m "feat(runners): add tools + stopSequences to ClaudeStreamOptions and buildStreamArgs"
```

---

## Task 4: Stop-sequence cutter in `claudeStreamRunner`

**Files:**
- Modify: `src/runners/claudeStreamRunner.ts`
- Modify: `tests/unit/runners/claudeStreamRunner.test.ts`

The cutter is the load-bearing piece of `capabilities.stopSequences: "server-side-cut"`. Per the spec:

> the backend's stream runner maintains a rolling tail buffer of `max(stop_seq.length) - 1` bytes across stream chunks. On each new text-content chunk, it searches `(tail + chunk)` for any stop sequence. On match: terminate the CLI subtree via `tree-kill`, truncate accumulated text at the match start, emit `message_stop` with `stop_reason: "stop_sequence"`.

Implementation shape Plan 04 ships:

- A pure helper `createStopSequenceMatcher(stopSequences)` that takes a list of strings, returns an object `{ feed(text: string): { matched: false } | { matched: true; cutAt: number; matchedSequence: string; tailForNext: string } }`. The `cutAt` is the index INTO `text` where the match starts (so the runner can yield the prefix as a text event and then signal the cut). The matcher maintains rolling-tail state internally between calls.
- The runner constructs the matcher once if `opts.stopSequences && opts.stopSequences.length > 0` and otherwise sets it to `null`. Each parsed line that is an assistant message with a text content block runs the matcher on the text. On match: the runner emits a synthesized assistant event carrying ONLY the prefix text, then yields a sentinel `{ type: "_internal", subtype: "stop_sequence_match", matchedSequence: "..." }` event, then `tree-kill`s the child, then breaks the queue-drain loop.

The runner's existing async-iterator contract (yields raw parsed objects) is preserved. The Claude backend (Task 5) is the layer that recognizes `_internal stop_sequence_match` and turns it into the normalized `message_stop` event.

- [ ] **Step 1: Write the failing tests for the matcher helper**

Append to `tests/unit/runners/claudeStreamRunner.test.ts` a brand new describe block:

```ts
import {
  createStopSequenceMatcher
  // (the existing buildStreamArgs and runClaudeStream imports remain)
} from "../../../src/runners/claudeStreamRunner.js";

describe("createStopSequenceMatcher", () => {
  it("returns matched:false when no sequence is present", () => {
    const m = createStopSequenceMatcher(["STOP"]);
    expect(m.feed("hello world")).toEqual({ matched: false });
  });

  it("returns matched:true with cutAt at the sequence start", () => {
    const m = createStopSequenceMatcher(["STOP"]);
    const result = m.feed("hello STOP rest");
    expect(result).toEqual({
      matched: true,
      cutAt: 6,
      matchedSequence: "STOP",
      tailForNext: ""
    });
  });

  it("catches a sequence split across two feed() calls (tail buffer)", () => {
    const m = createStopSequenceMatcher(["STOP"]);
    expect(m.feed("hello STO")).toEqual({ matched: false });
    const result = m.feed("P rest");
    // Match position is in the second chunk, at index 0 (the 'P' completes
    // the sequence that started 3 chars before the chunk boundary).
    expect(result).toEqual({
      matched: true,
      cutAt: 0,
      matchedSequence: "STOP",
      // The matched span overlaps the chunk boundary by 3 chars; the cutter
      // signals the runner so it can truncate the in-flight stream.
      tailForNext: ""
    });
  });

  it("uses max(seq.length) - 1 as the rolling tail size", () => {
    const m = createStopSequenceMatcher(["A", "VERY-LONG-STOP-SEQUENCE"]);
    // Feed text shorter than the longest sequence; matcher should retain
    // up to max-len-1 chars in its tail buffer for the next call.
    expect(m.feed("xyz")).toEqual({ matched: false });
    // Confirm the matcher retained "xyz" by completing the long sequence
    // across the boundary.
    const result = m.feed("VERY-LONG-STOP-SEQUENCE-extra");
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.matchedSequence).toBe("VERY-LONG-STOP-SEQUENCE");
    }
  });

  it("matches the EARLIEST sequence when multiple are present", () => {
    const m = createStopSequenceMatcher(["END", "STOP"]);
    const result = m.feed("hello STOP and END");
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.matchedSequence).toBe("STOP");
      expect(result.cutAt).toBe(6);
    }
  });

  it("returns matched:false on an empty stopSequences list", () => {
    const m = createStopSequenceMatcher([]);
    expect(m.feed("STOP STOP STOP")).toEqual({ matched: false });
  });

  it("zero-length sequence in the list is ignored, not matched everywhere", () => {
    const m = createStopSequenceMatcher(["", "STOP"]);
    expect(m.feed("hello")).toEqual({ matched: false });
    const result = m.feed(" STOP world");
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.matchedSequence).toBe("STOP");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/runners/claudeStreamRunner.test.ts`
Expected: FAIL — `createStopSequenceMatcher` is not exported yet.

- [ ] **Step 3: Implement `createStopSequenceMatcher` in `src/runners/claudeStreamRunner.ts`**

Add the helper near the top of the file (before `buildStreamArgs`):

```ts
export interface StopSequenceMatch {
  matched: true;
  /** Index INTO the chunk passed to feed() where the match starts. */
  cutAt: number;
  matchedSequence: string;
  /**
   * What the matcher's internal tail buffer holds after this match. The
   * runner ignores it on a positive match (it kills the child anyway) but
   * the field is here to keep the public shape symmetrical for tests.
   */
  tailForNext: string;
}

export type StopSequenceFeedResult =
  | { matched: false }
  | StopSequenceMatch;

export interface StopSequenceMatcher {
  feed(chunk: string): StopSequenceFeedResult;
}

/**
 * Build a stateful matcher that tracks a rolling tail across feed() calls so
 * stop sequences split across chunk boundaries are still caught. Pure
 * factory — no side effects, no IO. Exported for direct unit testing.
 */
export function createStopSequenceMatcher(
  stopSequences: readonly string[]
): StopSequenceMatcher {
  const active = stopSequences.filter((s) => s.length > 0);
  const maxLen = active.reduce((m, s) => Math.max(m, s.length), 0);
  const tailSize = Math.max(0, maxLen - 1);
  let tail = "";

  return {
    feed(chunk: string): StopSequenceFeedResult {
      if (active.length === 0) {
        return { matched: false };
      }
      const haystack = tail + chunk;
      let earliest: { idx: number; seq: string } | null = null;
      for (const seq of active) {
        const idx = haystack.indexOf(seq);
        if (idx === -1) continue;
        if (earliest === null || idx < earliest.idx) {
          earliest = { idx, seq };
        }
      }
      if (earliest !== null) {
        // Translate haystack offset back into chunk offset.
        const cutInChunk = Math.max(0, earliest.idx - tail.length);
        tail = "";
        return {
          matched: true,
          cutAt: cutInChunk,
          matchedSequence: earliest.seq,
          tailForNext: ""
        };
      }
      // No match — retain the trailing (tailSize) chars of haystack for the
      // next call.
      tail = haystack.length > tailSize ? haystack.slice(-tailSize) : haystack;
      return { matched: false };
    }
  };
}
```

- [ ] **Step 4: Run the matcher tests to verify they pass**

Run: `npx vitest run tests/unit/runners/claudeStreamRunner.test.ts`
Expected: PASS — 7 new matcher tests green; the earlier 11 tests still pass.

- [ ] **Step 5: Wire the matcher into `runClaudeStream`**

The runner currently emits raw parsed objects without inspection. Plan 04 inserts a thin sniffer:

1. Construct `matcher = opts.stopSequences && opts.stopSequences.length > 0 ? createStopSequenceMatcher(opts.stopSequences) : null` once at the top of `runClaudeStream`.
2. The existing `child.stdout?.on("data", ...)` handler currently pushes each parsed JSON line to the queue verbatim. Replace the push with a sniff step: if `matcher !== null` and the parsed event is `{type: "assistant", message: {content: [{type: "text", text}]}}`, feed `text` to the matcher. On a positive match, mutate the event so its text is `text.slice(0, cutAt)` (so the prefix gets yielded), push the truncated event, push the sentinel `{type: "_internal", subtype: "stop_sequence_match", matchedSequence}`, set `done = true` AND `treeKill(child.pid, "SIGKILL")`, wake the waker, return early from the data handler.
3. Any subsequent stdout data after the kill is dropped on the floor (the buffer flush in `close` handler also respects `done` if already set).

Modify the data handler:

```ts
  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          // Stop-sequence sniff on assistant text content.
          if (matcher !== null && parsed["type"] === "assistant") {
            const message = parsed["message"] as
              | { content?: Array<{ type?: string; text?: string }> }
              | undefined;
            const content = message?.content;
            if (Array.isArray(content)) {
              let cutInfo: StopSequenceMatch | null = null;
              const newContent = content.map((block) => {
                if (cutInfo !== null) return block;
                if (block?.type === "text" && typeof block.text === "string") {
                  const r = matcher.feed(block.text);
                  if (r.matched) {
                    cutInfo = r;
                    return { ...block, text: block.text.slice(0, r.cutAt) };
                  }
                }
                return block;
              });
              if (cutInfo !== null) {
                // Push the truncated event, then the sentinel. Use a fresh
                // object so we don't mutate the caller's parsed view.
                queue.push({ ...parsed, message: { ...message, content: newContent } });
                queue.push({
                  type: "_internal",
                  subtype: "stop_sequence_match",
                  matchedSequence: cutInfo.matchedSequence
                });
                done = true;
                if (child.pid !== undefined) treeKill(child.pid, "SIGKILL");
                else child.kill("SIGKILL");
                wake();
                return;
              }
            }
          }
          queue.push(parsed);
        } catch {
          // Malformed line — skip silently; caller just sees fewer events.
        }
      }
      nl = buffer.indexOf("\n");
    }
    wake();
  });
```

The cast on `cutInfo` matters: `noUncheckedIndexedAccess` doesn't apply here, but the closure capture inside `.map` needs `cutInfo: StopSequenceMatch | null` so TypeScript allows the `cutInfo !== null` short-circuit branch on subsequent iterations.

- [ ] **Step 6: Add the runtime integration test for the cutter**

Append to the `describe("runClaudeStream (against mock-claude)", ...)` block in the same test file:

```ts
  it("emits the _internal stop_sequence_match sentinel when a stop sequence is hit", async () => {
    const events = await collect(
      runClaudeStream({
        prompt: "MOCK_STOP_SEQUENCE_AT(STOP-NOW)",
        stopSequences: ["STOP-NOW"],
        timeoutMs: 10000,
        claudeCommand: MOCK_CLAUDE
      })
    );
    // Find the sentinel.
    const sentinel = events.find(
      (e): e is { type: string; subtype: string; matchedSequence: string } =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "_internal" &&
        (e as { subtype?: string }).subtype === "stop_sequence_match"
    );
    expect(sentinel).toBeDefined();
    expect(sentinel?.matchedSequence).toBe("STOP-NOW");
  });

  it("truncates the text at the match start (the AFTER text is dropped)", async () => {
    const events = await collect(
      runClaudeStream({
        prompt: "MOCK_STOP_SEQUENCE_AT(STOP-NOW)",
        stopSequences: ["STOP-NOW"],
        timeoutMs: 10000,
        claudeCommand: MOCK_CLAUDE
      })
    );
    // Concatenate all text we received before the sentinel.
    const text = events
      .filter(
        (e): e is { type: string; message: { content: Array<{ text?: string }> } } =>
          typeof e === "object" &&
          e !== null &&
          (e as { type?: string }).type === "assistant"
      )
      .flatMap((e) => e.message.content)
      .map((b) => b.text ?? "")
      .join("");
    expect(text).not.toContain("AFTER-SHOULD-BE-DROPPED");
    expect(text).toContain("before ");
    expect(text).toContain("mid");
    expect(text).not.toContain("STOP-NOW");
  });

  it("completes normally when stop sequences are set but never appear", async () => {
    const events = await collect(
      runClaudeStream({
        prompt: "hello",
        stopSequences: ["NEVER-APPEARS"],
        timeoutMs: 5000,
        claudeCommand: MOCK_CLAUDE
      })
    );
    // Should reach the result event normally; no sentinel emitted.
    const sentinel = events.find(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "_internal"
    );
    expect(sentinel).toBeUndefined();
    const last = events[events.length - 1] as { type: string };
    expect(last.type).toBe("result");
  });
```

- [ ] **Step 7: Run the tests to verify everything passes**

Run: `npx vitest run tests/unit/runners/claudeStreamRunner.test.ts`
Expected: PASS — every test green, including the 3 new runtime tests.

- [ ] **Step 8: Commit**

```bash
git add src/runners/claudeStreamRunner.ts tests/unit/runners/claudeStreamRunner.test.ts
git commit -m "feat(runners): add stop-sequence cutter to claudeStreamRunner (rolling tail + tree-kill)"
```

---

## Task 5: `ClaudeBackend.invoke()` — request translation upgrade

**Files:**
- Modify: `src/backends/claudeBackend.ts`
- Modify: `tests/unit/backends/claudeBackend.test.ts`

This is the largest task. Three sub-changes land together (they cross-cut the same function):

1. **Remove `assertPlan02Scope` entirely**, and remove its four `expect.rejects.toThrow` test cases from the unit test.
2. **Extend `foldMessagesToPrompt`** to serialize the four non-text block types (`image`, `document`, `tool_use`, `tool_result`) into the folded prompt with a documented envelope syntax. This is the load-bearing "how we pass images to the Claude CLI" choice — see Open Questions below for the assumption rationale.
3. **Apply `tool_choice` directive** to the system prompt.
4. **Forward `tools`, `stopSequences`** into the stream runner via the options shape extended in Task 3.

The CLI tool-emitted side (tool_use events) lands in Task 6.

### Envelope syntax for non-text content blocks in the folded prompt

The Claude Code CLI's documented interface (`-p`) takes a single prompt string. Image, document, and tool round-trip data must be serialized somehow. Plan 04 ships these envelopes — they're best-effort and may need revision once the real CLI surface is validated end-to-end (see Open Questions):

```
[image:<mediaType>;base64,<data>]
[document:<mediaType>;base64,<data>]
[tool_use:<id>:<name>]<json-input>[/tool_use]
[tool_result:<tool_use_id>]<content>[/tool_result]
```

These are inlined into the message body at the position of the original block, with no extra whitespace. The model receives them as plain text and the user-supplied system prompt should explain semantics when needed (the spec accepts that the CLI may interpret these as plain text rather than as native multimodal payloads — that's why `BackendCapabilities.multimodal` is "conservative true" in Plan 02, not "guaranteed true").

- [ ] **Step 1: Update the Plan-02 test expectations**

In `tests/unit/backends/claudeBackend.test.ts`:

1. **Delete** the two `it("invoke throws on multimodal content ...", ...)` and `it("invoke throws on tools array ...", ...)` test cases that Plan 02 added.
2. **Add** the new behavior tests at the end of the existing `describe("ClaudeBackend skeleton", ...)` block:

```ts
  it("invoke forwards tools to the CLI via --tools flag", async () => {
    // The mock-claude fixture doesn't inspect --tools by default, but we can
    // catch the arg via the MOCK_VISION_REQUEST trigger which writes a
    // receipt to stderr containing toolsFlag.
    // (We use VISION_REQUEST as a generic "argv inspection" trigger here.)
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    // Collect stderr by spawning a side process — instead, we'll trust that
    // Task 3's buildStreamArgs unit test already covers the arg construction
    // path. Here we just confirm the request flows through without throwing.
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: [{ type: "text", text: "MOCK_VISION_REQUEST" }] }],
      tools: [
        {
          name: "calculator",
          description: "Adds two numbers",
          inputSchema: { type: "object" }
        }
      ]
    })) {
      events.push(ev);
    }
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke inlines an image content block into the folded prompt", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    // The mock echoes the inbound prompt back. Confirm the envelope made it
    // through.
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image", mediaType: "image/png", data: "AAAAAA" }
          ]
        }
      ]
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toContain("[image:image/png;base64,AAAAAA]");
  });

  it("invoke inlines a document content block into the folded prompt", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "document", mediaType: "application/pdf", data: "JVBERi0=" }
          ]
        }
      ]
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toContain("[document:application/pdf;base64,JVBERi0=]");
  });

  it("invoke re-inlines a tool_result block into the folded prompt", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: [{ type: "text", text: "compute" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "calc", input: { x: 1, y: 2 } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "t1", content: "3" },
            { type: "text", text: "MOCK_TOOL_RESULT_ECHO" }
          ]
        }
      ]
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toContain("echo[tool_result:t1]=3");
  });

  it("invoke appends tool_choice 'any' directive to system prompt", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      system: "be precise",
      toolChoice: "any",
      tools: [{ name: "calc", inputSchema: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    // The mock echoes the system prompt prefix when set.
    expect(text).toContain("[system: be precise");
    expect(text).toMatch(/must call exactly one tool/i);
  });

  it("invoke appends tool_choice 'none' directive", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      system: "be terse",
      toolChoice: "none",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toMatch(/do not call any tools/i);
  });

  it("invoke appends tool_choice named-tool directive", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      system: "go",
      toolChoice: { type: "tool", name: "calculator" },
      tools: [{ name: "calculator", inputSchema: {} }, { name: "search", inputSchema: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toMatch(/only call ['`]?calculator['`]?/i);
  });

  it("invoke for tool_choice 'auto' does NOT append any directive", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      system: "verbatim-system-prompt-marker",
      toolChoice: "auto",
      tools: [{ name: "calc", inputSchema: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toContain("verbatim-system-prompt-marker");
    // No additional sentences after the user system text.
    expect(text).not.toMatch(/(must call|do not call|only call)/i);
  });

  it("invoke emits message_stop with stopReason 'stop_sequence' when matched", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 10000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: [{ type: "text", text: "MOCK_STOP_SEQUENCE_AT(STOP-NOW)" }] }
      ],
      stopSequences: ["STOP-NOW"]
    })) {
      events.push(ev);
    }
    const stop = events[events.length - 1];
    expect(stop?.kind).toBe("message_stop");
    if (stop?.kind === "message_stop") {
      expect(stop.stopReason).toBe("stop_sequence");
    }
    // Text accumulated before the cut should NOT contain the sequence itself.
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).not.toContain("STOP-NOW");
    expect(text).not.toContain("AFTER-SHOULD-BE-DROPPED");
  });
```

(Note: the `tests/unit/backends/claudeBackend.test.ts` file already imports `join`, `dirname`, `fileURLToPath`, and `NormalizedEvent` from earlier tasks.)

- [ ] **Step 2: Delete the Plan-02 fail-loud tests**

In the same test file, find and **delete**:
- `it("invoke throws on multimodal content (Plan 02 scope is text-only)", ...)`
- `it("invoke throws on tools array (Plan 02 scope is no-tools)", ...)`

These tests document behavior Plan 04 explicitly removes; keeping them around as `.skip` would be noise.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/backends/claudeBackend.test.ts`
Expected: FAIL — many new tests fail with `assertPlan02Scope`-related throws or wrong-output mismatches.

- [ ] **Step 4: Rewrite the relevant helpers in `src/backends/claudeBackend.ts`**

Remove `private assertPlan02Scope(req)` entirely (delete the method body).

Replace `foldMessagesToPrompt`:

```ts
  /**
   * Serialize a NormalizedRequest's message history into a single prompt
   * string suitable for the Claude CLI's `-p <prompt>` flag.
   *
   * Each message gets a leading `<role>:` line. Within a message, content
   * blocks are concatenated in order. Non-text blocks use envelope markers
   * that the CLI sees as plain text but a downstream model can recognize:
   *   [image:<mediaType>;base64,<data>]
   *   [document:<mediaType>;base64,<data>]
   *   [tool_use:<id>:<name>]<json-input>[/tool_use]
   *   [tool_result:<tool_use_id>]<content>[/tool_result]
   *
   * Empty messages (no usable content after serialization) are skipped.
   */
  private foldMessagesToPrompt(req: NormalizedRequest): string {
    const lines: string[] = [];
    for (const msg of req.messages) {
      const parts: string[] = [];
      for (const block of msg.content) {
        switch (block.type) {
          case "text":
            if (block.text.length > 0) parts.push(block.text);
            break;
          case "image":
            parts.push(`[image:${block.mediaType};base64,${block.data}]`);
            break;
          case "document":
            parts.push(`[document:${block.mediaType};base64,${block.data}]`);
            break;
          case "tool_use":
            parts.push(
              `[tool_use:${block.id}:${block.name}]${JSON.stringify(block.input)}[/tool_use]`
            );
            break;
          case "tool_result":
            parts.push(
              `[tool_result:${block.toolUseId}]${block.content}[/tool_result]`
            );
            break;
        }
      }
      if (parts.length === 0) continue;
      lines.push(`${msg.role}: ${parts.join("\n")}`);
    }
    return lines.join("\n\n");
  }
```

Add the `applyToolChoiceDirective` helper:

```ts
  /**
   * Append the tool_choice system directive per the spec's enforcement
   * table. Best-effort — the model usually honors but the CLI has no flag
   * to force a specific tool name. Returns the system prompt unchanged for
   * tool_choice "auto" or undefined.
   */
  private applyToolChoiceDirective(
    system: string | undefined,
    toolChoice: NormalizedRequest["toolChoice"]
  ): string | undefined {
    if (toolChoice === undefined || toolChoice === "auto") {
      return system;
    }
    let directive: string;
    if (toolChoice === "any") {
      directive = "You must call exactly one tool this turn.";
    } else if (toolChoice === "none") {
      directive = "Do not call any tools this turn.";
    } else {
      // toolChoice is { type: "tool", name: "..." }
      directive = `If you call a tool, only call \`${toolChoice.name}\`.`;
    }
    if (!system || system.length === 0) return directive;
    return `${system}\n\n${directive}`;
  }
```

Modify `invoke()` to drop `assertPlan02Scope` and forward the new options:

```ts
  async *invoke(
    req: NormalizedRequest
  ): AsyncIterable<NormalizedEvent> {
    const streamOpts: ClaudeStreamOptions = {
      prompt: this.foldMessagesToPrompt(req),
      systemPrompt: this.applyToolChoiceDirective(req.system, req.toolChoice),
      tools: req.tools,
      stopSequences: req.stopSequences,
      timeoutMs: this.config.timeoutMs,
      claudeCommand: this.config.command,
      dangerouslySkipPermissions: true
    };

    let startEmitted = false;
    let textIndex = 0;
    let textOpen = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: Extract<NormalizedEvent, { kind: "message_stop" }>["stopReason"] =
      "end_turn";

    // ---- Task 6 lands tool_use_* event emission here ---------------------
    // ---- Task 6 lands sentinel-to-message_stop translation here ----------

    for await (const raw of runClaudeStream(streamOpts)) {
      const ev = raw as {
        type?: string;
        subtype?: string;
        session_id?: string;
        model?: string;
        message?: { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }> };
        usage?: { input_tokens?: number; output_tokens?: number };
        is_error?: boolean;
        matchedSequence?: string;
      };

      // Stop-sequence sentinel (from claudeStreamRunner cutter).
      if (ev.type === "_internal" && ev.subtype === "stop_sequence_match") {
        if (textOpen) {
          textIndex++;
          textOpen = false;
        }
        if (!startEmitted) {
          startEmitted = true;
          yield { kind: "message_start", model: req.model };
        }
        yield {
          kind: "message_stop",
          stopReason: "stop_sequence",
          usage: inputTokens + outputTokens > 0
            ? { inputTokens, outputTokens }
            : undefined
        };
        return;
      }

      if (ev.type === "system" && ev.subtype === "init") {
        if (!startEmitted) {
          startEmitted = true;
          yield { kind: "message_start", model: ev.model ?? req.model };
        }
        continue;
      }

      if (ev.type === "assistant" && ev.message?.content) {
        if (!startEmitted) {
          startEmitted = true;
          yield { kind: "message_start", model: req.model };
        }
        for (const block of ev.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            // Empty-text blocks happen when the cutter truncated at offset 0;
            // skip them so we don't emit a zero-byte text_delta.
            if (block.text.length === 0) continue;
            yield { kind: "text_delta", index: textIndex, text: block.text };
            textOpen = true;
          }
          // tool_use blocks: Task 6 wires the start/delta/stop emission here.
        }
        continue;
      }

      if (ev.type === "result") {
        if (ev.usage) {
          inputTokens = ev.usage.input_tokens ?? 0;
          outputTokens = ev.usage.output_tokens ?? 0;
        }
        if (textOpen) {
          textIndex++;
          textOpen = false;
        }
        if (!startEmitted) {
          startEmitted = true;
          yield { kind: "message_start", model: req.model };
        }
        yield {
          kind: "message_stop",
          stopReason: ev.is_error ? "error" : stopReason,
          usage: inputTokens + outputTokens > 0
            ? { inputTokens, outputTokens }
            : undefined
        };
        return;
      }
    }

    if (!startEmitted) {
      yield { kind: "message_start", model: req.model };
    }
    yield { kind: "message_stop", stopReason: "error" };
  }
```

The `stopReason` variable defaulting to `"end_turn"` is in place so Task 6 can set it to `"tool_use"` when a `tool_use` content block flows through. Plan 04 keeps `"end_turn"` as the default for now.

Also update `countTokens` / `sumRequestTokens` to keep counting `image` and `document` blocks consistent with Plan 03's `estimateRequestTokens` placeholders (Plan 02's `sumRequestTokens` skipped them — Plan 04 aligns by delegating to the central estimator):

```ts
// At the top of the file, add the import:
import { estimateRequestTokens } from "../tokenEstimator.js";

// Then replace the sumRequestTokens function and the countTokens body:
async countTokens(req: NormalizedRequest): Promise<number> {
  return estimateRequestTokens(req);
}
```

Delete the local `sumRequestTokens` helper — `estimateRequestTokens` from Plan 03 now does the work for both Plan-03's countTokens endpoint and Plan-04's backend tokenization.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/backends/claudeBackend.test.ts`
Expected: PASS — all 18+ tests green (the 13 Plan-02 tests minus the 2 deleted, plus 9 new). The two `countTokens` tests Plan 02 wrote will now match `estimateRequestTokens` numbers instead of the old `sumRequestTokens` numbers; if their expected values shift slightly (e.g., the system-prompt-plus-messages test), update them to match the central estimator's output (they should already match because Plan 03's estimator uses the same char/4 ceiling formula).

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: All tests green. The integration test from Plan 02 (`tests/integration/claudeBackend.test.ts`) should still pass.

- [ ] **Step 7: Commit**

```bash
git add src/backends/claudeBackend.ts tests/unit/backends/claudeBackend.test.ts
git commit -m "feat(claudeBackend): remove Plan-02 scope guard; add tools, tool_choice, multimodal, stop_sequences"
```

---

## Task 6: `ClaudeBackend.invoke()` — emit `tool_use_*` events for CLI tool_use blocks

**Files:**
- Modify: `src/backends/claudeBackend.ts`
- Modify: `tests/unit/backends/claudeBackend.test.ts`

When Claude's `stream-json` emits an assistant message with a `tool_use` content block, the backend must translate it into the Plan-01 `tool_use_start` / `tool_use_delta` / `tool_use_stop` `NormalizedEvent` triple. The mock-claude fixture (extended in Task 2) emits a single fully-formed `tool_use` block via its `MOCK_TOOL_USE(...)` trigger; the backend needs to:

1. Increment the per-block index.
2. Yield `tool_use_start` with `id` and `name`.
3. Yield `tool_use_delta` with the full `JSON.stringify(input)` (real Claude streams `input_json_delta` chunks; the mock sends one big delta — both shapes work).
4. Yield `tool_use_stop` to close the block.
5. Set the running `stopReason` to `"tool_use"` so the final `message_stop` reports it correctly.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/backends/claudeBackend.test.ts`:

```ts
  it("invoke emits tool_use_start + tool_use_delta + tool_use_stop for CLI tool_use blocks", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: 'MOCK_TOOL_USE(calculator,toolu_42,{"x":1,"y":2})' }
          ]
        }
      ],
      tools: [{ name: "calculator", inputSchema: {} }]
    })) {
      events.push(ev);
    }
    const starts = events.filter((e) => e.kind === "tool_use_start");
    const deltas = events.filter((e) => e.kind === "tool_use_delta");
    const stops = events.filter((e) => e.kind === "tool_use_stop");
    expect(starts).toHaveLength(1);
    expect(deltas).toHaveLength(1);
    expect(stops).toHaveLength(1);
    if (starts[0]?.kind === "tool_use_start") {
      expect(starts[0].id).toBe("toolu_42");
      expect(starts[0].name).toBe("calculator");
    }
    if (deltas[0]?.kind === "tool_use_delta") {
      expect(JSON.parse(deltas[0].partialJson)).toEqual({ x: 1, y: 2 });
    }
    const stop = events[events.length - 1];
    expect(stop?.kind).toBe("message_stop");
    if (stop?.kind === "message_stop") {
      expect(stop.stopReason).toBe("tool_use");
    }
  });

  it("invoke assigns sequential indexes to mixed text + tool_use blocks", async () => {
    // This test exercises the index-bookkeeping logic. Currently the mock
    // doesn't emit interleaved text + tool_use in a single stream — confirm
    // the bookkeeping invariants instead: a tool_use block claims its own
    // index, distinct from text indexes.
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: 'MOCK_TOOL_USE(calc,toolu_1,{"a":1})' }
          ]
        }
      ],
      tools: [{ name: "calc", inputSchema: {} }]
    })) {
      events.push(ev);
    }
    const useStart = events.find((e) => e.kind === "tool_use_start");
    if (useStart?.kind === "tool_use_start") {
      // First emitted block index is 0 (no preceding text block in this stream).
      expect(useStart.index).toBe(0);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/backends/claudeBackend.test.ts`
Expected: FAIL — the backend doesn't yet emit `tool_use_*` events.

- [ ] **Step 3: Extend the assistant-content branch in `invoke()`**

In `src/backends/claudeBackend.ts`, inside the `if (ev.type === "assistant" && ev.message?.content)` branch, replace the inner for-loop body so that text blocks AND tool_use blocks each get handled:

```ts
        for (const block of ev.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            if (block.text.length === 0) continue;
            if (textOpen) {
              // Keep the same textIndex — a continuation of the same block.
            } else {
              textOpen = true;
            }
            yield { kind: "text_delta", index: textIndex, text: block.text };
          } else if (
            block.type === "tool_use" &&
            typeof block.id === "string" &&
            typeof block.name === "string"
          ) {
            // Close any open text block first so tool_use claims a fresh index.
            if (textOpen) {
              textIndex++;
              textOpen = false;
            }
            const useIndex = textIndex;
            textIndex++;
            yield {
              kind: "tool_use_start",
              index: useIndex,
              id: block.id,
              name: block.name
            };
            yield {
              kind: "tool_use_delta",
              index: useIndex,
              partialJson: JSON.stringify(block.input ?? {})
            };
            yield { kind: "tool_use_stop", index: useIndex };
            stopReason = "tool_use";
          }
        }
```

(`stopReason` was already declared at the top of `invoke()` in Task 5.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/backends/claudeBackend.test.ts`
Expected: PASS — all backend tests green.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: All tests green.

- [ ] **Step 6: Commit**

```bash
git add src/backends/claudeBackend.ts tests/unit/backends/claudeBackend.test.ts
git commit -m "feat(claudeBackend): emit tool_use_start/delta/stop NormalizedEvents for CLI tool_use blocks"
```

---

## Task 7: Request translator — passthroughs for image/document/tool_use/tool_result/tools/tool_choice/stop_sequences

**Files:**
- Modify: `src/anthropicShim/requestTranslator.ts`
- Modify: `tests/unit/anthropicShim/requestTranslator.test.ts`

Replace the Plan-03 fail-loud branches with real translation into the Plan-01 normalized shapes. The existing rejections for `cache_control`, `thinking`, and `file` source references (the latter being a `file_<hash>` source on an image/document block) stay in place — those land in Plan 05.

- [ ] **Step 1: Delete the Plan-03 fail-loud tests and replace them**

In `tests/unit/anthropicShim/requestTranslator.test.ts`, find the `describe("anthropicRequestToNormalized — Plan 03 scope rejections", ...)` block. **Delete** the following tests:

- `it("rejects image content blocks", ...)`
- `it("rejects document content blocks", ...)`
- `it("rejects tool_use content blocks in the request", ...)`
- `it("rejects tool_result content blocks in the request", ...)`
- `it("rejects non-empty tools field", ...)`
- `it("rejects tool_choice field when present", ...)`
- `it("rejects non-empty stop_sequences", ...)`

**Keep** the following tests in that block:

- `it("rejects thinking field", ...)`
- `it("rejects cache_control on a content block", ...)`
- `it("accepts empty stop_sequences array (treated as not supplied)", ...)`
- `it("accepts empty tools array (treated as not supplied)", ...)`

Add a new `describe` block for the passthroughs:

```ts
describe("anthropicRequestToNormalized — Plan 04 passthroughs", () => {
  it("translates an image content block with base64 source", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAAAA" }
            }
          ]
        }
      ]
    });
    expect(out.messages[0]?.content).toEqual([
      { type: "text", text: "describe" },
      { type: "image", mediaType: "image/png", data: "AAAAAA" }
    ]);
  });

  it("translates a document content block with base64 source", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" }
            }
          ]
        }
      ]
    });
    expect(out.messages[0]?.content).toEqual([
      { type: "document", mediaType: "application/pdf", data: "JVBERi0=" }
    ]);
  });

  it("rejects image source.type 'url' (lands in Plan 05 — fetch + inline)", () => {
    expect(() =>
      anthropicRequestToNormalized({
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [{ type: "image", source: { type: "url", url: "https://example.com/x.png" } }]
          }
        ]
      })
    ).toThrow(/url|source/i);
  });

  it("rejects image source.type 'file' (file_<hash> resolution lands in Plan 05)", () => {
    expect(() =>
      anthropicRequestToNormalized({
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [{ type: "image", source: { type: "file", file_id: "file_abc" } }]
          }
        ]
      })
    ).toThrow(/file|source/i);
  });

  it("translates a tool_use content block in an assistant message", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "compute" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "calc", input: { x: 1, y: 2 } }
          ]
        }
      ]
    });
    expect(out.messages[1]?.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "calc", input: { x: 1, y: 2 } }
    ]);
  });

  it("translates a tool_result with string content shorthand", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "3" }]
        }
      ]
    });
    expect(out.messages[0]?.content).toEqual([
      { type: "tool_result", toolUseId: "toolu_1", content: "3" }
    ]);
  });

  it("translates a tool_result with content-block array (joins text)", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "text", text: "result" },
                { type: "text", text: ": 3" }
              ]
            }
          ]
        }
      ]
    });
    expect(out.messages[0]?.content).toEqual([
      { type: "tool_result", toolUseId: "toolu_1", content: "result\n: 3" }
    ]);
  });

  it("translates the tools array", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "calculator",
          description: "Adds two numbers",
          input_schema: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" } }
          }
        }
      ]
    });
    expect(out.tools).toEqual([
      {
        name: "calculator",
        description: "Adds two numbers",
        inputSchema: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } }
        }
      }
    ]);
  });

  it("translates tool_choice 'auto' / 'any' / 'none' / named", () => {
    const auto = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "auto" }
    });
    expect(auto.toolChoice).toBe("auto");
    const any = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "any" }
    });
    expect(any.toolChoice).toBe("any");
    const none = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "none" }
    });
    expect(none.toolChoice).toBe("none");
    const named = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "tool", name: "calc" }
    });
    expect(named.toolChoice).toEqual({ type: "tool", name: "calc" });
  });

  it("translates stop_sequences", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      stop_sequences: ["STOP", "END"]
    });
    expect(out.stopSequences).toEqual(["STOP", "END"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/anthropicShim/requestTranslator.test.ts`
Expected: FAIL — translator still throws on image/document/tool_use/tool_result.

- [ ] **Step 3: Rewrite the relevant branches in `src/anthropicShim/requestTranslator.ts`**

Replace `normalizeContentBlock`:

```ts
function normalizeContentBlock(block: AnthropicContentBlock): NormalizedContentBlock {
  if (!isRecord(block) || typeof block["type"] !== "string") {
    bad("content block must have a string type field");
  }
  if (isRecord(block) && "cache_control" in block) {
    bad("cache_control is not supported in Plan 04 (lands in Plan 05)");
  }

  const t = (block as { type: string }).type;
  switch (t) {
    case "text": {
      const text = (block as { text?: unknown }).text;
      if (typeof text !== "string") bad("text content block requires a string text field");
      return { type: "text", text };
    }
    case "image": {
      const source = (block as { source?: unknown }).source;
      if (!isRecord(source)) bad("image content block requires a source object");
      const srcType = source["type"];
      if (srcType === "url") {
        bad("image source.type 'url' is not supported (URL fetching lands in Plan 05)");
      }
      if (srcType === "file") {
        bad("image source.type 'file' is not supported (file_<hash> resolution lands in Plan 05)");
      }
      if (srcType !== "base64") bad(`unsupported image source.type: ${String(srcType)}`);
      const mediaType = source["media_type"];
      const data = source["data"];
      if (typeof mediaType !== "string") bad("image source requires a string media_type");
      if (typeof data !== "string") bad("image source requires a string data");
      return { type: "image", mediaType, data };
    }
    case "document": {
      const source = (block as { source?: unknown }).source;
      if (!isRecord(source)) bad("document content block requires a source object");
      const srcType = source["type"];
      if (srcType === "url") {
        bad("document source.type 'url' is not supported (URL fetching lands in Plan 05)");
      }
      if (srcType === "file") {
        bad(
          "document source.type 'file' is not supported (file_<hash> resolution lands in Plan 05)"
        );
      }
      if (srcType !== "base64") bad(`unsupported document source.type: ${String(srcType)}`);
      const mediaType = source["media_type"];
      const data = source["data"];
      if (typeof mediaType !== "string") bad("document source requires a string media_type");
      if (typeof data !== "string") bad("document source requires a string data");
      return { type: "document", mediaType, data };
    }
    case "tool_use": {
      const id = (block as { id?: unknown }).id;
      const name = (block as { name?: unknown }).name;
      const input = (block as { input?: unknown }).input;
      if (typeof id !== "string") bad("tool_use content block requires a string id");
      if (typeof name !== "string") bad("tool_use content block requires a string name");
      return { type: "tool_use", id, name, input };
    }
    case "tool_result": {
      const toolUseId = (block as { tool_use_id?: unknown }).tool_use_id;
      if (typeof toolUseId !== "string") {
        bad("tool_result content block requires a string tool_use_id");
      }
      const rawContent = (block as { content?: unknown }).content;
      let content: string;
      if (typeof rawContent === "string") {
        content = rawContent;
      } else if (Array.isArray(rawContent)) {
        const parts: string[] = [];
        for (const part of rawContent) {
          if (
            isRecord(part) &&
            part["type"] === "text" &&
            typeof part["text"] === "string"
          ) {
            parts.push(part["text"] as string);
          } else {
            bad("tool_result.content array entries must be text blocks");
          }
        }
        content = parts.join("\n");
      } else {
        bad("tool_result.content must be a string or an array of text blocks");
      }
      return { type: "tool_result", toolUseId, content };
    }
    default:
      bad(`unknown content block type: ${t}`);
  }
}
```

Replace the top-level translator's scope guards. Find the existing block:

```ts
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    bad("tools is not supported in Plan 03 (native tool round-trip lands in Plan 04)");
  }
  if ("tool_choice" in body && body.tool_choice !== undefined) {
    bad("tool_choice is not supported in Plan 03 (native tool round-trip lands in Plan 04)");
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    bad("stop_sequences is not supported in Plan 03 (server-side cut lands in Plan 04)");
  }
```

Replace with the translation logic. Add helper functions above the main translator:

```ts
function normalizeToolDef(def: unknown): NormalizedToolDef {
  if (!isRecord(def)) bad("each tool must be an object");
  const name = def["name"];
  if (typeof name !== "string" || name.length === 0) {
    bad("tool.name is required and must be a non-empty string");
  }
  const inputSchema = def["input_schema"];
  if (inputSchema === undefined) bad(`tool ${name} requires input_schema`);
  const out: NormalizedToolDef = { name, inputSchema };
  if (typeof def["description"] === "string") out.description = def["description"];
  return out;
}

function normalizeToolChoice(choice: unknown): NormalizedToolChoice {
  if (!isRecord(choice)) bad("tool_choice must be an object");
  const t = choice["type"];
  if (t === "auto") return "auto";
  if (t === "any") return "any";
  if (t === "none") return "none";
  if (t === "tool") {
    const name = choice["name"];
    if (typeof name !== "string" || name.length === 0) {
      bad("tool_choice.name is required when tool_choice.type is 'tool'");
    }
    return { type: "tool", name };
  }
  bad(`unsupported tool_choice.type: ${String(t)}`);
}
```

Then in the main translator, replace the rejecting branches with:

```ts
  // tools
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) bad("tools must be an array");
    if (body.tools.length > 0) {
      out.tools = body.tools.map(normalizeToolDef);
    }
  }

  // tool_choice
  if (body.tool_choice !== undefined) {
    out.toolChoice = normalizeToolChoice(body.tool_choice);
  }

  // stop_sequences
  if (body.stop_sequences !== undefined) {
    if (!Array.isArray(body.stop_sequences)) bad("stop_sequences must be an array");
    if (body.stop_sequences.length > 0) {
      for (const s of body.stop_sequences) {
        if (typeof s !== "string") bad("stop_sequences entries must be strings");
      }
      out.stopSequences = body.stop_sequences as string[];
    }
  }
```

These slot in AFTER the `out` object is constructed (move them just before the `return out;` line). Add the necessary imports at the top of the file:

```ts
import type {
  NormalizedContentBlock,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedToolChoice,
  NormalizedToolDef
} from "../backends/types.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/anthropicShim/requestTranslator.test.ts`
Expected: PASS — all tests green. The deleted Plan-03 rejection tests are gone; the new passthroughs and the retained `thinking` / `cache_control` rejections all pass.

- [ ] **Step 5: Commit**

```bash
git add src/anthropicShim/requestTranslator.ts tests/unit/anthropicShim/requestTranslator.test.ts
git commit -m "feat(anthropicShim): pass image/document/tool_use/tool_result/tools/tool_choice/stop_sequences through translator"
```

---

## Task 8: Response translator — emit `tool_use` SSE + aggregate `tool_use` content blocks

**Files:**
- Modify: `src/anthropicShim/responseTranslator.ts`
- Modify: `tests/unit/anthropicShim/responseTranslator.test.ts`

The streaming side: `tool_use_start` → `content_block_start` with `content_block: { type: "tool_use", id, name, input: {} }`. `tool_use_delta` → `content_block_delta` with `delta: { type: "input_json_delta", partial_json: "..." }`. `tool_use_stop` → `content_block_stop`. The aggregation needs to track each `tool_use` block's accumulated partial JSON across deltas; on the closing event (or on synthesized close at end-of-stream), parse the accumulated JSON into a real object for the non-streaming response body.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/anthropicShim/responseTranslator.test.ts`:

```ts
describe("normalizedEventsToSSE — tool_use blocks", () => {
  it("emits content_block_start with type tool_use and empty input", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "tool_use_start", index: 0, id: "toolu_42", name: "calculator" },
      { kind: "tool_use_delta", index: 0, partialJson: '{"x":1,"y":2}' },
      { kind: "tool_use_stop", index: 0 },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const parsed = chunks.map(parseSseChunk);
    expect(parsed.map((p) => p.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]);
    expect(parsed[1]?.data).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_42", name: "calculator", input: {} }
    });
  });

  it("emits content_block_delta with input_json_delta carrying the partial JSON", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "tool_use_start", index: 0, id: "toolu_1", name: "fn" },
      { kind: "tool_use_delta", index: 0, partialJson: '{"x":' },
      { kind: "tool_use_delta", index: 0, partialJson: "1}" },
      { kind: "tool_use_stop", index: 0 },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const deltas = chunks
      .map(parseSseChunk)
      .filter((p) => p.event === "content_block_delta")
      .map((p) => p.data) as Array<{ delta: { type: string; partial_json: string } }>;
    expect(deltas).toHaveLength(2);
    expect(deltas[0]?.delta).toEqual({ type: "input_json_delta", partial_json: '{"x":' });
    expect(deltas[1]?.delta).toEqual({ type: "input_json_delta", partial_json: "1}" });
  });

  it("maps stopReason 'stop_sequence' → stop_reason 'stop_sequence' on the wire", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "partial" },
      { kind: "message_stop", stopReason: "stop_sequence" }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const messageDelta = chunks
      .map(parseSseChunk)
      .find((p) => p.event === "message_delta");
    expect(messageDelta).toBeDefined();
    expect(
      (messageDelta?.data as { delta: { stop_reason: string } }).delta.stop_reason
    ).toBe("stop_sequence");
  });

  it("handles interleaved text and tool_use blocks with separate indexes", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "let me compute: " },
      { kind: "tool_use_start", index: 1, id: "toolu_1", name: "calc" },
      { kind: "tool_use_delta", index: 1, partialJson: '{"x":3}' },
      { kind: "tool_use_stop", index: 1 },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const sequence = chunks.map(parseSseChunk).map((p) => p.event);
    expect(sequence).toEqual([
      "message_start",
      "content_block_start", // index 0 text
      "content_block_delta", // index 0 text delta
      "content_block_start", // index 1 tool_use
      "content_block_delta", // index 1 input_json_delta
      "content_block_stop", // index 1 tool_use_stop
      "content_block_stop", // index 0 text auto-close
      "message_delta",
      "message_stop"
    ]);
  });
});

describe("normalizedEventsToFinalResponse — tool_use aggregation", () => {
  it("aggregates a tool_use block into content[] with parsed input", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "tool_use_start", index: 0, id: "toolu_1", name: "calc" },
      { kind: "tool_use_delta", index: 0, partialJson: '{"x":1,' },
      { kind: "tool_use_delta", index: 0, partialJson: '"y":2}' },
      { kind: "tool_use_stop", index: 0 },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const resp = await normalizedEventsToFinalResponse(fromArray(events), META);
    expect(resp.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "calc", input: { x: 1, y: 2 } }
    ]);
    expect(resp.stop_reason).toBe("tool_use");
  });

  it("aggregates mixed text and tool_use blocks in order", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "computing now: " },
      { kind: "tool_use_start", index: 1, id: "toolu_1", name: "calc" },
      { kind: "tool_use_delta", index: 1, partialJson: '{"x":5}' },
      { kind: "tool_use_stop", index: 1 },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const resp = await normalizedEventsToFinalResponse(fromArray(events), META);
    expect(resp.content).toEqual([
      { type: "text", text: "computing now: " },
      { type: "tool_use", id: "toolu_1", name: "calc", input: { x: 5 } }
    ]);
  });

  it("falls back to raw string input if accumulated JSON is unparseable", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "tool_use_start", index: 0, id: "toolu_1", name: "calc" },
      { kind: "tool_use_delta", index: 0, partialJson: "this is not json" },
      { kind: "tool_use_stop", index: 0 },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const resp = await normalizedEventsToFinalResponse(fromArray(events), META);
    // The aggregator preserves the raw partial JSON as a string under input
    // when JSON.parse fails — this is a best-effort recovery so a malformed
    // upstream doesn't surface as a 500.
    expect(resp.content[0]).toEqual({
      type: "tool_use",
      id: "toolu_1",
      name: "calc",
      input: "this is not json"
    });
  });

  it("maps stop_reason 'stop_sequence' to the response body", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "partial" },
      { kind: "message_stop", stopReason: "stop_sequence" }
    ];
    const resp = await normalizedEventsToFinalResponse(fromArray(events), META);
    expect(resp.stop_reason).toBe("stop_sequence");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/anthropicShim/responseTranslator.test.ts`
Expected: FAIL — translator currently ignores `tool_use_*` events.

- [ ] **Step 3: Extend `src/anthropicShim/responseTranslator.ts`**

Add tracking state for tool_use blocks in `normalizedEventsToSSE` and emit the right events. Replace the streaming loop body with:

```ts
  // openBlocks tracks index → block kind so the close-up code knows what
  // shape of content_block_stop to emit (Anthropic uses the same shape
  // regardless, but the bookkeeping matters for content_block_start dedupe).
  const openBlocks = new Map<number, "text" | "tool_use">();

  // ... (rest of state declarations unchanged)

  for await (const ev of events) {
    if (ev.kind === "message_start") {
      const chunk = ensureStart(ev.model || meta.model);
      if (chunk) yield chunk;
      continue;
    }

    if (ev.kind === "text_delta") {
      const chunk = ensureStart(meta.model);
      if (chunk) yield chunk;
      if (!openBlocks.has(ev.index)) {
        openBlocks.set(ev.index, "text");
        yield sse("content_block_start", {
          type: "content_block_start",
          index: ev.index,
          content_block: { type: "text", text: "" }
        });
      }
      yield sse("content_block_delta", {
        type: "content_block_delta",
        index: ev.index,
        delta: { type: "text_delta", text: ev.text }
      });
      continue;
    }

    if (ev.kind === "tool_use_start") {
      const chunk = ensureStart(meta.model);
      if (chunk) yield chunk;
      openBlocks.set(ev.index, "tool_use");
      yield sse("content_block_start", {
        type: "content_block_start",
        index: ev.index,
        content_block: { type: "tool_use", id: ev.id, name: ev.name, input: {} }
      });
      continue;
    }

    if (ev.kind === "tool_use_delta") {
      // No ensureStart — a tool_use_delta without a preceding tool_use_start
      // is malformed, but tolerate it by treating it as a stale event.
      if (!openBlocks.has(ev.index)) continue;
      yield sse("content_block_delta", {
        type: "content_block_delta",
        index: ev.index,
        delta: { type: "input_json_delta", partial_json: ev.partialJson }
      });
      continue;
    }

    if (ev.kind === "tool_use_stop") {
      if (!openBlocks.has(ev.index)) continue;
      openBlocks.delete(ev.index);
      yield sse("content_block_stop", {
        type: "content_block_stop",
        index: ev.index
      });
      continue;
    }

    if (ev.kind === "message_stop") {
      const chunk = ensureStart(meta.model);
      if (chunk) yield chunk;
      for (const idx of [...openBlocks.keys()].sort((a, b) => a - b)) {
        yield sse("content_block_stop", {
          type: "content_block_stop",
          index: idx
        });
      }
      openBlocks.clear();
      stopReason = mapStopReason(ev.stopReason);
      outputTokens = ev.usage?.outputTokens ?? 0;
      yield sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens }
      });
      yield sse("message_stop", { type: "message_stop" });
      messageStopSent = true;
      return;
    }
  }
```

Update the synthesized close at end-of-stream to use the same Map iteration. The existing logic that synthesizes the missing message_stop should also iterate `openBlocks.keys()` instead of the old Set.

For `normalizedEventsToFinalResponse`, swap the `Map<number, string>` accumulator for a `Map<number, BlockState>` where `BlockState` carries both text and tool_use shape:

```ts
type BlockState =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; partialJson: string };

export async function normalizedEventsToFinalResponse(
  events: AsyncIterable<NormalizedEvent>,
  meta: ResponseMeta
): Promise<AnthropicMessagesResponse> {
  const blocks = new Map<number, BlockState>();
  let stopReason: AnthropicStopReason | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const ev of events) {
    if (ev.kind === "text_delta") {
      const cur = blocks.get(ev.index);
      if (cur === undefined) {
        blocks.set(ev.index, { kind: "text", text: ev.text });
      } else if (cur.kind === "text") {
        cur.text += ev.text;
      }
      // text_delta on a tool_use index is dropped silently — malformed.
    } else if (ev.kind === "tool_use_start") {
      blocks.set(ev.index, {
        kind: "tool_use",
        id: ev.id,
        name: ev.name,
        partialJson: ""
      });
    } else if (ev.kind === "tool_use_delta") {
      const cur = blocks.get(ev.index);
      if (cur?.kind === "tool_use") {
        cur.partialJson += ev.partialJson;
      }
    } else if (ev.kind === "tool_use_stop") {
      // No-op for aggregation; the JSON parse happens at finalize time.
    } else if (ev.kind === "message_stop") {
      stopReason = mapStopReason(ev.stopReason);
      if (ev.usage) {
        inputTokens = ev.usage.inputTokens;
        outputTokens = ev.usage.outputTokens;
      }
    }
  }

  const content: AnthropicResponseContentBlock[] = [];
  // Iterate in index order to match the on-the-wire arrival order.
  const orderedKeys = Array.from(blocks.keys()).sort((a, b) => a - b);
  for (const idx of orderedKeys) {
    const block = blocks.get(idx);
    if (!block) continue;
    if (block.kind === "text") {
      content.push({ type: "text", text: block.text });
    } else {
      let parsedInput: unknown;
      try {
        parsedInput = block.partialJson.length > 0
          ? JSON.parse(block.partialJson)
          : {};
      } catch {
        // Malformed JSON from upstream; surface the raw string so clients
        // can still see what arrived rather than getting a 500.
        parsedInput = block.partialJson;
      }
      content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: parsedInput
      });
    }
  }

  return {
    id: meta.messageId,
    type: "message",
    role: "assistant",
    model: meta.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
  };
}
```

Note: the `Map.values()` insertion-order Plan 03 relied on no longer holds when a `tool_use_start` arrives at index 1 BEFORE a `text_delta` at index 0 (theoretically possible with interleaved streams). Sorting by numeric index is the correct invariant.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/anthropicShim/responseTranslator.test.ts`
Expected: PASS — all tests green, including the new tool_use ones and the existing Plan-03 text-only tests.

- [ ] **Step 5: Commit**

```bash
git add src/anthropicShim/responseTranslator.ts tests/unit/anthropicShim/responseTranslator.test.ts
git commit -m "feat(anthropicShim): emit tool_use SSE blocks; aggregate tool_use input across deltas"
```

---

## Task 9: Integration test — tool_use end-to-end through `/v1/messages`

**Files:**
- Create: `tests/integration/toolUse.test.ts`

End-to-end test against the same subprocess pattern Plan 03 used. Sends a request that triggers `MOCK_TOOL_USE` in mock-claude, verifies both the non-streaming response carries a `tool_use` content block and the streaming response emits the documented SSE triple.

- [ ] **Step 1: Write the test**

Create `tests/integration/toolUse.test.ts`. This file reuses the same `startServer` / `stopServer` / `postJson` helpers from `tests/integration/messages.test.ts` (Plan 03). For Plan 04, copy those helpers in-line — DO NOT refactor to a shared file (that's a Plan 11 concern; right now duplication keeps each test file self-contained and resilient to refactors elsewhere).

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const MOCK_CLAUDE_JS = join(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "mock-claude",
  "index.mjs"
);

interface SpawnedServer {
  proc: ChildProcess;
  port: number;
  workDir: string;
}

function pickPort(): number {
  // Disjoint range from messages.test.ts to avoid collisions when both
  // suites run in parallel.
  return 13410 + Math.floor(Math.random() * 200);
}

async function waitForReady(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject(new Error(`status ${res.statusCode}`));
        });
        req.on("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server did not become ready on port ${port}`);
}

async function startServer(): Promise<SpawnedServer> {
  const workDir = mkdtempSync(join(tmpdir(), "claudemcp-it-tooluse-"));
  const dbPath = join(workDir, "archive.sqlite");
  const cfgPath = join(workDir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      apiKey: "sk-integration",
      claude: {
        enabled: true,
        command: ["node", MOCK_CLAUDE_JS],
        priority: 100,
        timeoutMs: 10000
      },
      gemini: { enabled: false, command: "gemini" },
      lmstudio: { enabled: false, instances: [] },
      ollama: { enabled: false, useNativeApi: false, instances: [] },
      archive: { dbPath, compressionLevel: 3 }
    })
  );

  const port = pickPort();
  const proc = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(PROJECT_ROOT, "src", "bin.ts"),
      "--config",
      cfgPath,
      "--port",
      String(port)
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    }
  );

  proc.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
  proc.stderr?.on("data", (d) => process.stderr.write(`[server-err] ${d}`));

  await waitForReady(port);
  return { proc, port, workDir };
}

async function stopServer(s: SpawnedServer): Promise<void> {
  return new Promise((resolve) => {
    s.proc.once("exit", () => {
      rmSync(s.workDir, { recursive: true, force: true });
      resolve();
    });
    s.proc.kill("SIGTERM");
    setTimeout(() => {
      if (!s.proc.killed) s.proc.kill("SIGKILL");
    }, 4000);
  });
}

function postJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.length),
          "x-api-key": "sk-integration",
          ...headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers
          })
        );
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("Anthropic shim — tool_use end-to-end", () => {
  let server: SpawnedServer;

  beforeAll(async () => {
    server = await startServer();
  }, 30000);

  afterAll(async () => {
    if (server) await stopServer(server);
  });

  it("POST /v1/messages with tools and a MOCK_TOOL_USE prompt returns a tool_use content block", async () => {
    const res = await postJson(server.port, "/v1/messages", {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: 'Please call: MOCK_TOOL_USE(calculator,toolu_99,{"a":5,"b":7})'
        }
      ],
      tools: [
        {
          name: "calculator",
          description: "Adds two numbers",
          input_schema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"]
          }
        }
      ]
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as {
      type: string;
      content: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
      stop_reason: string;
    };
    expect(parsed.type).toBe("message");
    expect(parsed.stop_reason).toBe("tool_use");
    const toolUse = parsed.content.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse?.id).toBe("toolu_99");
    expect(toolUse?.name).toBe("calculator");
    expect(toolUse?.input).toEqual({ a: 5, b: 7 });
  });

  it("POST /v1/messages with stream:true emits content_block_start/delta/stop for tool_use", async () => {
    const res = await postJson(server.port, "/v1/messages", {
      model: "claude-sonnet-4-6",
      stream: true,
      messages: [
        {
          role: "user",
          content: 'MOCK_TOOL_USE(search,toolu_55,{"q":"hello"})'
        }
      ],
      tools: [
        {
          name: "search",
          input_schema: { type: "object", properties: { q: { type: "string" } } }
        }
      ]
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const eventBlocks = res.body
      .split("\n\n")
      .filter((b) => b.startsWith("event: "));
    const events = eventBlocks.map((b) => {
      const lines = b.split("\n");
      const event = lines[0]?.replace(/^event:\s*/, "") ?? "";
      const data = lines[1]?.replace(/^data:\s*/, "") ?? "";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
    const eventNames = events.map((e) => e.event);
    expect(eventNames).toContain("content_block_start");
    expect(eventNames).toContain("content_block_delta");
    expect(eventNames).toContain("content_block_stop");

    // Find the content_block_start for the tool_use.
    const start = events.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data["content_block"] as { type: string }).type === "tool_use"
    );
    expect(start).toBeDefined();
    expect((start?.data["content_block"] as { id: string }).id).toBe("toolu_55");

    // Find the input_json_delta.
    const delta = events.find(
      (e) =>
        e.event === "content_block_delta" &&
        (e.data["delta"] as { type: string }).type === "input_json_delta"
    );
    expect(delta).toBeDefined();
    const partial = (delta?.data["delta"] as { partial_json: string }).partial_json;
    expect(JSON.parse(partial)).toEqual({ q: "hello" });

    // Last event is message_stop.
    expect(eventNames[eventNames.length - 1]).toBe("message_stop");
  });

  it("POST /v1/messages with stop_sequences cuts mid-stream and returns stop_reason 'stop_sequence'", async () => {
    const res = await postJson(server.port, "/v1/messages", {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "MOCK_STOP_SEQUENCE_AT(HALT)" }],
      stop_sequences: ["HALT"]
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as {
      content: Array<{ type: string; text?: string }>;
      stop_reason: string;
    };
    expect(parsed.stop_reason).toBe("stop_sequence");
    const text = parsed.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    expect(text).not.toContain("HALT");
    expect(text).not.toContain("AFTER-SHOULD-BE-DROPPED");
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run tests/integration/toolUse.test.ts`
Expected: PASS — 3 tests green.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/toolUse.test.ts
git commit -m "test(integration): tool_use + stop_sequences end-to-end through Anthropic shim"
```

---

## Task 10: Integration test — multimodal end-to-end through `/v1/messages`

**Files:**
- Create: `tests/integration/multimodal.test.ts`

End-to-end test that an image content block reaches the CLI invocation. The mock-claude fixture's `MOCK_VISION_REQUEST` trigger writes a JSON receipt to stderr summarizing what arrived; this test reads that receipt through the server's stderr piping (the `[server-err]` prefix the integration helpers already use) and asserts the image marker came through.

Implementation note: the test can't read the spawned server's stderr after the fact because the helpers stream it to the test process's stdout. The clean way is to assert the *response body* contains the echoed prompt — but the mock's normal output path does that already. So the test instead crafts a prompt that, after the multimodal envelope is inlined, will be visibly echoed back in the response body by the mock's `result` event.

- [ ] **Step 1: Write the test**

Create `tests/integration/multimodal.test.ts` with the same boilerplate helpers as Task 9 (copy-paste them in — see Task 9's rationale for not extracting yet). Use port range `13610-13810` to avoid collisions.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const MOCK_CLAUDE_JS = join(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "mock-claude",
  "index.mjs"
);

interface SpawnedServer {
  proc: ChildProcess;
  port: number;
  workDir: string;
}

function pickPort(): number {
  return 13610 + Math.floor(Math.random() * 200);
}

// ... (waitForReady, startServer, stopServer, postJson — identical to Task 9)

describe("Anthropic shim — multimodal end-to-end", () => {
  let server: SpawnedServer;

  beforeAll(async () => {
    server = await startServer();
  }, 30000);

  afterAll(async () => {
    if (server) await stopServer(server);
  });

  it("POST /v1/messages with an image content block reaches the CLI", async () => {
    // 1x1 transparent PNG — minimal valid image base64.
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2P8z8DwHwAFAQH/CXm7BgAAAABJRU5ErkJggg==";
    const res = await postJson(server.port, "/v1/messages", {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "MOCK_VISION_REQUEST: describe the attached image" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: pngBase64 }
            }
          ]
        }
      ]
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = parsed.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    // The mock echoes the prompt; we should see the image envelope in the
    // echoed text, confirming it was inlined into the folded prompt.
    expect(text).toContain("[image:image/png;base64,");
    expect(text).toContain(pngBase64.slice(0, 16));
  });

  it("POST /v1/messages with a document content block reaches the CLI", async () => {
    const pdfBase64 = "JVBERi0xLjQKJeLjz9MK";
    const res = await postJson(server.port, "/v1/messages", {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "MOCK_VISION_REQUEST: summarize" },
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pdfBase64 }
            }
          ]
        }
      ]
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = parsed.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    expect(text).toContain("[document:application/pdf;base64,");
    expect(text).toContain(pdfBase64.slice(0, 8));
  });

  it("POST /v1/messages with a tool_result re-inlines into the next CLI invocation", async () => {
    const res = await postJson(server.port, "/v1/messages", {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "compute 1 + 2" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_calc1", name: "calculator", input: { x: 1, y: 2 } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_calc1", content: "3" },
            { type: "text", text: "MOCK_TOOL_RESULT_ECHO confirm please" }
          ]
        }
      ]
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = parsed.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    expect(text).toContain("echo[tool_result:toolu_calc1]=3");
  });
});
```

Fill the elided helpers with the same code from Task 9.

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run tests/integration/multimodal.test.ts`
Expected: PASS — 3 tests green.

- [ ] **Step 3: Run the full suite to confirm no regressions**

Run: `npx vitest run`
Expected: All tests green — the Plan-01/02/03 baseline plus everything Plan 04 added.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/multimodal.test.ts
git commit -m "test(integration): multimodal + tool_result re-inlining end-to-end through Anthropic shim"
```

---

## Task 11: Plan-04 close-out documentation

**Files:**
- Create: `docs/plan-04-tool-use-multimodal-readme.md`

A short README documenting what Plan 04 shipped, what stayed, and what's deferred to later plans.

- [ ] **Step 1: Write the document**

```markdown
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
| `tests/fixtures/mock-claude/index.mjs` | EXTENDED with `MOCK_TOOL_USE(...)`, `MOCK_STOP_SEQUENCE_AT(...)`, `MOCK_VISION_REQUEST`, `MOCK_TOOL_RESULT_ECHO` triggers + argv inspection on `--tools` and `--stop-sequences`. |
| `tests/unit/anthropicShim/types.test.ts` | NEW — type-level smoke test for the typed content block union and tool defs. |
| `tests/unit/runners/claudeStreamRunner.test.ts` | EXTENDED — matcher helper coverage (7 cases), arg construction for `--tools`/`--stop-sequences` (4 cases), runtime sentinel emission against mock (3 cases). |
| `tests/unit/backends/claudeBackend.test.ts` | EXTENDED — tools forwarded, image/document inlined, tool_result re-inlined, tool_choice directives, stop_sequence end-to-end, tool_use event triple emitted. Plan-02 fail-loud tests removed. |
| `tests/unit/anthropicShim/requestTranslator.test.ts` | Plan-03 fail-loud tests for image/document/tool_use/tool_result/tools/tool_choice/stop_sequences DELETED. Passthrough tests added. `thinking`/`cache_control` rejections retained. |
| `tests/unit/anthropicShim/responseTranslator.test.ts` | EXTENDED — tool_use SSE emission, tool_use aggregation, stop_sequence stop_reason. |
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/plan-04-tool-use-multimodal-readme.md
git commit -m "docs: add Plan 04 close-out README documenting tool_use + multimodal scope"
```

---

## Task 12: Final validation

**Files:** none (verification-only task)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests green across unit + integration. Approximate count = Plan 03's total + ~50 new tests:
- 7 types smoke tests
- 4 runner arg-construction tests
- 7 stop-sequence matcher tests
- 3 runner runtime cutter tests
- 9 backend (replacing 2 removed + adding 11 net new)
- 9 translator passthrough tests (replacing 7 removed + adding 14 net new)
- 9 response translator tool_use tests
- 3 integration tool_use tests
- 3 integration multimodal tests

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 3: Quick manual sanity check**

Run: `node --import tsx src/bin.ts --config <path to a temp config>`
- The server starts.
- `curl -X POST http://127.0.0.1:3210/v1/messages -H "x-api-key: <key>" -H "content-type: application/json" -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":[{"type":"text","text":"hi"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AA=="}}]}]}'` returns 200 (assuming a working Claude CLI on PATH or mock).
- `curl -X POST .../v1/messages -d '{"model":"claude-sonnet-4-6","messages":[...],"tools":[{...}]}'` returns 200 with possibly a `tool_use` content block depending on what the model decides.

- [ ] **Step 4: Verify the close-out checklist**

See the next section.

---

## Plan 04 — Self-review checklist

Before declaring Plan 04 done, run through this checklist:

- [ ] `npm test` — all tests green, no skips. New count visible at the end of the suite.
- [ ] `npx tsc --noEmit` — no type errors.
- [ ] `git status` — clean tree, all changes committed (except pre-existing untracked files like `scripts/configure-agent-zero.sh`).
- [ ] `git log --oneline -15` — commits read sensibly: types, mock-claude extension, runner args, runner cutter, backend translation, backend tool_use emission, request translator passthroughs, response translator tool_use, tool_use integration test, multimodal integration test, README.
- [ ] `src/backends/claudeBackend.ts` no longer contains `assertPlan02Scope` (grep returns zero hits).
- [ ] `src/anthropicShim/requestTranslator.ts` no longer contains the Plan-03 strings `"Plan 03"` or `"lands in Plan 04"` for the seven now-honored features (a grep for `lands in Plan 04` should return zero hits; `lands in Plan 05` remains for cache_control / file refs / URL sources).
- [ ] `src/anthropicShim/responseTranslator.ts` emits `tool_use_*` events instead of dropping them silently.
- [ ] `src/runners/claudeStreamRunner.ts` exports `createStopSequenceMatcher` and its `runClaudeStream` handles the `_internal stop_sequence_match` sentinel.
- [ ] `src/runners/types.ts` `ClaudeStreamOptions` has `tools?: NormalizedToolDef[]` and `stopSequences?: string[]`.
- [ ] Every `src/*` import added in this plan uses an explicit `.js` extension (NodeNext).
- [ ] `noUncheckedIndexedAccess` discipline preserved — no new bare `[i]` accesses without a runtime guard or an `!` assertion that's justified by a preceding length check.
- [ ] `tests/fixtures/mock-claude/index.mjs` supports four new triggers (`MOCK_TOOL_USE`, `MOCK_STOP_SEQUENCE_AT`, `MOCK_VISION_REQUEST`, `MOCK_TOOL_RESULT_ECHO`).
- [ ] The stop-sequence cutter emits text BEFORE the match and then signals the cut — never emits the match itself or text after it (verified in `tests/unit/runners/claudeStreamRunner.test.ts` "truncates the text at the match start" and `tests/unit/backends/claudeBackend.test.ts` "stop_sequence" test).
- [ ] `ClaudeBackend.capabilitiesFor(...)` returns the SAME values it did in Plan 02 (`toolUse: true`, `multimodal: true`, `stopSequences: "server-side-cut"`); no flags introduced or removed.
- [ ] No file under `src/` exceeds 350 lines after Plan 04 lands; if `claudeBackend.ts` or `responseTranslator.ts` grew past that, consider extracting helpers in a future cleanup task (do NOT extract them in Plan 04 — keep the scope tight).
- [ ] `Archive` is still untouched by writers — `grep -r "archive\." src/anthropicShim/ src/backends/` should return zero hits.

If all check, Plan 04 is shipped. Open a PR to main (or merge directly following the project's commit pattern); Plan 05 follows.

---

## Open questions

These deserve attention from a human reviewer before or during Plan 04 execution, and may shift later plans. They are restated here for visibility (the close-out README also lists them):

1. **CLI image / document / tool / stop-sequence flag surface.** Plan 04 ships best-guess CLI argv shapes (`--tools`, `--stop-sequences`, and inline `[image:...]` envelopes in the prompt body). If the real Claude CLI's surface differs, the affected modules are `buildStreamArgs` (`src/runners/claudeStreamRunner.ts`) and `foldMessagesToPrompt` (`src/backends/claudeBackend.ts`). Tests in `claudeStreamRunner.test.ts` and `claudeBackend.test.ts` will surface the mismatch immediately.

2. **Native `input_json_delta` streaming from Claude.** Mock-claude sends a single full `tool_use` block. Real Claude streams partial JSON. The backend's accumulator handles both shapes, but the test coverage for the streaming-partial case is only end-to-end through the response translator; consider adding a unit test in `claudeBackend.test.ts` that constructs a multi-`tool_use_delta` raw event sequence directly once the real CLI behavior is observed.

3. **Streaming error envelope when backend.invoke() throws mid-stream.** Inherited open question from Plan 03 — Plan 04 does not address it. If the cutter fires and then a downstream consumer reads from the closed iterator, the existing `ClaudeBackend.invoke()` cleanup path handles it gracefully (yields a synthesized `message_stop` with `stopReason: "error"`); no new failure modes added.

4. **`tool_choice: { type: "tool", name: "X" }` enforcement.** Plan 04 ships best-effort directive-on-system-prompt. A strict-enforcement layer would post-process the `tool_use_start` events to drop or rewrite mismatched tool names — defer to a future plan once we measure honor rate.

5. **`thinking` field.** Still 400s. Lands in a follow-up sub-task that requires Plan-01's `NormalizedEvent` union to grow a `thinking_delta` variant first.

6. **Tool-result with non-text content.** Anthropic admits image content in `tool_result.content`; Plan 04 only honors string and text-block-array. Plan 05 should revisit when image-source handling lands.

7. **Windows subprocess integration test reliability.** Plan 03's open question about `cross-spawn` shell semantics on Windows applies equally to Plan 04's two new integration test files. If they're flaky on Windows CI, fall back to importing `buildApp` from `src/server.ts` directly and skip the subprocess spawn step — accept losing bin.ts surface coverage in CI on Windows.

8. **Cutter tail-buffer growth on adversarial input.** `createStopSequenceMatcher` keeps `max(seqLen) - 1` chars in the rolling tail. For pathologically long stop sequences (e.g., a 10 KB string), the cutter holds 10 KB - 1 of recent stream text in memory continuously. Not a problem for typical use (sequences are short), but document the bound in the close-out README. (Actually documented above — no follow-up action.)
</content>
</invoke>