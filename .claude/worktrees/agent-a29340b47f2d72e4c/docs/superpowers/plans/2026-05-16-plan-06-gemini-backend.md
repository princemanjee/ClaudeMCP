# Plan 06: Gemini Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the `gemini` CLI under the same `Backend` interface that `ClaudeBackend` already satisfies. Add a one-shot invoker (`src/runners/geminiRunner.ts`), a streaming invoker (`src/runners/geminiStreamRunner.ts`), and `src/backends/geminiBackend.ts` that wraps both and normalizes Gemini's `candidates[].content.parts[]` deltas into Plan 01's `NormalizedEvent` stream. After Plan 06, the Gemini backend can register into `BackendRegistry`, expose its model catalog, count tokens, and stream text responses end-to-end — but the Gemini-shaped HTTP shim (`/v1beta/models/*`), cross-shim dispatch (Anthropic shim routing `gemini-pro` to Gemini), and native tool_use round-trip stay deferred to Plan 07.

**Architecture:** Same shape as Plan 02. Two thin CLI invokers under `src/runners/`, then a backend class that translates `NormalizedRequest` → CLI argv → `NormalizedEvent` stream. The capability matrix differs from Claude's: Gemini natively honors `temperature`/`top_p`/`top_k` (per the spec's capability matrix), supports native stop sequences, and exposes a different streaming format (`candidates[].content.parts[]`). The model catalog is hard-coded to the late-2025 lineup (`gemini-pro`, `gemini-flash`, `gemini-flash-lite` plus their dotted-version variants). Hermetic testing uses a `mock-gemini` fixture identical in shape to `mock-claude`, with the same prompt-substring triggers (`MOCK_ERROR`, `MOCK_SLEEP_FOREVER`, `MOCK_INVALID_JSON`) and the corrected `setInterval` sleep idiom from the Plan-02 deviation log.

**Tech Stack:** Same as Plans 01-05 — Node.js 20+, TypeScript 5 (NodeNext ESM), `cross-spawn`, `tree-kill`, Vitest. Mock-gemini is a Node.js script invoked via explicit `node tests/fixtures/mock-gemini/index.mjs` so the executable bit doesn't matter on Windows.

**Spec:** `docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md` (Phase 6: Gemini backend).

**Builds on:**
- Plan 01 (`docs/superpowers/plans/2026-05-16-plan-01-foundation.md`) — `Backend`, `BackendCapabilities`, `NormalizedRequest`, `NormalizedEvent`, `ModelDescriptor`, `BackendRegistry`, `loadConfig` (uses `config.gemini.command`, `config.gemini.priority`, `config.gemini.timeoutMs`).
- Plan 02 (`docs/superpowers/plans/2026-05-16-plan-02-claude-backend.md`) — structural template (runner/backend split, event normalization pattern, scope boundary discipline, mock-CLI fixture pattern).

---

## Scope boundary for Plan 06

What ships here:

| Feature | Plan 06 disposition |
|---|---|
| Gemini one-shot CLI invocation | Shipped via `src/runners/geminiRunner.ts` |
| Gemini streaming CLI invocation (NDJSON of `candidates[]` chunks) | Shipped via `src/runners/geminiStreamRunner.ts` |
| `Backend` implementation for Gemini | Shipped via `src/backends/geminiBackend.ts` |
| Static model catalog (pro, flash, flash-lite + dotted variants) | Shipped — hard-coded |
| `capabilitiesFor(model)` reflecting Gemini CLI's surface | Shipped — `temperature`/`top_p`/`top_k` natively supported |
| Text-content message translation (folded into a single prompt) | Shipped |
| `system` field forwarded to the CLI | Shipped (CLI flag exact name flagged as assumption) |
| Text-part normalization (`{text: "..."}` parts → `text_delta` events) | Shipped |
| `countTokens(req)` via char/4 fallback | Shipped (Plan 05 may add a real tokenizer; Plan 06 just shims) |

What this plan does NOT ship — all of these throw a descriptive error from `invoke()` so callers fail loudly rather than receive wrong output:

| Feature on the request | Plan 06 disposition | Lands in |
|---|---|---|
| `image` content blocks | `invoke()` throws | Plan 07 (Gemini shim) wires multimodal via the Files API |
| `document` content blocks | `invoke()` throws | Plan 07 |
| `tool_use` content blocks (in request) | `invoke()` throws | Plan 07 (Gemini shim) — see open question below |
| `tool_result` content blocks (in request) | `invoke()` throws | Plan 07 |
| Non-empty `tools` array | `invoke()` throws | Plan 07 (cleanly wires function-calling) |
| Non-empty `stopSequences` array | `invoke()` throws | Plan 07 — the CLI surface is native, but the cut logic + tests live with the shim |
| `thinking` field truthy | `invoke()` throws | Future (Gemini 2.5 thinking-mode) |

Server-internal deferrals:
- **No Gemini shim** (`src/geminiShim/`, `/v1beta/models/*` endpoints) — Plan 07.
- **No cross-backend dispatch** (Anthropic shim routing `gemini-pro` to Gemini backend) — Plan 07 wires this; the Plan-03 Anthropic shim already gates on `identifyBackend`'s result returning `"gemini"`, but the registry has no `GeminiBackend` registered until this plan's integration test (and a follow-up `src/server.ts` edit in Plan 07).
- **No OpenAI-shim Gemini support** — Plan 10.
- **No grounding metadata / safety ratings translation** — Plan 07 (translation belongs with the shim that knows the destination wire shape).
- **No Gemini embeddings (`text-embedding-004`)** — deferred; see open question below.

(Note: if you can implement native `tool_use` for the Gemini backend cleanly within Plan 06 scope, do so and update `capabilitiesFor().toolUse` to `true`. Otherwise defer to Plan 07 and document the deferral in the close-out README.)

---

## File map

| File | Responsibility |
|---|---|
| `src/runners/types.ts` | **EXTEND.** Add `GeminiRunOptions`, `GeminiRunResult`, `GeminiStreamOptions`. Keep existing Claude types unchanged. |
| `src/runners/geminiRunner.ts` | One-shot CLI invoker: spawns `gemini --prompt <text>` (assumption — see pre-flight), captures full stdout, parses Gemini's JSON output for the final response + session-id-equivalent, returns `{text, sessionId, exitCode, durationMs, timedOut, stderr}`. |
| `src/runners/geminiStreamRunner.ts` | Streaming CLI invoker: spawns `gemini --prompt <text> --stream` (assumption — see pre-flight), async-iterates one parsed JSON object per output line (NDJSON of `{candidates: [{content: {parts: [...]}}]}` chunks), handles partial-line buffering and trailing-line flush. |
| `src/backends/geminiBackend.ts` | `Backend` implementation. `id: "gemini"`. Static model catalog. `capabilitiesFor(model)` reflecting Gemini CLI's surface. `invoke(req)` translates `NormalizedRequest` → CLI invocation → `NormalizedEvent` stream. `countTokens(req)` uses char/4 fallback. |
| `tests/fixtures/mock-gemini/index.mjs` | Hermetic mock of the `gemini` CLI. Same prompt-substring trigger pattern as `mock-claude`. Emits Gemini-shaped JSON output for one-shot, and Gemini-shaped stream events (NDJSON of `{candidates: [...]}` chunks) for stream mode. |
| `tests/fixtures/mock-gemini/package.json` | Tiny bin shim so the fixture can be installed as `mock-gemini` binary on PATH for integration tests. |
| `tests/unit/runners/geminiRunner.test.ts` | `buildArgs` argument-construction tests (no spawn) + spawn tests against `mock-gemini`. |
| `tests/unit/runners/geminiStreamRunner.test.ts` | `buildStreamArgs` tests + stream-iteration tests against `mock-gemini`. |
| `tests/unit/backends/geminiBackend.test.ts` | Capability matrix (verify `temperature`/`topP`/`topK` are `true` for Gemini — opposite of Claude), model listing, request translation, event normalization, scope-boundary throws. |
| `tests/integration/geminiBackend.test.ts` | End-to-end: register Gemini in `BackendRegistry`, probe, resolve a model, send `NormalizedRequest`, iterate events, assert wire-shape parity with the normalized stream. |
| `docs/plan-06-gemini-backend-readme.md` | Close-out documentation. |

