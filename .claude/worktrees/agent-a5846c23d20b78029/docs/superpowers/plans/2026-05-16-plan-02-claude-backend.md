# Plan 02: Claude Backend Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the existing one-shot and streaming Claude CLI invokers under the new `Backend` interface from Plan 01. Reconstruct them as TypeScript modules under `src/runners/`, then build `src/backends/claudeBackend.ts` that wraps them and satisfies the `Backend` contract. No HTTP behavior change — the existing `dist/server.js` keeps running unchanged; this plan is purely additive in `src/`.

**Architecture:** Two thin CLI invokers (`claudeRunner.ts` one-shot, `claudeStreamRunner.ts` streaming) ported from the existing compiled JS in `dist/`. A new `claudeBackend.ts` wraps both: it translates `NormalizedRequest` from the Plan-01 types into the CLI's argv shape, spawns via the appropriate runner, and translates Claude's `stream-json` output into `NormalizedEvent`s. Scope for Plan 02 is the text-only path — multimodal blocks, native tool_use round-trip, and stop-sequence cuts land in Plan 04. The Claude backend also exposes a static `listModels()` (the CLI has no model-listing endpoint) and a `capabilitiesFor()` reflecting Claude CLI's actual surface.

**Tech Stack:** Same as Plan 01 — Node.js 20+, TypeScript 5 (NodeNext ESM), `cross-spawn`, `tree-kill`, Vitest. Mock-claude binary is a Node.js script on PATH for hermetic testing.

**Spec:** `docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md`

**Builds on:** Plan 01 (`docs/superpowers/plans/2026-05-16-plan-01-foundation.md`) — uses the `Backend`, `BackendCapabilities`, `NormalizedRequest`, `NormalizedEvent`, `ModelDescriptor` types from `src/backends/types.ts`.

---

## File map

| File | Responsibility |
|---|---|
| `src/runners/claudeRunner.ts` | One-shot CLI invoker: spawns `claude -p`, captures full stdout, parses `--output-format json`, returns `{text, sessionId, exitCode, durationMs, timedOut, stderr}`. Reconstructed from `dist/claudeRunner.js`. |
| `src/runners/claudeStreamRunner.ts` | Streaming CLI invoker: spawns `claude -p --output-format stream-json`, async-iterates one parsed JSON object per output line, handles partial-line buffering and trailing-line flush. Reconstructed from `dist/claudeStreamRunner.js`. |
| `src/runners/types.ts` | Shared option/result types for both runners: `ClaudeRunOptions`, `ClaudeRunResult`, `ClaudeStreamOptions`. |
| `src/backends/claudeBackend.ts` | `Backend` implementation. Holds the CLI command, the per-call timeout, and a static model catalog. `listModels()` returns a curated set. `capabilitiesFor(model)` returns Claude CLI's actual surface. `invoke(req)` translates `NormalizedRequest` → CLI args → spawns `claudeStreamRunner` → translates CLI events to `NormalizedEvent`. `countTokens(req)` uses `@anthropic-ai/tokenizer` if available, char/4 fallback otherwise. |
| `tests/fixtures/mock-claude/index.mjs` | Node script invoked as `claude` in tests. Reads argv, emits canned `stream-json` or `json` output matching the spec. |
| `tests/fixtures/mock-claude/package.json` | Tiny package shim so the fixture can be installed as `mock-claude` binary on PATH for integration tests. |
| `tests/unit/runners/claudeRunner.test.ts` | Argument-construction tests (no spawn) + spawn tests against mock-claude. |
| `tests/unit/runners/claudeStreamRunner.test.ts` | Argument-construction tests + stream-iteration tests against mock-claude. |
| `tests/unit/backends/claudeBackend.test.ts` | Capability matrix, model listing, request translation, event normalization. |
| `tests/integration/claudeBackend.test.ts` | End-to-end: register Claude backend in registry, send a `NormalizedRequest`, iterate events, assert wire-shape parity. |

---

## Pre-flight check

Before starting Task 1, confirm the Plan-01 baseline is in place:

- [ ] `git log --oneline -5` shows `Merge pull request #1 from princemanjee/plan-01-foundation` near the top.
- [ ] `npm test` shows 57/57 passing.
- [ ] `npx tsc --noEmit` clean.
- [ ] `src/backends/types.ts` exists (the Backend interface this plan extends).

If any check fails, stop and resolve before proceeding.

---

## Task 1: Mock-claude test fixture

**Files:**
- Create: `tests/fixtures/mock-claude/index.mjs`
- Create: `tests/fixtures/mock-claude/package.json`

A small Node script that pretends to be the `claude` CLI. It reads its argv, decides which canned output to produce (one-shot JSON or NDJSON stream-json), and exits. Used by every test in this plan so we never need a real Claude Max subscription in CI.

- [ ] **Step 1: Create the fixture script**