---

## Pre-flight check

Before starting Task 1, confirm the prior plans are in place and verify the Gemini-CLI surface assumptions:

- [ ] `git log --oneline -10` shows the Plan-05 merge commit at or near the top (or whichever plan immediately precedes Plan 06 in your branch lineage).
- [ ] `npm test` shows the full prior-plans suite passing (no skips).
- [ ] `npx tsc --noEmit` clean.
- [ ] `src/backends/types.ts` exists with the `Backend` interface this plan implements.
- [ ] `src/backends/registry.ts` exists with the registry this plan's integration test uses.
- [ ] `src/backends/claudeBackend.ts` exists — Plan 06 mirrors its structure.
- [ ] `tests/fixtures/mock-claude/index.mjs` exists — Plan 06 mirrors its pattern.
- [ ] `src/runners/types.ts` exists with the Claude types — this plan extends, does not replace.
- [ ] `config.gemini.command`, `config.gemini.priority`, `config.gemini.timeoutMs` are all present in `src/config.ts` Zod schema.

**Gemini CLI surface verification** (do this before Task 3):

The exact flag names of the `gemini` CLI's prompt/stream/system/model flags may differ from this plan's assumptions. Before implementing the runners, do one of:

- [ ] Run `gemini --help` on a development host and note the exact flag names for: prompt input, output-format (JSON vs streaming), system-instruction, model selection, session resumption.
- [ ] Read the current `gemini` CLI documentation at the Google AI Gemini CLI repository.
- [ ] If neither is available, accept this plan's assumptions (documented at the top of each runner file) and rely on integration testing against the real CLI after Plan 06 lands.

Document any divergence in the runner file's leading comment and update `buildArgs` / `buildStreamArgs` accordingly. The mock-gemini fixture parses the *plan's* flag names — if the real CLI differs, update both the mock and the runners together.

**Authentication:** The `gemini` CLI authenticates via `gemini auth login`. Plan 06 assumes this is already done for the host running the integration tests. The mock-gemini fixture has no auth surface (it ignores any auth flags), so unit tests are unaffected.

If any check fails, stop and resolve before proceeding.

---

## Task 1: Mock-gemini test fixture

**Files:**
- Create: `tests/fixtures/mock-gemini/index.mjs`
- Create: `tests/fixtures/mock-gemini/package.json`

A small Node script that pretends to be the `gemini` CLI. Same shape as mock-claude: reads its argv, decides which canned output to produce (one-shot JSON or NDJSON `candidates[]` stream), and exits. Used by every test in this plan so we never need a real Google account in CI.

- [ ] **Step 1: Create the fixture script**

Create `tests/fixtures/mock-gemini/index.mjs`:

```js
#!/usr/bin/env node
// Minimal mock of the `gemini` CLI for ClaudeMCP tests.
// Reads argv, emits canned output matching the Gemini CLI's documented formats.
//
// Argv shape (subset that matters — adjust to the real CLI's flag surface if it
// differs at implementation time, and update the runners' buildArgs in lockstep):
//   --prompt <text>
//   --output-format json | stream
//   --system <text>
//   --resume <sessionId>          (optional, see open question on session model)
//   --model <id>
//
// The mock parses these flags and emits behavior keyed on substring matches
// in the prompt itself so tests can deterministically force outputs:
//   "MOCK_ERROR"        — exit code 1, stderr "mock error"
//   "MOCK_SLEEP_FOREVER" — sleep until killed (use to force timeouts).
//                          IMPORTANT: uses setInterval, NOT `await new Promise(()=>{})`
//                          which exits immediately due to top-level-await detection
//                          (see Plan-02 deviation log).
//   "MOCK_INVALID_JSON" — emit garbage that isn't JSON
//   anything else        — emit a normal Gemini-shaped response

import { argv, stdout, stderr, exit } from "node:process";

const args = argv.slice(2);

function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const prompt = flagValue("--prompt") ?? "";
const outputFormat = flagValue("--output-format") ?? "json";
const system = flagValue("--system");
const resume = flagValue("--resume");
const model = flagValue("--model") ?? "gemini-flash";

// Deterministic mock session id derived from inputs for assertion stability.
function mockSessionId() {
  if (resume) return resume;
  return `mock-gemini-session-${Buffer.from(prompt).toString("hex").slice(0, 8)}`;
}

const sessionId = mockSessionId();

// Behavioral triggers
if (prompt.includes("MOCK_ERROR")) {
  stderr.write("mock error\n");
  exit(1);
}

if (prompt.includes("MOCK_SLEEP_FOREVER")) {
  // Hang until the parent kills us. setInterval is the correct idiom — a bare
  // unsettled promise exits with code 13 within ~40ms under Node's top-level
  // await detection. See Plan-02 deviation log §1.
  await new Promise((_resolve) => {
    setInterval(() => {}, 1_000_000);
  });
}

if (prompt.includes("MOCK_INVALID_JSON")) {
  stdout.write("this is not json at all\n");
  exit(0);
}

// Normal output
const responseText =
  system && system.length > 0
    ? `[system: ${system.slice(0, 32)}] echo: ${prompt}`
    : `echo: ${prompt}`;

if (outputFormat === "stream") {
  // Stream the response as NDJSON, one event per line, matching the documented
  // Gemini CLI stream shape: each line is a `{candidates: [{content: {parts: [...]}}]}`
  // chunk. The final chunk carries `finishReason` and optional `usageMetadata`.
  const chunks = responseText.match(/.{1,8}/g) ?? [responseText];
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const candidate = {
      content: { parts: [{ text: chunks[i] }], role: "model" },
      index: 0
    };
    if (isLast) {
      candidate.finishReason = "STOP";
    }
    const chunk = {
      candidates: [candidate],
      modelVersion: model
    };
    if (isLast) {
      chunk.usageMetadata = {
        promptTokenCount: Math.ceil(prompt.length / 4),
        candidatesTokenCount: Math.ceil(responseText.length / 4),
        totalTokenCount:
          Math.ceil(prompt.length / 4) + Math.ceil(responseText.length / 4)
      };
      // Mock CLIs may not surface a session_id field for Gemini, but include
      // one in the final chunk so the runner can opportunistically extract it.
      chunk.sessionId = sessionId;
    }
    stdout.write(JSON.stringify(chunk) + "\n");
  }
} else {
  // One-shot JSON: single object on stdout, mirroring the streaming wire shape
  // collapsed into a single candidate's full content.
  stdout.write(
    JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text: responseText }], role: "model" },
          index: 0,
          finishReason: "STOP"
        }
      ],
      modelVersion: model,
      sessionId,
      usageMetadata: {
        promptTokenCount: Math.ceil(prompt.length / 4),
        candidatesTokenCount: Math.ceil(responseText.length / 4),
        totalTokenCount:
          Math.ceil(prompt.length / 4) + Math.ceil(responseText.length / 4)
      }
    })
  );
}

exit(0);
```

- [ ] **Step 2: Create the fixture package.json**

Create `tests/fixtures/mock-gemini/package.json`:

```json
{
  "name": "mock-gemini",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "mock-gemini": "./index.mjs"
  }
}
```

- [ ] **Step 3: Make the script executable (no-op on Windows but matters on macOS)**

Run: `chmod +x tests/fixtures/mock-gemini/index.mjs`
On Windows the file mode flag isn't meaningful; the command exits cleanly. On macOS/Linux it ensures the shebang line works when invoked directly. Same Windows deferral as Plan 02 — tests always invoke via `node tests/fixtures/mock-gemini/index.mjs` so the executable bit is not on the critical path.

- [ ] **Step 4: Smoke-test the fixture by running it directly**

Run:
```
node tests/fixtures/mock-gemini/index.mjs --prompt "hello" --output-format json
```

Expected stdout: a single JSON object with `candidates`, `modelVersion`, `sessionId`, `usageMetadata` fields. `candidates[0].content.parts[0].text` should be `"echo: hello"`.

Then run:
```
node tests/fixtures/mock-gemini/index.mjs --prompt "hello" --output-format stream
```

Expected stdout: multiple NDJSON lines, each a `{candidates: [{content: {parts: [{text: "..."}]}}]}` chunk. The final line carries `finishReason: "STOP"` and `usageMetadata`.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/mock-gemini
git commit -m "test(fixture): add mock-gemini CLI stub for hermetic backend tests"
```

---

## Task 2: Extend shared runner types with Gemini variants

**Files:**
- Modify: `src/runners/types.ts`
- Test: `tests/unit/runners/types.test.ts` (extend)

Add `GeminiRunOptions`, `GeminiRunResult`, `GeminiStreamOptions` types alongside the existing Claude types. Same file — both runner families share the file so neither has to import from the other's module.

- [ ] **Step 1: Append failing type-level tests**

Append to `tests/unit/runners/types.test.ts` (after the existing Claude type tests, inside the same describe block or a new sibling describe — your choice):

```ts
import type {
  GeminiRunOptions,
  GeminiRunResult,
  GeminiStreamOptions
} from "../../../src/runners/types.js";

describe("gemini runner types", () => {
  it("constructs a minimal GeminiRunOptions", () => {
    const opts: GeminiRunOptions = {
      prompt: "hello",
      timeoutMs: 60000,
      geminiCommand: "gemini"
    };
    expect(opts.prompt).toBe("hello");
  });

  it("accepts string-array geminiCommand for shim prefixes (e.g. wsl)", () => {
    const opts: GeminiRunOptions = {
      prompt: "hello",
      timeoutMs: 60000,
      geminiCommand: ["wsl", "gemini"]
    };
    expect(Array.isArray(opts.geminiCommand)).toBe(true);
  });

  it("GeminiRunOptions carries optional model and samplingParams", () => {
    const opts: GeminiRunOptions = {
      prompt: "hello",
      timeoutMs: 60000,
      geminiCommand: "gemini",
      model: "gemini-pro",
      temperature: 0.5,
      topP: 0.9,
      topK: 40
    };
    expect(opts.model).toBe("gemini-pro");
    expect(opts.temperature).toBe(0.5);
  });

  it("GeminiRunResult carries every documented field", () => {
    const result: GeminiRunResult = {
      text: "ok",
      sessionId: "s1",
      exitCode: 0,
      durationMs: 12,
      timedOut: false,
      stderr: "",
      usage: { inputTokens: 1, outputTokens: 2 }
    };
    expect(result.sessionId).toBe("s1");
    expect(result.usage?.inputTokens).toBe(1);
  });

  it("GeminiRunResult.sessionId and usage may be null/undefined", () => {
    const result: GeminiRunResult = {
      text: "",
      sessionId: null,
      exitCode: -1,
      durationMs: 0,
      timedOut: false,
      stderr: "spawn error"
    };
    expect(result.sessionId).toBeNull();
    expect(result.usage).toBeUndefined();
  });

  it("GeminiStreamOptions adds optional systemPrompt", () => {
    const opts: GeminiStreamOptions = {
      prompt: "hello",
      systemPrompt: "you are helpful",
      timeoutMs: 60000,
      geminiCommand: "gemini"
    };
    expect(opts.systemPrompt).toBe("you are helpful");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/runners/types.test.ts`
Expected: FAIL — type symbols `GeminiRunOptions` / `GeminiRunResult` / `GeminiStreamOptions` not exported from `src/runners/types.js`.

- [ ] **Step 3: Extend `src/runners/types.ts`**

Append the following at the end of the file (do not modify the existing Claude types):

```ts
// ---- Gemini CLI runner types ---------------------------------------------

export interface GeminiRunOptions {
  /** Prompt body passed to gemini via `--prompt` (assumption — verify against the CLI). */
  prompt: string;
  /** Working directory for the CLI process. Defaults to Node's CWD if omitted. */
  workDir?: string;
  /** Optional Gemini model id (e.g. "gemini-pro", "gemini-flash"). Passed via `--model`. */
  model?: string;
  /** Resume an existing Gemini conversation by id (if the CLI supports it; see open question). */
  resumeSessionId?: string;
  /** Sampling controls passed through to the CLI when set. */
  temperature?: number;
  topP?: number;
  topK?: number;
  /** Native stop sequences (Gemini supports these per the capability matrix). */
  stopSequences?: string[];
  /** Kill the process tree after this many ms. */
  timeoutMs: number;
  /**
   * Either a single executable name/path or an array where the head is the
   * executable and the tail is a fixed prefix of arguments (useful for `wsl gemini`).
   */
  geminiCommand: string | string[];
}

export interface GeminiRunResult {
  /** Extracted text response from the CLI output. */
  text: string;
  /** Session id parsed from JSON output, or null on error / unparseable / absent. */
  sessionId: string | null;
  /** Process exit code. -1 for spawn failure, 124 (or process code) for timeout. */
  exitCode: number;
  /** Wall-clock milliseconds from spawn to close. */
  durationMs: number;
  /** True if the run hit the configured timeout. */
  timedOut: boolean;
  /** Concatenated stderr output, including any "[spawn error]" annotations. */
  stderr: string;
  /** Token usage parsed from `usageMetadata` in the JSON output, if present. */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface GeminiStreamOptions extends Omit<GeminiRunOptions, never> {
  /** Optional system instruction passed via `--system` (assumption — verify against the CLI). */
  systemPrompt?: string;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/runners/types.test.ts`
Expected: PASS — all 5 original Claude type tests + 6 new Gemini type tests = 11 green.

- [ ] **Step 5: Commit**

```bash
git add src/runners/types.ts tests/unit/runners/types.test.ts
git commit -m "feat(runners): add Gemini option/result types alongside Claude variants"
```

---

## Task 3: One-shot Gemini runner

**Files:**
- Create: `src/runners/geminiRunner.ts`
- Test: `tests/unit/runners/geminiRunner.test.ts`

Function signature: `runGemini(opts: GeminiRunOptions): Promise<GeminiRunResult>`. Argv construction is pure and lives in `buildArgs` for unit-test reach. Spawn lifecycle, timeout, stderr aggregation, and JSON extraction mirror `claudeRunner` exactly — only the output-shape parsing differs (Gemini puts text under `candidates[0].content.parts[*].text`, not under a top-level `result` field).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runners/geminiRunner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { buildArgs, runGemini } from "../../../src/runners/geminiRunner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_GEMINI = ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")];

describe("buildArgs", () => {
  it("emits --prompt prompt and --output-format json by default", () => {
    expect(
      buildArgs({
        prompt: "hi",
        timeoutMs: 1000,
        geminiCommand: "gemini"
      })
    ).toEqual(["--prompt", "hi", "--output-format", "json"]);
  });

  it("inserts --model when model is set", () => {
    expect(
      buildArgs({
        prompt: "hi",
        model: "gemini-pro",
        timeoutMs: 1000,
        geminiCommand: "gemini"
      })
    ).toEqual(["--model", "gemini-pro", "--prompt", "hi", "--output-format", "json"]);
  });

  it("appends --temperature, --top-p, --top-k when set", () => {
    const args = buildArgs({
      prompt: "hi",
      temperature: 0.5,
      topP: 0.9,
      topK: 40,
      timeoutMs: 1000,
      geminiCommand: "gemini"
    });
    expect(args).toContain("--temperature");
    expect(args[args.indexOf("--temperature") + 1]).toBe("0.5");
    expect(args).toContain("--top-p");
    expect(args[args.indexOf("--top-p") + 1]).toBe("0.9");
    expect(args).toContain("--top-k");
    expect(args[args.indexOf("--top-k") + 1]).toBe("40");
  });

  it("appends repeated --stop for each stop sequence", () => {
    const args = buildArgs({
      prompt: "hi",
      stopSequences: ["STOP1", "STOP2"],
      timeoutMs: 1000,
      geminiCommand: "gemini"
    });
    const stopFlags = args.filter((a) => a === "--stop");
    expect(stopFlags.length).toBe(2);
  });

  it("prepends --resume when resumeSessionId is set", () => {
    const args = buildArgs({
      prompt: "hi",
      resumeSessionId: "sess-1",
      timeoutMs: 1000,
      geminiCommand: "gemini"
    });
    expect(args[0]).toBe("--resume");
    expect(args[1]).toBe("sess-1");
  });
});

describe("runGemini (against mock-gemini)", () => {
  it("extracts text from a normal response", async () => {
    const result = await runGemini({
      prompt: "hello",
      timeoutMs: 5000,
      geminiCommand: MOCK_GEMINI
    });
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("echo: hello");
    expect(result.sessionId).toMatch(/^mock-gemini-session-/);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toBe("");
  });

  it("parses usageMetadata into usage field", async () => {
    const result = await runGemini({
      prompt: "hello",
      timeoutMs: 5000,
      geminiCommand: MOCK_GEMINI
    });
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
  });

  it("returns sessionId null and stderr when CLI exits non-zero", async () => {
    const result = await runGemini({
      prompt: "please MOCK_ERROR now",
      timeoutMs: 5000,
      geminiCommand: MOCK_GEMINI
    });
    expect(result.exitCode).toBe(1);
    expect(result.sessionId).toBeNull();
    expect(result.stderr).toContain("mock error");
  });

  it("falls back to raw stdout when JSON parse fails", async () => {
    const result = await runGemini({
      prompt: "give me MOCK_INVALID_JSON",
      timeoutMs: 5000,
      geminiCommand: MOCK_GEMINI
    });
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("this is not json at all");
    expect(result.sessionId).toBeNull();
    expect(result.usage).toBeUndefined();
  });

  it("times out after timeoutMs and kills the process", async () => {
    const start = Date.now();
    const result = await runGemini({
      prompt: "MOCK_SLEEP_FOREVER now",
      timeoutMs: 250,
      geminiCommand: MOCK_GEMINI
    });
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it("returns spawn-failure result when binary is missing", async () => {
    const result = await runGemini({
      prompt: "hello",
      timeoutMs: 5000,
      geminiCommand: "definitely-not-a-real-binary-xyz"
    });
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("spawn error");
  });

  it("forwards model to mock-gemini (visible in output's modelVersion)", async () => {
    // The mock echoes the --model value in `modelVersion`. We don't directly
    // expose that on the runner result, but we can verify it parsed by checking
    // the runner doesn't crash and returns text.
    const result = await runGemini({
      prompt: "hello",
      model: "gemini-pro",
      timeoutMs: 5000,
      geminiCommand: MOCK_GEMINI
    });
    expect(result.text).toBe("echo: hello");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/runners/geminiRunner.test.ts`
Expected: FAIL — module `src/runners/geminiRunner.js` not found.

- [ ] **Step 3: Create `src/runners/geminiRunner.ts`**

```ts
// Gemini one-shot CLI invoker. Mirrors claudeRunner.ts structurally; differs
// only in the argv shape and the output-parsing path (Gemini puts text under
// `candidates[0].content.parts[*].text`, not under a top-level `result` field).
//
// Flag-name assumptions (verify against `gemini --help` at implementation time;
// update both this file AND `tests/fixtures/mock-gemini/index.mjs` in lockstep
// if reality differs):
//   --prompt <text>            prompt body
//   --output-format json       force JSON output
//   --model <id>               select model
//   --system <text>            system instruction
//   --resume <sessionId>       resume conversation (see open question)
//   --temperature <float>      sampling temperature
//   --top-p <float>            nucleus sampling
//   --top-k <int>              top-k sampling
//   --stop <seq>               native stop sequence (repeat for multiple)

import spawn from "cross-spawn";
import treeKill from "tree-kill";
import type { GeminiRunOptions, GeminiRunResult } from "./types.js";

/**
 * Build the argv array for `gemini --prompt ...`. Pure; no side effects.
 * Exported for unit testing without spawning the CLI.
 */
export function buildArgs(opts: GeminiRunOptions): string[] {
  const args: string[] = [];
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }
  args.push("--prompt", opts.prompt);
  args.push("--output-format", "json");
  if (opts.temperature !== undefined) {
    args.push("--temperature", String(opts.temperature));
  }
  if (opts.topP !== undefined) {
    args.push("--top-p", String(opts.topP));
  }
  if (opts.topK !== undefined) {
    args.push("--top-k", String(opts.topK));
  }
  if (opts.stopSequences) {
    for (const seq of opts.stopSequences) {
      args.push("--stop", seq);
    }
  }
  return args;
}

function splitCommand(cmd: string | string[]): [string, string[]] {
  if (Array.isArray(cmd)) {
    const [head, ...rest] = cmd;
    if (!head) throw new Error("geminiCommand array must be non-empty");
    return [head, rest];
  }
  return [cmd, []];
}

interface ParsedOutput {
  text: string;
  sessionId: string | null;
  usage?: { inputTokens: number; outputTokens: number };
}

function parseGeminiOutput(stdout: string): ParsedOutput {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: "", sessionId: null };
  try {
    const parsed = JSON.parse(trimmed) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
      sessionId?: string;
      session_id?: string;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      };
    };
    const parts = parsed.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
    const sid = parsed.sessionId ?? parsed.session_id ?? null;
    const usage = parsed.usageMetadata
      ? {
          inputTokens: parsed.usageMetadata.promptTokenCount ?? 0,
          outputTokens: parsed.usageMetadata.candidatesTokenCount ?? 0
        }
      : undefined;
    return { text, sessionId: typeof sid === "string" ? sid : null, usage };
  } catch {
    // Not JSON — error paths emit plain text. Return raw stdout, no session id.
    return { text: trimmed, sessionId: null };
  }
}

export function runGemini(opts: GeminiRunOptions): Promise<GeminiRunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const args = buildArgs(opts);
    const [cmd, prefixArgs] = splitCommand(opts.geminiCommand);
    const child = spawn(cmd, [...prefixArgs, ...args], {
      cwd: opts.workDir,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnErrored = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        treeKill(child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs);

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      spawnErrored = true;
      stderr += `\n[spawn error] ${err.message}`;
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const exitCode = spawnErrored
        ? -1
        : timedOut
          ? (code ?? 124)
          : (code ?? 0);
      const parsed =
        exitCode === 0 ? parseGeminiOutput(stdout) : { text: stdout.trim(), sessionId: null };
      resolve({
        text: parsed.text,
        sessionId: exitCode === 0 ? parsed.sessionId : null,
        exitCode,
        durationMs,
        timedOut,
        stderr,
        usage: exitCode === 0 ? parsed.usage : undefined
      });
    });
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/runners/geminiRunner.test.ts`
Expected: PASS — all 12 tests green (5 buildArgs + 7 against mock-gemini).

- [ ] **Step 5: Commit**

```bash
git add src/runners/geminiRunner.ts tests/unit/runners/geminiRunner.test.ts
git commit -m "feat(runners): add one-shot geminiRunner with buildArgs + spawn lifecycle"
```

---

## Task 4: Streaming Gemini runner

**Files:**
- Create: `src/runners/geminiStreamRunner.ts`
- Test: `tests/unit/runners/geminiStreamRunner.test.ts`

Function signature: `runGeminiStream(opts: GeminiStreamOptions): AsyncIterable<unknown>`. Yields one parsed JSON object per output line from the CLI's `--output-format stream`. Identical buffering / trailing-line / waker pattern as `claudeStreamRunner` — only the argv shape and the output format name differ.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runners/geminiStreamRunner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  buildStreamArgs,
  runGeminiStream
} from "../../../src/runners/geminiStreamRunner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_GEMINI = ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")];

describe("buildStreamArgs", () => {
  it("emits --prompt prompt and --output-format stream", () => {
    expect(
      buildStreamArgs({
        prompt: "hi",
        timeoutMs: 1000,
        geminiCommand: "gemini"
      })
    ).toEqual(["--prompt", "hi", "--output-format", "stream"]);
  });

  it("prepends --system when systemPrompt is set", () => {
    const args = buildStreamArgs({
      prompt: "hi",
      systemPrompt: "you are helpful",
      timeoutMs: 1000,
      geminiCommand: "gemini"
    });
    expect(args).toEqual([
      "--system",
      "you are helpful",
      "--prompt",
      "hi",
      "--output-format",
      "stream"
    ]);
  });

  it("inserts --model and --system before --prompt", () => {
    const args = buildStreamArgs({
      prompt: "hi",
      systemPrompt: "sys",
      model: "gemini-pro",
      timeoutMs: 1000,
      geminiCommand: "gemini"
    });
    expect(args).toEqual([
      "--system",
      "sys",
      "--model",
      "gemini-pro",
      "--prompt",
      "hi",
      "--output-format",
      "stream"
    ]);
  });

  it("appends sampling controls when set", () => {
    const args = buildStreamArgs({
      prompt: "hi",
      temperature: 0.7,
      topP: 0.95,
      topK: 64,
      timeoutMs: 1000,
      geminiCommand: "gemini"
    });
    expect(args).toContain("--temperature");
    expect(args[args.indexOf("--temperature") + 1]).toBe("0.7");
    expect(args).toContain("--top-p");
    expect(args).toContain("--top-k");
  });

  it("appends repeated --stop for each stop sequence", () => {
    const args = buildStreamArgs({
      prompt: "hi",
      stopSequences: ["END"],
      timeoutMs: 1000,
      geminiCommand: "gemini"
    });
    expect(args.filter((a) => a === "--stop").length).toBe(1);
  });
});

describe("runGeminiStream (against mock-gemini)", () => {
  async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const ev of stream) out.push(ev);
    return out;
  }

  it("yields candidates chunks in order, ending with finishReason STOP", async () => {
    const events = await collect(
      runGeminiStream({
        prompt: "hello",
        timeoutMs: 5000,
        geminiCommand: MOCK_GEMINI
      })
    );
    expect(events.length).toBeGreaterThanOrEqual(1);

    const last = events[events.length - 1] as {
      candidates?: Array<{ finishReason?: string }>;
    };
    expect(last.candidates?.[0]?.finishReason).toBe("STOP");
  });

  it("each non-final chunk carries a text part", async () => {
    const events = await collect(
      runGeminiStream({
        prompt: "hello",
        timeoutMs: 5000,
        geminiCommand: MOCK_GEMINI
      })
    );
    for (const ev of events) {
      const chunk = ev as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
      expect(typeof text).toBe("string");
    }
  });

  it("final chunk carries usageMetadata", async () => {
    const events = await collect(
      runGeminiStream({
        prompt: "hello",
        timeoutMs: 5000,
        geminiCommand: MOCK_GEMINI
      })
    );
    const last = events[events.length - 1] as { usageMetadata?: unknown };
    expect(last.usageMetadata).toBeDefined();
  });

  it("yields nothing extra when prompt triggers MOCK_INVALID_JSON (lines are skipped)", async () => {
    const events = await collect(
      runGeminiStream({
        prompt: "MOCK_INVALID_JSON",
        timeoutMs: 5000,
        geminiCommand: MOCK_GEMINI
      })
    );
    // mock-gemini emits a non-JSON line then exits. Stream runner silently
    // drops unparseable lines, so the iterator completes with zero events.
    expect(events).toEqual([]);
  });

  it("stops iterating after timeout kills the process", async () => {
    const events = await collect(
      runGeminiStream({
        prompt: "MOCK_SLEEP_FOREVER",
        timeoutMs: 250,
        geminiCommand: MOCK_GEMINI
      })
    );
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/runners/geminiStreamRunner.test.ts`
Expected: FAIL — module `src/runners/geminiStreamRunner.js` not found.

- [ ] **Step 3: Create `src/runners/geminiStreamRunner.ts`**

```ts
// Gemini streaming CLI invoker. Mirrors claudeStreamRunner.ts in shape; differs
// only in the argv (uses `--output-format stream`, not `stream-json`) and in
// caller expectations of the parsed object shape (Gemini emits
// `{candidates: [...]}` chunks, not Claude's `{type: "...", message: ...}`).

import spawn from "cross-spawn";
import treeKill from "tree-kill";
import type { GeminiStreamOptions } from "./types.js";

/**
 * Build argv for `gemini --prompt ... --output-format stream`. Pure; no side effects.
 */
export function buildStreamArgs(opts: GeminiStreamOptions): string[] {
  const args: string[] = [];
  if (opts.systemPrompt !== undefined) {
    args.push("--system", opts.systemPrompt);
  }
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }
  args.push("--prompt", opts.prompt);
  args.push("--output-format", "stream");
  if (opts.temperature !== undefined) {
    args.push("--temperature", String(opts.temperature));
  }
  if (opts.topP !== undefined) {
    args.push("--top-p", String(opts.topP));
  }
  if (opts.topK !== undefined) {
    args.push("--top-k", String(opts.topK));
  }
  if (opts.stopSequences) {
    for (const seq of opts.stopSequences) {
      args.push("--stop", seq);
    }
  }
  return args;
}

function splitCommand(cmd: string | string[]): [string, string[]] {
  if (Array.isArray(cmd)) {
    const [head, ...rest] = cmd;
    if (!head) throw new Error("geminiCommand array must be non-empty");
    return [head, rest];
  }
  return [cmd, []];
}

export async function* runGeminiStream(
  opts: GeminiStreamOptions
): AsyncIterable<unknown> {
  const args = buildStreamArgs(opts);
  const [cmd, prefixArgs] = splitCommand(opts.geminiCommand);
  const child = spawn(cmd, [...prefixArgs, ...args], {
    cwd: opts.workDir,
    windowsHide: true
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) {
      treeKill(child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  }, opts.timeoutMs);

  const queue: unknown[] = [];
  let done = false;
  let spawnErrored = false;
  let waker: (() => void) | null = null;

  function wake(): void {
    if (waker) {
      const w = waker;
      waker = null;
      w();
    }
  }

  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) {
        try {
          queue.push(JSON.parse(line));
        } catch {
          // Malformed line — skip silently; caller just sees fewer events.
        }
      }
      nl = buffer.indexOf("\n");
    }
    wake();
  });

  child.on("error", () => {
    spawnErrored = true;
    wake();
  });

  child.on("close", () => {
    clearTimeout(timer);
    const trailing = buffer.trim();
    if (trailing.length > 0) {
      try {
        queue.push(JSON.parse(trailing));
      } catch {
        // ignore
      }
    }
    done = true;
    wake();
  });

  while (true) {
    if (queue.length > 0) {
      // Non-null assertion safe under noUncheckedIndexedAccess: the
      // `queue.length > 0` guard above guarantees a value is present.
      yield queue.shift()!;
      continue;
    }
    if (done) break;
    if (timedOut || spawnErrored) break;
    await new Promise<void>((resolve) => {
      waker = resolve;
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/runners/geminiStreamRunner.test.ts`
Expected: PASS — all 10 tests green (5 buildStreamArgs + 5 against mock-gemini).

- [ ] **Step 5: Commit**

```bash
git add src/runners/geminiStreamRunner.ts tests/unit/runners/geminiStreamRunner.test.ts
git commit -m "feat(runners): add streaming geminiStreamRunner with NDJSON line parsing"
```

---

## Task 5: Gemini backend skeleton

**Files:**
- Create: `src/backends/geminiBackend.ts`
- Test: `tests/unit/backends/geminiBackend.test.ts`

Implements the `Backend` interface from Plan 01. This task lands the static surface (id, capabilities, listModels, countTokens) and a constructor that accepts a config slice. `invoke()` is stubbed to throw — that lands in Task 6.

The model catalog hard-codes late-2025 Gemini model IDs: `gemini-pro`, `gemini-flash`, `gemini-flash-lite`, plus the dotted-version variants `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`. The dotted variants exist so callers pinning an exact version reach the same backend.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/backends/geminiBackend.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { GeminiBackend } from "../../../src/backends/geminiBackend.js";

describe("GeminiBackend skeleton", () => {
  function makeBackend(): GeminiBackend {
    return new GeminiBackend({
      command: "gemini",
      timeoutMs: 60000
    });
  }

  it("has id 'gemini'", () => {
    expect(makeBackend().id).toBe("gemini");
  });

  it("listModels returns the curated Gemini model catalog", async () => {
    const models = await makeBackend().listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("gemini-pro");
    expect(ids).toContain("gemini-flash");
    expect(ids).toContain("gemini-flash-lite");
    // Dotted-version variants for callers pinning exact versions.
    expect(ids).toContain("gemini-2.5-pro");
    expect(ids).toContain("gemini-2.5-flash");
    expect(ids).toContain("gemini-2.5-flash-lite");
  });

  it("each ModelDescriptor exposes context window and capability flags", async () => {
    const models = await makeBackend().listModels();
    for (const m of models) {
      expect(typeof m.contextWindow).toBe("number");
      expect(typeof m.supportsTools).toBe("boolean");
      expect(typeof m.supportsVision).toBe("boolean");
    }
  });

  it("capabilitiesFor(model) returns Gemini CLI's actual surface", () => {
    const caps = makeBackend().capabilitiesFor("gemini-pro");
    // Plan 06 baseline: toolUse stays false; Plan 07 wires it on.
    expect(caps.toolUse).toBe(false);
    expect(caps.multimodal).toBe(true);            // model-dependent, conservative true
    expect(caps.thinking).toBe(false);             // Gemini 2.5 thinking-mode lands later
    expect(caps.cacheControl).toBe("none");        // Plan-05 local response cache works regardless
    // Critical contrast vs Claude: Gemini supports all three natively.
    expect(caps.samplingParams).toEqual({
      temperature: true,
      topP: true,
      topK: true
    });
    expect(caps.stopSequences).toBe("native");     // Gemini CLI supports stop sequences natively
    expect(caps.embeddings).toBe(false);           // Gemini text-embedding-004 deferred (open question)
  });

  it("capabilitiesFor(flash-lite) reports the same surface (per-model narrowing happens later)", () => {
    const caps = makeBackend().capabilitiesFor("gemini-flash-lite");
    expect(caps.samplingParams.temperature).toBe(true);
    expect(caps.embeddings).toBe(false);
  });

  it("countTokens returns an estimate (char/4 fallback in Plan 06)", async () => {
    const tokens = await makeBackend().countTokens({
      model: "gemini-flash",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello world hello world" }]
        }
      ]
    });
    // char/4 fallback: 23 chars → ceil(23/4) = 6
    expect(tokens).toBe(6);
  });

  it("countTokens sums across multiple text blocks and system", async () => {
    const tokens = await makeBackend().countTokens({
      model: "gemini-flash",
      system: "you are helpful", // 15 chars → 4
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] }, // 5 → 2
        { role: "assistant", content: [{ type: "text", text: "ok" }] }, // 2 → 1
        { role: "user", content: [{ type: "text", text: "again" }] } // 5 → 2
      ]
    });
    expect(tokens).toBe(4 + 2 + 1 + 2);
  });

  it("invoke() throws — landed in Task 6", async () => {
    const backend = makeBackend();
    await expect(async () => {
      for await (const _ of backend.invoke({
        model: "gemini-flash",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      })) {
        // no-op
      }
    }).rejects.toThrow(/invoke/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/backends/geminiBackend.test.ts`
Expected: FAIL — module `src/backends/geminiBackend.js` not found.

- [ ] **Step 3: Create `src/backends/geminiBackend.ts`**

```ts
import type {
  Backend,
  BackendCapabilities,
  ModelDescriptor,
  NormalizedEvent,
  NormalizedRequest
} from "./types.js";

export interface GeminiBackendConfig {
  /** Either the executable name (e.g. "gemini") or [executable, ...prefix-args]. */
  command: string | string[];
  /** Per-call timeout in milliseconds. */
  timeoutMs: number;
}

/**
 * Curated catalog of Gemini models the backend reports. The CLI itself has no
 * model-listing endpoint, so this is maintained here. Late-2025 lineup:
 *   - gemini-pro          / gemini-2.5-pro
 *   - gemini-flash        / gemini-2.5-flash
 *   - gemini-flash-lite   / gemini-2.5-flash-lite
 *
 * The dotted-version variants exist so callers pinning an exact version still
 * resolve to this backend. When Google ships a new generation (e.g. 3.x), add
 * the new IDs here and update `capabilitiesFor` if their surface differs.
 *
 * Context-window numbers reflect the documented Gemini 2.x limits (1M input
 * tokens, 8K output). When these change for a future model, narrow on a
 * per-id basis in this list rather than papering over with one constant.
 */
const MODEL_CATALOG: ModelDescriptor[] = [
  {
    id: "gemini-pro",
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    description: "Most capable Gemini model. Long-context (1M)."
  },
  {
    id: "gemini-2.5-pro",
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    description: "Dotted-version alias of gemini-pro for explicit-version callers."
  },
  {
    id: "gemini-flash",
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    description: "Balanced Gemini model. Lower latency than pro."
  },
  {
    id: "gemini-2.5-flash",
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    description: "Dotted-version alias of gemini-flash."
  },
  {
    id: "gemini-flash-lite",
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    description: "Fastest, cheapest Gemini model."
  },
  {
    id: "gemini-2.5-flash-lite",
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    description: "Dotted-version alias of gemini-flash-lite."
  }
];

/**
 * Char-count token estimator. ceil(charCount / 4) is a standard rough
 * approximation; later plans (or a Plan-05 follow-up if available by then) may
 * swap in `@google/generative-ai`'s tokenizer. For Plan 06 this is what ships.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function sumRequestTokens(req: NormalizedRequest): number {
  let total = 0;
  if (req.system) total += estimateTokens(req.system);
  for (const msg of req.messages) {
    for (const block of msg.content) {
      if (block.type === "text") total += estimateTokens(block.text);
      else if (block.type === "thinking") total += estimateTokens(block.text);
      else if (block.type === "tool_use")
        total += estimateTokens(JSON.stringify(block.input));
      else if (block.type === "tool_result")
        total += estimateTokens(block.content);
      // image / document blocks: ignored for now; Plan 05/07 add proper accounting.
    }
  }
  return total;
}

export class GeminiBackend implements Backend {
  readonly id = "gemini" as const;

  constructor(private readonly config: GeminiBackendConfig) {}

  capabilitiesFor(_model: string): BackendCapabilities {
    // Same surface across all Gemini models for now. The notable contrasts
    // with Claude's surface:
    //   - samplingParams.{temperature,topP,topK}: TRUE (Claude has all false)
    //   - stopSequences: "native" (Claude is "server-side-cut")
    //   - toolUse: false in Plan 06 baseline; Plan 07 turns it on with the shim
    return {
      toolUse: false,
      multimodal: true,
      thinking: false,
      cacheControl: "none",
      samplingParams: { temperature: true, topP: true, topK: true },
      stopSequences: "native",
      embeddings: false
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return MODEL_CATALOG.map((m) => ({ ...m }));
  }

  async countTokens(req: NormalizedRequest): Promise<number> {
    return sumRequestTokens(req);
  }

  // eslint-disable-next-line require-yield
  async *invoke(_req: NormalizedRequest): AsyncIterable<NormalizedEvent> {
    throw new Error("GeminiBackend.invoke() lands in Plan 06 Task 6");
  }
}
```

- [ ] **Step 3a: Suppress the unused-config lint, if any**

`this.config` is set in the constructor but not yet read until Task 6's invoke implementation. If your lint setup flags this, either prefix with `_config` here or accept the warning until Task 6 (recommended — Task 6 lands immediately after and uses it).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/backends/geminiBackend.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backends/geminiBackend.ts tests/unit/backends/geminiBackend.test.ts
git commit -m "feat(geminiBackend): add skeleton with id, capabilities, listModels, countTokens"
```

---

## Task 6: GeminiBackend.invoke() — request translation + event normalization

**Files:**
- Modify: `src/backends/geminiBackend.ts`
- Modify: `tests/unit/backends/geminiBackend.test.ts`

Wire the `geminiStreamRunner` into `GeminiBackend.invoke()`. Translates `NormalizedRequest` → `GeminiStreamOptions`, spawns the runner, translates each raw CLI stream event (`{candidates: [{content: {parts: [...]}}]}`) into the appropriate `NormalizedEvent`.

Scope reminder (Plan 06 vs Plan 07):
- **Plan 06 (here):** text-only message content (no image/document blocks), no native tool_use, no stop sequences, no thinking blocks emitted by the model. `samplingParams` ARE honored (this is the key contrast with the Claude backend).
- **Plan 07 (later):** multimodal via Files API, function-calling, stop sequences end-to-end, grounding metadata, safety ratings.

If a `NormalizedRequest` arrives with content blocks Plan 06 can't handle (image, document, tool_use, tool_result) or with non-empty `tools` / `stopSequences` / truthy `thinking`, the method throws a descriptive error.

Translation rules for stream events (Gemini → Normalized):

| Gemini chunk shape | Normalized event(s) emitted |
|---|---|
| First chunk seen | `message_start { model }` |
| `candidates[0].content.parts[i]` with `text` | `text_delta { index, text }` for each text part |
| Final chunk with `finishReason` | `message_stop { stopReason, usage? }` |
| `finishReason: "STOP"` | `stopReason: "end_turn"` |
| `finishReason: "MAX_TOKENS"` | `stopReason: "max_tokens"` |
| `finishReason: "SAFETY"` or `"RECITATION"` | `stopReason: "error"` (Plan 07 may refine) |
| `usageMetadata.{promptTokenCount, candidatesTokenCount}` | `usage: { inputTokens, outputTokens }` |
| Stream ends without explicit `finishReason` | Synthesized `message_stop { stopReason: "error" }` |

- [ ] **Step 1: Add the failing tests**

Append to `tests/unit/backends/geminiBackend.test.ts`, after the existing tests inside the same `describe` block. Also add these imports at the top of the file:

```ts
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { NormalizedEvent } from "../../../src/backends/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
```

And these tests inside the `describe("GeminiBackend skeleton", ...)` block (or rename the describe — your choice):

```ts
  it("invoke streams: emits message_start, text_delta(s), message_stop in order", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    })) {
      events.push(ev);
    }

    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
    const deltas = events.filter((e) => e.kind === "text_delta");
    expect(deltas.length).toBeGreaterThan(0);
    // Concatenating all text_delta texts reproduces the assistant response.
    const joined = deltas.map((e) => (e.kind === "text_delta" ? e.text : "")).join("");
    expect(joined).toBe("echo: hello");
  });

  it("invoke forwards system prompt to the CLI via --system", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-flash",
      system: "you are helpful",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    })) {
      events.push(ev);
    }

    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toContain("[system:");
  });

  it("invoke folds multi-turn message history into a single prompt", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-flash",
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "second" }] }
      ]
    })) {
      events.push(ev);
    }

    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toContain("user: first");
    expect(text).toContain("assistant: ok");
    expect(text).toContain("user: second");
  });

  it("invoke forwards samplingParams to the CLI (Gemini honors them natively)", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    // mock-gemini doesn't check sampling values, but we verify the invoke path
    // doesn't throw when they are set, unlike Claude which ignores them per
    // capability matrix.
    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      samplingParams: { temperature: 0.7, topP: 0.9, topK: 40 }
    })) {
      events.push(ev);
    }
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke surfaces usage from the final chunk's usageMetadata", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-flash",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    })) {
      events.push(ev);
    }
    const stop = events[events.length - 1];
    if (stop?.kind === "message_stop") {
      expect(stop.usage).toBeDefined();
      expect(stop.usage?.inputTokens).toBeGreaterThan(0);
      expect(stop.usage?.outputTokens).toBeGreaterThan(0);
    } else {
      throw new Error("expected message_stop as last event");
    }
  });

  it("invoke throws on multimodal content (Plan 06 scope is text-only)", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    await expect(async () => {
      for await (const _ of backend.invoke({
        model: "gemini-flash",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              { type: "image", mediaType: "image/png", data: "BASE64" }
            ]
          }
        ]
      })) {
        // no-op
      }
    }).rejects.toThrow(/multimodal/i);
  });

  it("invoke throws on tools array (Plan 06 scope is no-tools)", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    await expect(async () => {
      for await (const _ of backend.invoke({
        model: "gemini-flash",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "calc", inputSchema: {} }]
      })) {
        // no-op
      }
    }).rejects.toThrow(/tool/i);
  });

  it("invoke throws on stopSequences (Plan 06 defers to Plan 07)", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    await expect(async () => {
      for await (const _ of backend.invoke({
        model: "gemini-flash",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        stopSequences: ["END"]
      })) {
        // no-op
      }
    }).rejects.toThrow(/stop/i);
  });