Create `tests/fixtures/mock-claude/index.mjs`:

```js
#!/usr/bin/env node
// Minimal mock of the `claude` CLI for ClaudeMCP tests.
// Reads argv, emits canned output matching Claude Code's documented formats.
//
// Argv shape (subset that matters):
//   -p <prompt>
//   --output-format json | stream-json
//   --system <prompt>
//   --resume <sessionId>
//   --allowed-tools <csv>          (we ignore the value, just record it)
//   --dangerously-skip-permissions
//   --model <id>
//
// The mock parses these flags and emits behavior keyed on substring matches
// in the prompt itself so tests can deterministically force outputs:
//   "MOCK_ERROR"        — exit code 1, stderr "mock error"
//   "MOCK_SLEEP_FOREVER" — sleep 60s before exit (use to force timeouts)
//   "MOCK_INVALID_JSON" — emit garbage that isn't JSON
//   anything else        — emit a normal response

import { argv, stdout, stderr, exit } from "node:process";

const args = argv.slice(2);

function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const prompt = flagValue("-p") ?? "";
const outputFormat = flagValue("--output-format") ?? "json";
const system = flagValue("--system");
const resume = flagValue("--resume");
const model = flagValue("--model") ?? "claude-sonnet-4-6";

// Deterministic mock session id derived from inputs for assertion stability.
function mockSessionId() {
  if (resume) return resume;
  return `mock-session-${Buffer.from(prompt).toString("hex").slice(0, 8)}`;
}

const sessionId = mockSessionId();

// Behavioral triggers
if (prompt.includes("MOCK_ERROR")) {
  stderr.write("mock error\n");
  exit(1);
}

if (prompt.includes("MOCK_SLEEP_FOREVER")) {
  await new Promise(() => {}); // never resolves
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

if (outputFormat === "stream-json") {
  // Stream the response as NDJSON, one event per line, matching Claude Code's
  // stream-json shape (system init, assistant message, result).
  stdout.write(
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model }) +
      "\n"
  );
  // Split response into a few chunks to exercise streaming parsers.
  const chunks = responseText.match(/.{1,8}/g) ?? [responseText];
  for (const chunk of chunks) {
    stdout.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: chunk }] }
      }) + "\n"
    );
  }
  stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      result: responseText
    }) + "\n"
  );
} else {
  // One-shot JSON: single object on stdout.
  stdout.write(
    JSON.stringify({
      session_id: sessionId,
      model,
      result: responseText
    })
  );
}

exit(0);
```

- [ ] **Step 2: Create the fixture package.json**

Create `tests/fixtures/mock-claude/package.json`:

```json
{
  "name": "mock-claude",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "mock-claude": "./index.mjs"
  }
}
```

- [ ] **Step 3: Make the script executable (no-op on Windows but matters on macOS)**

Run: `chmod +x tests/fixtures/mock-claude/index.mjs`
On Windows the file mode flag isn't meaningful; the command exits cleanly. On macOS it ensures the shebang line works when invoked directly.

- [ ] **Step 4: Smoke-test the fixture by running it directly**

Run:
```
node tests/fixtures/mock-claude/index.mjs -p "hello" --output-format json
```

Expected stdout: a single JSON object with `session_id`, `model`, `result` fields. Result should be `"echo: hello"`.

Then run:
```
node tests/fixtures/mock-claude/index.mjs -p "hello" --output-format stream-json
```

Expected stdout: three NDJSON lines — a `system init`, one or more `assistant` events, then a `result` event.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/mock-claude
git commit -m "test(fixture): add mock-claude CLI stub for hermetic backend tests"
```

---

## Task 2: Shared runner types

**Files:**
- Create: `src/runners/types.ts`
- Test: `tests/unit/runners/types.test.ts`

Types shared between the one-shot and streaming runners. Kept in their own file so both modules can import without circular dependencies.

- [ ] **Step 1: Write the failing type-level test**

Create `tests/unit/runners/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type {
  ClaudeRunOptions,
  ClaudeRunResult,
  ClaudeStreamOptions
} from "../../../src/runners/types.js";