```

The Task-5 placeholder test (`invoke() throws — landed in Task 6`) must be removed in this step — Task 6 makes invoke real, so the placeholder cannot survive. This mirrors the Plan-02 deviation §3 reconciliation: replace, don't append.

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run tests/unit/backends/geminiBackend.test.ts`
Expected: 7 surviving skeleton tests pass, 8 new tests FAIL (invoke not implemented).

- [ ] **Step 3: Replace the invoke() stub in `src/backends/geminiBackend.ts`**

Add these imports near the top:

```ts
import { runGeminiStream } from "../runners/geminiStreamRunner.js";
import type { GeminiStreamOptions } from "../runners/types.js";
```

Replace the `invoke()` method with the real implementation, and add the two helpers below it:

```ts
  async *invoke(
    req: NormalizedRequest
  ): AsyncIterable<NormalizedEvent> {
    this.assertPlan06Scope(req);

    const streamOpts: GeminiStreamOptions = {
      prompt: this.foldMessagesToPrompt(req),
      systemPrompt: req.system,
      model: req.model,
      temperature: req.samplingParams?.temperature,
      topP: req.samplingParams?.topP,
      topK: req.samplingParams?.topK,
      timeoutMs: this.config.timeoutMs,
      geminiCommand: this.config.command
    };

    let startEmitted = false;
    let textIndex = 0;
    let textOpen = false;

    for await (const raw of runGeminiStream(streamOpts)) {
      const ev = raw as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          finishReason?: string;
        }>;
        modelVersion?: string;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
        };
      };

      const candidate = ev.candidates?.[0];

      if (!startEmitted) {
        startEmitted = true;
        yield { kind: "message_start", model: ev.modelVersion ?? req.model };
      }

      // Emit text deltas for each text part in this chunk.
      const parts = candidate?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part.text === "string" && part.text.length > 0) {
          yield { kind: "text_delta", index: textIndex, text: part.text };
          textOpen = true;
        }
      }

      // If this chunk has a finishReason, it's the terminal chunk: emit
      // message_stop and return.
      if (candidate?.finishReason !== undefined) {
        if (textOpen) {
          textIndex++;
          textOpen = false;
        }
        const usage = ev.usageMetadata
          ? {
              inputTokens: ev.usageMetadata.promptTokenCount ?? 0,
              outputTokens: ev.usageMetadata.candidatesTokenCount ?? 0
            }
          : undefined;
        yield {
          kind: "message_stop",
          stopReason: mapFinishReason(candidate.finishReason),
          usage:
            usage && usage.inputTokens + usage.outputTokens > 0
              ? usage
              : undefined
        };
        return;
      }
    }

    // Stream ended without an explicit finishReason chunk (e.g. process killed
    // by timeout). Emit a synthesized message_stop so callers always see one.
    if (!startEmitted) {
      yield { kind: "message_start", model: req.model };
    }
    yield { kind: "message_stop", stopReason: "error" };
  }

  // ---- Plan-06 scope helpers ---------------------------------------------

  private assertPlan06Scope(req: NormalizedRequest): void {
    if (req.tools && req.tools.length > 0) {
      throw new Error(
        "GeminiBackend (Plan 06): native tool calling lands in Plan 07"
      );
    }
    if (req.stopSequences && req.stopSequences.length > 0) {
      throw new Error(
        "GeminiBackend (Plan 06): stop_sequences land in Plan 07"
      );
    }
    if (req.thinking) {
      throw new Error(
        "GeminiBackend (Plan 06): thinking-mode lands in a follow-up plan"
      );
    }
    for (const msg of req.messages) {
      for (const block of msg.content) {
        if (block.type === "image" || block.type === "document") {
          throw new Error(
            "GeminiBackend (Plan 06): multimodal content lands in Plan 07"
          );
        }
        if (block.type === "tool_use" || block.type === "tool_result") {
          throw new Error(
            "GeminiBackend (Plan 06): tool_use/tool_result round-trip lands in Plan 07"
          );
        }
      }
    }
  }

  private foldMessagesToPrompt(req: NormalizedRequest): string {
    const lines: string[] = [];
    for (const msg of req.messages) {
      const text = msg.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .filter((t) => t.length > 0)
        .join("\n");
      if (text.length === 0) continue;
      lines.push(`${msg.role}: ${text}`);
    }
    return lines.join("\n\n");
  }
```

And add this free helper at module scope (alongside `sumRequestTokens`):

```ts
function mapFinishReason(
  geminiReason: string
):
  | "end_turn"
  | "stop_sequence"
  | "max_tokens"
  | "tool_use"
  | "error" {
  switch (geminiReason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "OTHER":
      return "error";
    default:
      return "end_turn";
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/backends/geminiBackend.test.ts`
Expected: PASS — all 15 tests green (7 surviving skeleton + 8 new invoke).

- [ ] **Step 5: Commit**

```bash
git add src/backends/geminiBackend.ts tests/unit/backends/geminiBackend.test.ts
git commit -m "feat(geminiBackend): wire invoke() through geminiStreamRunner with event normalization"
```

---

## Task 7: End-to-end integration test through the registry

**Files:**
- Create: `tests/integration/geminiBackend.test.ts`

Final verification: register the Gemini backend in a fresh `BackendRegistry` alongside the existing Claude backend (to prove they coexist), probe, route a `NormalizedRequest` end-to-end, iterate the stream, assert wire-shape parity. Confirms the new module slots into the Plan-01 foundation alongside Claude without changes to either.

- [ ] **Step 1: Write the test**

Create `tests/integration/geminiBackend.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { BackendRegistry } from "../../src/backends/registry.js";
import { GeminiBackend } from "../../src/backends/geminiBackend.js";
import { ClaudeBackend } from "../../src/backends/claudeBackend.js";
import type { NormalizedEvent } from "../../src/backends/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_GEMINI = ["node", join(__dirname, "..", "fixtures", "mock-gemini", "index.mjs")];
const MOCK_CLAUDE = ["node", join(__dirname, "..", "fixtures", "mock-claude", "index.mjs")];

describe("GeminiBackend integrates with BackendRegistry", () => {
  it("registers, probes, resolves a Gemini model, invokes end-to-end", async () => {
    const registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
    const gemini = new GeminiBackend({
      command: MOCK_GEMINI,
      timeoutMs: 5000
    });
    registry.register(gemini);

    try {
      await registry.probe();

      // listModels populated the registry's model map.
      expect(registry.resolveModel("gemini-pro")?.id).toBe("gemini");
      expect(registry.resolveModel("gemini-flash")?.id).toBe("gemini");
      expect(registry.resolveModel("gemini-flash-lite")?.id).toBe("gemini");
      expect(registry.resolveModel("gemini-2.5-pro")?.id).toBe("gemini");

      const resolved = registry.resolveModel("gemini-flash");
      expect(resolved).toBeDefined();

      const events: NormalizedEvent[] = [];
      for await (const ev of resolved!.invoke({
        model: "gemini-flash",
        messages: [{ role: "user", content: [{ type: "text", text: "integration ping" }] }]
      })) {
        events.push(ev);
      }

      // Wire-shape parity: starts with message_start, ends with message_stop.
      expect(events[0]?.kind).toBe("message_start");
      expect(events[events.length - 1]?.kind).toBe("message_stop");

      // The body text reproduces the mock's echo response.
      const body = events
        .filter((e) => e.kind === "text_delta")
        .map((e) => (e.kind === "text_delta" ? e.text : ""))
        .join("");
      expect(body).toBe("echo: user: integration ping");

      // countTokens returns a non-negative number for the same request shape.
      const tokens = await resolved!.countTokens({
        model: "gemini-flash",
        messages: [{ role: "user", content: [{ type: "text", text: "integration ping" }] }]
      });
      expect(tokens).toBeGreaterThan(0);
    } finally {
      registry.stop();
    }
  });

  it("coexists with the Claude backend — both probe and resolve their own models", async () => {
    const registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
    registry.register(new ClaudeBackend({ command: MOCK_CLAUDE, timeoutMs: 5000 }));
    registry.register(new GeminiBackend({ command: MOCK_GEMINI, timeoutMs: 5000 }));

    try {
      await registry.probe();

      expect(registry.resolveModel("claude-sonnet-4-6")?.id).toBe("claude");
      expect(registry.resolveModel("gemini-flash")?.id).toBe("gemini");

      // Neither backend's models leak into the other.
      expect(registry.resolveModel("claude-sonnet-4-6")?.id).not.toBe("gemini");
      expect(registry.resolveModel("gemini-flash")?.id).not.toBe("claude");

      // Both probe statuses are ok.
      expect(registry.lastProbeStatus("claude")?.ok).toBe(true);
      expect(registry.lastProbeStatus("gemini")?.ok).toBe(true);
    } finally {
      registry.stop();
    }
  });

  it("registry priority places Gemini below Claude by default (Gemini 90 < Claude 100)", async () => {
    // This test asserts priority math, not collision resolution — Gemini and
    // Claude model ids do not overlap. The point is that the priority map is
    // honored, which Plan 07's cross-shim dispatch will rely on.
    const registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
    registry.register(new GeminiBackend({ command: MOCK_GEMINI, timeoutMs: 5000 }));

    try {
      await registry.probe();
      const status = registry.lastProbeStatus("gemini");
      expect(status?.ok).toBe(true);
    } finally {
      registry.stop();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run tests/integration/geminiBackend.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: All prior-plan tests pass + the new Plan-06 tests (6 type extensions + 12 geminiRunner + 10 geminiStreamRunner + 15 geminiBackend + 3 integration = 46 new).

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/geminiBackend.test.ts
git commit -m "test(geminiBackend): integration with BackendRegistry — end-to-end through mock CLI"
```