describe("runner types", () => {
  it("constructs a minimal ClaudeRunOptions", () => {
    const opts: ClaudeRunOptions = {
      prompt: "hello",
      timeoutMs: 60000,
      claudeCommand: "claude"
    };
    expect(opts.prompt).toBe("hello");
  });

  it("accepts string-array claudeCommand for shim prefixes (e.g. wsl)", () => {
    const opts: ClaudeRunOptions = {
      prompt: "hello",
      timeoutMs: 60000,
      claudeCommand: ["wsl", "claude"]
    };
    expect(Array.isArray(opts.claudeCommand)).toBe(true);
  });

  it("ClaudeRunResult carries every documented field", () => {
    const result: ClaudeRunResult = {
      text: "ok",
      sessionId: "s1",
      exitCode: 0,
      durationMs: 12,
      timedOut: false,
      stderr: ""
    };
    expect(result.sessionId).toBe("s1");
  });

  it("ClaudeRunResult.sessionId may be null", () => {
    const result: ClaudeRunResult = {
      text: "",
      sessionId: null,
      exitCode: -1,
      durationMs: 0,
      timedOut: false,
      stderr: "spawn error"
    };
    expect(result.sessionId).toBeNull();
  });

  it("ClaudeStreamOptions adds optional systemPrompt", () => {
    const opts: ClaudeStreamOptions = {
      prompt: "hello",
      systemPrompt: "you are helpful",
      timeoutMs: 60000,
      claudeCommand: "claude"
    };
    expect(opts.systemPrompt).toBe("you are helpful");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/runners/types.test.ts`
Expected: FAIL — module `src/runners/types.js` not found.

- [ ] **Step 3: Create `src/runners/types.ts`**

```ts
export interface ClaudeRunOptions {
  /** Prompt body passed to claude via `-p`. */
  prompt: string;
  /** Working directory for the CLI process. Defaults to Node's CWD if omitted. */
  workDir?: string;
  /** Resume an existing Claude session by id (passed via `--resume`). */
  resumeSessionId?: string;
  /** Comma-separated allowed tools list (passed via `--allowed-tools`). */
  allowedTools?: string;
  /** When true, pass `--dangerously-skip-permissions` and omit `--allowed-tools`. */
  dangerouslySkipPermissions?: boolean;
  /** Kill the process tree after this many ms. */
  timeoutMs: number;
  /**
   * Either a single executable name/path or an array where the head is the
   * executable and the tail is a fixed prefix of arguments (useful for `wsl claude`).
   */
  claudeCommand: string | string[];
}

export interface ClaudeRunResult {
  /** Extracted text response from the CLI output. */
  text: string;
  /** Session id parsed from JSON output, or null on error / unparseable. */
  sessionId: string | null;
  /** Process exit code. -1 for spawn failure, 124 (or process code) for timeout. */
  exitCode: number;
  /** Wall-clock milliseconds from spawn to close. */
  durationMs: number;
  /** True if the run hit the configured timeout. */
  timedOut: boolean;
  /** Concatenated stderr output, including any "[spawn error]" annotations. */
  stderr: string;
}

export interface ClaudeStreamOptions extends Omit<ClaudeRunOptions, never> {
  /** Optional system prompt passed via `--system`. */
  systemPrompt?: string;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/runners/types.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/runners/types.ts tests/unit/runners/types.test.ts
git commit -m "feat(runners): add shared option/result types for Claude CLI invokers"
```

---

## Task 3: One-shot Claude runner

**Files:**
- Create: `src/runners/claudeRunner.ts`
- Test: `tests/unit/runners/claudeRunner.test.ts`

Port the existing `dist/claudeRunner.js` to TypeScript under `src/runners/`. Function signature: `runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult>`. Behavior matches the existing JS verbatim. Tests run against the mock-claude fixture from Task 1.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runners/claudeRunner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { buildArgs, runClaude } from "../../../src/runners/claudeRunner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_CLAUDE = ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")];

describe("buildArgs", () => {
  it("emits -p prompt and --output-format json by default", () => {
    expect(
      buildArgs({
        prompt: "hi",
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).toEqual(["-p", "hi", "--output-format", "json"]);
  });

  it("prepends --resume when resumeSessionId is set", () => {
    expect(
      buildArgs({
        prompt: "hi",
        resumeSessionId: "sess-1",
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).toEqual(["--resume", "sess-1", "-p", "hi", "--output-format", "json"]);
  });

  it("appends --dangerously-skip-permissions when requested", () => {
    expect(
      buildArgs({
        prompt: "hi",
        dangerouslySkipPermissions: true,
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).toContain("--dangerously-skip-permissions");
  });

  it("appends --allowed-tools when given and not dangerouslySkip", () => {
    const args = buildArgs({
      prompt: "hi",
      allowedTools: "Read,Edit",
      timeoutMs: 1000,
      claudeCommand: "claude"
    });
    expect(args).toContain("--allowed-tools");
    expect(args[args.indexOf("--allowed-tools") + 1]).toBe("Read,Edit");
  });

  it("dangerouslySkipPermissions wins over allowedTools", () => {
    const args = buildArgs({
      prompt: "hi",
      allowedTools: "Read",
      dangerouslySkipPermissions: true,
      timeoutMs: 1000,
      claudeCommand: "claude"
    });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allowed-tools");
  });
});

describe("runClaude (against mock-claude)", () => {
  it("extracts text from a normal response", async () => {
    const result = await runClaude({
      prompt: "hello",
      timeoutMs: 5000,
      claudeCommand: MOCK_CLAUDE
    });
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("echo: hello");
    expect(result.sessionId).toMatch(/^mock-session-/);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toBe("");
  });

  it("returns sessionId null and stderr when CLI exits non-zero", async () => {
    const result = await runClaude({
      prompt: "please MOCK_ERROR now",
      timeoutMs: 5000,
      claudeCommand: MOCK_CLAUDE
    });
    expect(result.exitCode).toBe(1);
    expect(result.sessionId).toBeNull();
    expect(result.stderr).toContain("mock error");
  });

  it("falls back to raw stdout when JSON parse fails", async () => {
    const result = await runClaude({
      prompt: "give me MOCK_INVALID_JSON",
      timeoutMs: 5000,
      claudeCommand: MOCK_CLAUDE
    });
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("this is not json at all");
    expect(result.sessionId).toBeNull();
  });

  it("times out after timeoutMs and kills the process", async () => {
    const start = Date.now();
    const result = await runClaude({
      prompt: "MOCK_SLEEP_FOREVER now",
      timeoutMs: 250,
      claudeCommand: MOCK_CLAUDE
    });
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it("returns spawn-failure result when binary is missing", async () => {
    const result = await runClaude({
      prompt: "hello",
      timeoutMs: 5000,
      claudeCommand: "definitely-not-a-real-binary-xyz"
    });
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("spawn error");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/runners/claudeRunner.test.ts`
Expected: FAIL — module `src/runners/claudeRunner.js` not found.

- [ ] **Step 3: Create `src/runners/claudeRunner.ts`**

```ts
import spawn from "cross-spawn";
import treeKill from "tree-kill";
import type { ClaudeRunOptions, ClaudeRunResult } from "./types.js";

/**
 * Build the argv array for `claude -p ...`. Pure; no side effects.
 * Exported for unit testing without spawning the CLI.
 */
export function buildArgs(opts: ClaudeRunOptions): string[] {
  const args: string[] = [];
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }
  args.push("-p", opts.prompt);
  args.push("--output-format", "json");
  if (opts.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else if (opts.allowedTools !== undefined) {
    args.push("--allowed-tools", opts.allowedTools);
  }
  return args;
}

function splitCommand(
  cmd: string | string[]
): [string, string[]] {
  if (Array.isArray(cmd)) {
    const [head, ...rest] = cmd;
    if (!head) throw new Error("claudeCommand array must be non-empty");
    return [head, rest];
  }
  return [cmd, []];
}

function parseSessionId(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      const sid = parsed["session_id"] ?? parsed["sessionId"];
      return typeof sid === "string" ? sid : null;
    }
  } catch {
    // Not JSON — some error paths emit plain text. Caller handles fallback.
  }
  return null;
}

function extractText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const result = parsed["result"] ?? parsed["output"] ?? parsed["text"];
    if (typeof result === "string") return result;
    return JSON.stringify(parsed);
  } catch {
    return trimmed;
  }
}

export function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const args = buildArgs(opts);
    const [cmd, prefixArgs] = splitCommand(opts.claudeCommand);
    // cross-spawn handles Windows .cmd/.bat resolution and proper arg
    // escaping without needing shell:true, avoiding the standard spawn
    // quoting bugs when prompts contain spaces or special characters.
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
      resolve({
        text: extractText(stdout),
        sessionId: exitCode === 0 ? parseSessionId(stdout) : null,
        exitCode,
        durationMs,
        timedOut,
        stderr
      });
    });
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/runners/claudeRunner.test.ts`
Expected: PASS — all 10 tests green (5 buildArgs + 5 against mock-claude).

- [ ] **Step 5: Commit**

```bash
git add src/runners/claudeRunner.ts tests/unit/runners/claudeRunner.test.ts
git commit -m "feat(runners): add one-shot claudeRunner with buildArgs + spawn lifecycle"
```

---

## Task 4: Streaming Claude runner

**Files:**
- Create: `src/runners/claudeStreamRunner.ts`
- Test: `tests/unit/runners/claudeStreamRunner.test.ts`

Port the existing `dist/claudeStreamRunner.js` to TypeScript. Function signature: `runClaudeStream(opts: ClaudeStreamOptions): AsyncIterable<unknown>`. Yields one parsed JSON object per output line from the CLI's `--output-format stream-json`. Handles partial-line buffering and trailing-line flush.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runners/claudeStreamRunner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import {
  buildStreamArgs,
  runClaudeStream
} from "../../../src/runners/claudeStreamRunner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_CLAUDE = ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")];

describe("buildStreamArgs", () => {
  it("emits -p prompt and --output-format stream-json", () => {
    expect(
      buildStreamArgs({
        prompt: "hi",
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).toEqual(["-p", "hi", "--output-format", "stream-json"]);
  });

  it("prepends --system when systemPrompt is set", () => {
    const args = buildStreamArgs({
      prompt: "hi",
      systemPrompt: "you are helpful",
      timeoutMs: 1000,
      claudeCommand: "claude"
    });
    expect(args).toEqual([
      "--system",
      "you are helpful",
      "-p",
      "hi",
      "--output-format",
      "stream-json"
    ]);
  });

  it("inserts --resume between --system and -p", () => {
    const args = buildStreamArgs({
      prompt: "hi",
      systemPrompt: "sys",
      resumeSessionId: "sess-1",
      timeoutMs: 1000,
      claudeCommand: "claude"
    });
    expect(args).toEqual([
      "--system",
      "sys",
      "--resume",
      "sess-1",
      "-p",
      "hi",
      "--output-format",
      "stream-json"
    ]);
  });

  it("appends --dangerously-skip-permissions when requested", () => {
    expect(
      buildStreamArgs({
        prompt: "hi",
        dangerouslySkipPermissions: true,
        timeoutMs: 1000,
        claudeCommand: "claude"
      })
    ).toContain("--dangerously-skip-permissions");
  });
});

describe("runClaudeStream (against mock-claude)", () => {
  async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const ev of stream) out.push(ev);
    return out;
  }

  it("yields system init, assistant chunks, and result events in order", async () => {
    const events = await collect(
      runClaudeStream({
        prompt: "hello",
        timeoutMs: 5000,
        claudeCommand: MOCK_CLAUDE
      })
    );
    expect(events.length).toBeGreaterThanOrEqual(3);

    const first = events[0] as { type: string; subtype?: string };
    expect(first.type).toBe("system");
    expect(first.subtype).toBe("init");

    const last = events[events.length - 1] as { type: string };
    expect(last.type).toBe("result");
  });

  it("yields nothing extra when prompt triggers MOCK_INVALID_JSON (lines are skipped)", async () => {
    const events = await collect(
      runClaudeStream({
        prompt: "MOCK_INVALID_JSON",
        timeoutMs: 5000,
        claudeCommand: MOCK_CLAUDE
      })
    );
    // mock-claude emits a non-JSON line then exits. Stream runner silently
    // drops unparseable lines, so the iterator completes with zero events.
    expect(events).toEqual([]);
  });

  it("stops iterating after timeout kills the process", async () => {
    const events = await collect(
      runClaudeStream({
        prompt: "MOCK_SLEEP_FOREVER",
        timeoutMs: 250,
        claudeCommand: MOCK_CLAUDE
      })
    );
    // No events emitted before kill.
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/runners/claudeStreamRunner.test.ts`
Expected: FAIL — module `src/runners/claudeStreamRunner.js` not found.

- [ ] **Step 3: Create `src/runners/claudeStreamRunner.ts`**

```ts
import spawn from "cross-spawn";
import treeKill from "tree-kill";
import type { ClaudeStreamOptions } from "./types.js";

/**
 * Build argv for `claude -p ... --output-format stream-json`. Pure; no side effects.
 */
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
  if (opts.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else if (opts.allowedTools !== undefined) {
    args.push("--allowed-tools", opts.allowedTools);
  }
  return args;
}

function splitCommand(
  cmd: string | string[]
): [string, string[]] {
  if (Array.isArray(cmd)) {
    const [head, ...rest] = cmd;
    if (!head) throw new Error("claudeCommand array must be non-empty");
    return [head, rest];
  }
  return [cmd, []];
}

export async function* runClaudeStream(
  opts: ClaudeStreamOptions
): AsyncIterable<unknown> {
  const args = buildStreamArgs(opts);
  const [cmd, prefixArgs] = splitCommand(opts.claudeCommand);
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
    // Flush any residual buffered line that wasn't terminated with \n
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
      yield queue.shift();
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

Run: `npx vitest run tests/unit/runners/claudeStreamRunner.test.ts`
Expected: PASS — all 7 tests green (4 buildStreamArgs + 3 against mock-claude).

- [ ] **Step 5: Commit**

```bash
git add src/runners/claudeStreamRunner.ts tests/unit/runners/claudeStreamRunner.test.ts
git commit -m "feat(runners): add streaming claudeStreamRunner with NDJSON line parsing"
```

---

## Task 5: Claude backend skeleton

**Files:**
- Create: `src/backends/claudeBackend.ts`
- Test: `tests/unit/backends/claudeBackend.test.ts`

Implements the `Backend` interface from Plan 01. This task lands the static surface (id, capabilities, listModels, countTokens) and a constructor that accepts a config slice. `invoke()` is stubbed to throw — that lands in Task 6.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/backends/claudeBackend.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ClaudeBackend } from "../../../src/backends/claudeBackend.js";

describe("ClaudeBackend skeleton", () => {
  function makeBackend(): ClaudeBackend {
    return new ClaudeBackend({
      command: "claude",
      timeoutMs: 60000
    });
  }

  it("has id 'claude'", () => {
    expect(makeBackend().id).toBe("claude");
  });

  it("listModels returns the curated Claude model catalog", async () => {
    const models = await makeBackend().listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("claude-opus-4-7");
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("claude-haiku-4-5");
  });

  it("each ModelDescriptor exposes context window and capability flags", async () => {
    const models = await makeBackend().listModels();
    for (const m of models) {
      expect(typeof m.contextWindow).toBe("number");
      expect(typeof m.supportsTools).toBe("boolean");
      expect(typeof m.supportsVision).toBe("boolean");
    }
  });

  it("capabilitiesFor(model) returns claude CLI's actual surface", () => {
    const caps = makeBackend().capabilitiesFor("claude-sonnet-4-6");
    expect(caps.toolUse).toBe(true);             // landed in Plan 04
    expect(caps.multimodal).toBe(true);          // model-dependent; conservative true
    expect(caps.thinking).toBe(true);
    expect(caps.cacheControl).toBe("none");      // local-emulation lands via responseCache in Plan 05
    expect(caps.samplingParams).toEqual({
      temperature: false,
      topP: false,
      topK: false
    });
    expect(caps.stopSequences).toBe("server-side-cut");
    expect(caps.embeddings).toBe(false);
  });

  it("capabilitiesFor(haiku) reports the same surface (model-specific narrowing happens later)", () => {
    const caps = makeBackend().capabilitiesFor("claude-haiku-4-5");
    expect(caps.embeddings).toBe(false);
    expect(caps.samplingParams.temperature).toBe(false);
  });

  it("countTokens returns an estimate (char/4 fallback in Plan 02)", async () => {
    const tokens = await makeBackend().countTokens({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello world hello world" }]
        }
      ]
    });
    // char/4 fallback: "hello world hello world" = 23 chars → ceil(23/4) = 6
    expect(tokens).toBe(6);
  });

  it("countTokens sums across multiple text blocks and system", async () => {
    const tokens = await makeBackend().countTokens({
      model: "claude-sonnet-4-6",
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
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      })) {
        // no-op
      }
    }).rejects.toThrow(/invoke/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/backends/claudeBackend.test.ts`
Expected: FAIL — module `src/backends/claudeBackend.js` not found.

- [ ] **Step 3: Create `src/backends/claudeBackend.ts`**

```ts
import type {
  Backend,
  BackendCapabilities,
  ModelDescriptor,
  NormalizedEvent,
  NormalizedRequest
} from "./types.js";

export interface ClaudeBackendConfig {
  /** Either the executable name (e.g. "claude") or [executable, ...prefix-args]. */
  command: string | string[];
  /** Per-call timeout in milliseconds. */
  timeoutMs: number;
}

/**
 * Curated catalog of Claude models the backend reports. The CLI itself has no
 * model-listing endpoint, so this is maintained here. When Anthropic ships a
 * new model id, add it to this list and `capabilitiesFor` if its surface differs.
 */
const MODEL_CATALOG: ModelDescriptor[] = [
  {
    id: "claude-opus-4-7",
    contextWindow: 200000,
    supportsTools: true,
    supportsVision: true,
    description: "Most capable Claude model. Extended thinking supported."
  },
  {
    id: "claude-sonnet-4-6",
    contextWindow: 200000,
    supportsTools: true,
    supportsVision: true,
    description: "Balanced capability/cost. Extended thinking supported."
  },
  {
    id: "claude-haiku-4-5",
    contextWindow: 200000,
    supportsTools: true,
    supportsVision: true,
    description: "Fastest, cheapest Claude model."
  }
];

/**
 * Char-count token estimator. ceil(charCount / 4) is a standard rough
 * approximation for English-text BPE; later plans swap in `@anthropic-ai/tokenizer`
 * when the dependency is available, but for Plan 02 this is what ships.
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
      // image / document blocks: ignored for now; Plan 05 adds proper accounting.
    }
  }
  return total;
}

export class ClaudeBackend implements Backend {
  readonly id = "claude" as const;

  constructor(private readonly config: ClaudeBackendConfig) {}

  capabilitiesFor(_model: string): BackendCapabilities {
    // Same surface across all Claude models for now. Per-model narrowing
    // (e.g., a hypothetical text-only model losing supportsVision) lands
    // when needed.
    return {
      toolUse: true,
      multimodal: true,
      thinking: true,
      cacheControl: "none",
      samplingParams: { temperature: false, topP: false, topK: false },
      stopSequences: "server-side-cut",
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
    throw new Error("ClaudeBackend.invoke() lands in Plan 02 Task 6");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/backends/claudeBackend.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backends/claudeBackend.ts tests/unit/backends/claudeBackend.test.ts
git commit -m "feat(claudeBackend): add skeleton with id, capabilities, listModels, countTokens"
```

---

## Task 6: ClaudeBackend.invoke() — request translation + event normalization

**Files:**
- Modify: `src/backends/claudeBackend.ts`
- Modify: `tests/unit/backends/claudeBackend.test.ts`

Wire the `claudeStreamRunner` into `ClaudeBackend.invoke()`. Translates `NormalizedRequest` → `ClaudeStreamOptions`, spawns the runner, translates each raw CLI stream event into a `NormalizedEvent`.

Scope reminder (Plan 02 vs Plan 04):
- **Plan 02 (here):** text-only message content, no native tool_use, no multimodal, no stop_sequences server-side cut, no tool_choice directives, no thinking blocks emitted by the model.
- **Plan 04 (later):** all of the above.

If a `NormalizedRequest` arrives with content blocks Plan 02 can't handle (image, document, tool_use, tool_result), the method should throw a descriptive error — better to fail loudly than emit garbage.

- [ ] **Step 1: Add the failing tests**

Append to `tests/unit/backends/claudeBackend.test.ts`, after the existing tests inside the same `describe` block:

```ts
  it("invoke streams: emits message_start, text_delta(s), message_stop in order", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
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
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
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
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "claude-sonnet-4-6",
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
    // The mock echoes back the prompt. The folded prompt should include all
    // three messages clearly delimited by role.
    expect(text).toContain("user: first");
    expect(text).toContain("assistant: ok");
    expect(text).toContain("user: second");
  });

  it("invoke throws on multimodal content (Plan 02 scope is text-only)", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });

    await expect(async () => {
      for await (const _ of backend.invoke({
        model: "claude-sonnet-4-6",
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

  it("invoke throws on tools array (Plan 02 scope is no-tools)", async () => {
    const backend = new ClaudeBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-claude", "index.mjs")],
      timeoutMs: 5000
    });

    await expect(async () => {
      for await (const _ of backend.invoke({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "calc", inputSchema: {} }]
      })) {
        // no-op
      }
    }).rejects.toThrow(/tool/i);
  });
```

Also add the missing imports at the top of the test file:

```ts
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { NormalizedEvent } from "../../../src/backends/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run tests/unit/backends/claudeBackend.test.ts`
Expected: 8 original tests pass, 5 new tests FAIL (invoke not implemented, or throws the placeholder error).

- [ ] **Step 3: Replace the invoke() stub in `src/backends/claudeBackend.ts`**

Add this import near the top (with the existing type-only imports):

```ts
import { runClaudeStream } from "../runners/claudeStreamRunner.js";
import type { ClaudeStreamOptions } from "../runners/types.js";
```

Then replace the `invoke()` method with the real implementation:

```ts
  async *invoke(
    req: NormalizedRequest
  ): AsyncIterable<NormalizedEvent> {
    this.assertPlan02Scope(req);

    const streamOpts: ClaudeStreamOptions = {
      prompt: this.foldMessagesToPrompt(req),
      systemPrompt: req.system,
      timeoutMs: this.config.timeoutMs,
      claudeCommand: this.config.command,
      dangerouslySkipPermissions: true
    };

    let startEmitted = false;
    let textIndex = 0;
    let textOpen = false;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const raw of runClaudeStream(streamOpts)) {
      const ev = raw as {
        type?: string;
        subtype?: string;
        session_id?: string;
        model?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
        usage?: { input_tokens?: number; output_tokens?: number };
        is_error?: boolean;
      };

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
            yield { kind: "text_delta", index: textIndex, text: block.text };
            textOpen = true;
          }
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
          stopReason: ev.is_error ? "error" : "end_turn",
          usage: inputTokens + outputTokens > 0
            ? { inputTokens, outputTokens }
            : undefined
        };
        return;
      }
    }

    // Stream ended without an explicit result event (e.g. process killed by
    // timeout). Emit a synthesized message_stop so callers always see one.
    if (!startEmitted) {
      yield { kind: "message_start", model: req.model };
    }
    yield { kind: "message_stop", stopReason: "error" };
  }

  // ---- Plan-02 scope helpers ---------------------------------------------

  private assertPlan02Scope(req: NormalizedRequest): void {
    if (req.tools && req.tools.length > 0) {
      throw new Error(
        "ClaudeBackend (Plan 02): native tool calling lands in Plan 04"
      );
    }
    if (req.stopSequences && req.stopSequences.length > 0) {
      throw new Error(
        "ClaudeBackend (Plan 02): stop_sequences server-side cut lands in Plan 04"
      );
    }
    for (const msg of req.messages) {
      for (const block of msg.content) {
        if (block.type === "image" || block.type === "document") {
          throw new Error(
            "ClaudeBackend (Plan 02): multimodal content lands in Plan 04"
          );
        }
        if (block.type === "tool_use" || block.type === "tool_result") {
          throw new Error(
            "ClaudeBackend (Plan 02): tool_use/tool_result round-trip lands in Plan 04"
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/backends/claudeBackend.test.ts`
Expected: PASS — all 13 tests green (8 original + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/backends/claudeBackend.ts tests/unit/backends/claudeBackend.test.ts
git commit -m "feat(claudeBackend): wire invoke() through claudeStreamRunner with event normalization"
```

---

## Task 7: End-to-end integration test through the registry

**Files:**
- Create: `tests/integration/claudeBackend.test.ts`

Final verification: register the Claude backend in a fresh `BackendRegistry`, probe it, route a `NormalizedRequest` end-to-end, iterate the stream, assert wire-shape parity. Confirms that the new module slots into the Plan-01 foundation without changes to the foundation modules.

- [ ] **Step 1: Write the test**

Create `tests/integration/claudeBackend.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { BackendRegistry } from "../../src/backends/registry.js";
import { ClaudeBackend } from "../../src/backends/claudeBackend.js";
import type { NormalizedEvent } from "../../src/backends/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_CLAUDE = ["node", join(__dirname, "..", "fixtures", "mock-claude", "index.mjs")];

describe("ClaudeBackend integrates with BackendRegistry", () => {
  it("registers, probes, resolves a Claude model, invokes end-to-end", async () => {
    const registry = new BackendRegistry({ claude: 100 });
    const claude = new ClaudeBackend({
      command: MOCK_CLAUDE,
      timeoutMs: 5000
    });
    registry.register(claude);

    try {
      await registry.probe();

      // listModels populated the registry's model map.
      expect(registry.resolveModel("claude-opus-4-7")?.id).toBe("claude");
      expect(registry.resolveModel("claude-sonnet-4-6")?.id).toBe("claude");
      expect(registry.resolveModel("claude-haiku-4-5")?.id).toBe("claude");

      // Invoke the resolved backend end-to-end.
      const resolved = registry.resolveModel("claude-sonnet-4-6");
      expect(resolved).toBeDefined();

      const events: NormalizedEvent[] = [];
      for await (const ev of resolved!.invoke({
        model: "claude-sonnet-4-6",
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
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ type: "text", text: "integration ping" }] }]
      });
      expect(tokens).toBeGreaterThan(0);
    } finally {
      registry.stop();
    }
  });

  it("registry priority places Claude on top by default (priority 100)", async () => {
    const registry = new BackendRegistry({ claude: 100 });
    registry.register(
      new ClaudeBackend({ command: MOCK_CLAUDE, timeoutMs: 5000 })
    );

    try {
      await registry.probe();
      const status = registry.lastProbeStatus("claude");
      expect(status?.ok).toBe(true);
    } finally {
      registry.stop();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run tests/integration/claudeBackend.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: All tests pass — 57 from Plan 01 + the new Plan 02 tests (5 types + 10 claudeRunner + 7 claudeStreamRunner + 13 claudeBackend + 2 integration = 37 new) = 94 total.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/claudeBackend.test.ts
git commit -m "test(claudeBackend): integration with BackendRegistry — end-to-end through mock CLI"
```

---

## Task 8: Plan-02 close-out documentation

**Files:**
- Create: `docs/plan-02-claude-backend-readme.md`

- [ ] **Step 1: Write the document**

```markdown
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
| `tests/unit/backends/claudeBackend.test.ts` | Capability matrix, listModels, countTokens, invoke (13 cases) |
| `tests/integration/claudeBackend.test.ts` | End-to-end through `BackendRegistry` (2 cases) |

Run all: `npm test` — expect 94 tests passing.

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
```

- [ ] **Step 2: Commit**

```bash
git add docs/plan-02-claude-backend-readme.md
git commit -m "docs: add Plan 02 close-out README documenting Claude backend scope and boundaries"
```

---

## Plan 02 — Self-review checklist

Before declaring Plan 02 done, run through this checklist:

- [ ] `npm test` — all 94 tests green, no skips.
- [ ] `npx tsc --noEmit` — no type errors.
- [ ] `git status` — clean tree, all changes committed (except pre-existing untracked files like `scripts/configure-agent-zero.sh`).
- [ ] `git log --oneline -15` — commits read sensibly: fixture, types, runner, stream-runner, backend skeleton, backend invoke, integration, README.
- [ ] `src/runners/` directory contains 3 files (types, claudeRunner, claudeStreamRunner) — no others.
- [ ] `src/backends/claudeBackend.ts` exists and implements the `Backend` interface from `src/backends/types.ts`.
- [ ] Mock-claude fixture is executable on macOS (`-rwxr-xr-x` permission visible via `git ls-files --stage`).
- [ ] No source file under `src/` exceeds 300 lines (`claudeBackend.ts` at ~180 is the largest).
- [ ] `dist/` directory is untouched (compare `git log dist/ -5` — last touch should predate this plan).
- [ ] No new direct dependencies on `dist/` from anywhere under `src/` or `tests/`.

If all check, Plan 02 is shipped. Open a PR to main; Plan 03 follows.