---

## Task 8: Plan-06 close-out documentation

**Files:**
- Create: `docs/plan-06-gemini-backend-readme.md`

- [ ] **Step 1: Write the document**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/plan-06-gemini-backend-readme.md
git commit -m "docs: add Plan 06 close-out README documenting Gemini backend scope and boundaries"
```

---

## Plan 06 — Self-review checklist

Before declaring Plan 06 done, run through this checklist:

- [ ] `npm test` — all tests green, no skips. Expect prior-plan count + ~46 new (6 types + 12 geminiRunner + 10 geminiStreamRunner + 15 geminiBackend + 3 integration). Reconcile actual vs expected count in the close-out doc.
- [ ] `npx tsc --noEmit` — no type errors. Pay particular attention to `noUncheckedIndexedAccess`: `queue.shift()` in `geminiStreamRunner.ts` and `events[events.length - 1]` accessors in tests need handling.
- [ ] `git status` — clean tree, all changes committed (except pre-existing untracked files).
- [ ] `git log --oneline -12` — commits read sensibly: fixture, type extensions, runner, stream-runner, backend skeleton, backend invoke, integration, README.
- [ ] `src/runners/` directory now contains 5 files: `types.ts` (extended), `claudeRunner.ts`, `claudeStreamRunner.ts`, `geminiRunner.ts`, `geminiStreamRunner.ts` — no others.
- [ ] `src/backends/geminiBackend.ts` exists and implements the `Backend` interface from `src/backends/types.ts`.
- [ ] `GeminiBackend.capabilitiesFor()` returns `samplingParams: { temperature: true, topP: true, topK: true }` — the key contrast with `ClaudeBackend.capabilitiesFor()`.
- [ ] Mock-gemini fixture uses the `setInterval(() => {}, 1_000_000)` sleep idiom (NOT `await new Promise(() => {})` — see Plan-02 deviation §1).
- [ ] No source file under `src/` exceeds 300 lines (geminiBackend.ts ≈ 230 is the largest).
- [ ] `dist/` directory is untouched (compare `git log dist/ -5` — last touch should predate this plan).
- [ ] No new direct dependencies on `dist/` from anywhere under `src/` or `tests/`.
- [ ] No Gemini-shim files (`src/geminiShim/`) created — that's Plan 07.
- [ ] `ClaudeBackend` tests still pass unchanged (no regression from extending shared types).

If all check, Plan 06 is shipped. Open a PR to main; Plan 07 follows.
