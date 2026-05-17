# Plan 13: SDK × Backend Compatibility Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify ClaudeMCP is a true "1:1 replacement" for the three first-party SDKs it pretends to be — `@anthropic-ai/sdk`, `openai`, and `@google/generative-ai` — against every backend (Claude, Gemini, LM Studio, Ollama) using only the mock CLIs / mock HTTP servers from prior plans. After Plan 13, the matrix of (3 SDKs × 4 backends — minus a handful of nonsensical cells) is exercised end-to-end on each `npm test` run, so any future drift in the shim's wire envelope will surface as an SDK-layer throw rather than a silent payload deformation.

**Architecture:** A single helper module (`tests/compat/setup.ts`) builds a fully configured ClaudeMCP server instance against a chosen subset of mock backends on a port-0 socket, hands back `{baseURL, apiKey, teardown}`, and lets each compat test instantiate the real SDK pointed at that URL. Three test files — one per SDK — drive the SDK's documented API surface (chat/messages, count_tokens, files lifecycle, models list, embeddings where relevant) and assert the SDK's parser accepts the response. Backends are parameterized via Vitest's `describe.each` so each SDK file enumerates its own (SDK × backend) cells. Skip semantics are encoded with `it.skip` carrying a clear reason, not by excluding whole describes.

**Tech Stack:** Same as Plans 01-12 — Node.js 20+, TypeScript 5 (NodeNext ESM, `noUncheckedIndexedAccess`), Vitest. Three new `devDependencies` — `@anthropic-ai/sdk`, `openai`, `@google/generative-ai` — pinned to the versions current at write time. No new runtime dependencies. Reuses the in-process / subprocess mock fixtures from Plans 08 (mock-lmstudio) and 09 (mock-ollama), plus the CLI mocks from Plans 02 (mock-claude) and 06 (mock-gemini).

**Spec:** `docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md` (Phase 13: Compat tests).

**Builds on:**
- All prior plans (01-12). Specifically:
  - Plan 01 — `Backend`, `BackendRegistry`, `loadConfig`, `buildRegistry`.
  - Plan 02 — `ClaudeBackend` + `mock-claude` fixture on PATH.
  - Plan 03 — Anthropic shim (`/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`).
  - Plan 04 — Tool-use + multimodal round-trip on the Anthropic shim.
  - Plan 05 — Files API (`/v1/files*`), response cache, archive.
  - Plan 06 — `GeminiBackend` + `mock-gemini` fixture on PATH.
  - Plan 07 — Gemini shim (`/v1beta/models/*`, `/v1beta/files*`).
  - Plan 08 — `LMStudioBackend` + `mock-lmstudio` in-process / subprocess fixture.
  - Plan 09 — `OllamaBackend` + `mock-ollama` subprocess fixture (dual-API).
  - Plan 10 — OpenAI shim multi-backend dispatch + `/v1/embeddings` HTTP endpoint.
  - Plan 11 — Admin endpoints (`/admin/backends*`, `/admin/config*`, `/admin/archive*`).
  - Plan 12 — Admin UI (not exercised by this plan, but the routes must coexist).

**Reference plans (read these before starting):**
- `docs/superpowers/plans/2026-05-16-plan-03-anthropic-shim.md` — the Anthropic shim surface this plan drives.
- `docs/superpowers/plans/2026-05-16-plan-07-gemini-shim.md` — the Gemini shim surface this plan drives.
- `docs/superpowers/plans/2026-05-16-plan-08-lmstudio-backend.md` — multi-backend setup pattern + `startMockLmStudio` API.
- `docs/superpowers/plans/2026-05-16-plan-09-ollama-backend.md` — mock-ollama spawner + dual-mode flag flow.

---

## Scope boundary for Plan 13

What ships here:

| Feature | Plan 13 disposition |
|---|---|
| `tests/compat/setup.ts` test harness — boot a configured server on port 0 against the chosen mock backends; return `{baseURL, apiKey, teardown}` | Shipped |
| `tests/compat/anthropic-sdk.test.ts` — real `@anthropic-ai/sdk` × 4 backends covering `messages.create` (stream + non-stream), `messages.countTokens`, `files.upload/list/retrieve/delete`, `models.list` | Shipped |
| `tests/compat/openai-sdk.test.ts` — real `openai` × 4 backends covering `chat.completions.create` (stream + non-stream); × {lmstudio, ollama} only for `embeddings.create` | Shipped |
| `tests/compat/google-generative-ai-sdk.test.ts` — real `@google/generative-ai` × 4 backends covering `generateContent`, `generateContentStream`, `countTokens`, `getModel`, full `files.*` lifecycle | Shipped |
| Three SDKs added to `devDependencies` of `package.json`, pinned at versions current as of plan write time | Shipped — see "Pinned SDK versions" below |
| `package.json` scripts: `test:compat` runs only `tests/compat/**`; `test` includes them by default; README documents `--exclude tests/compat/**` for the fast iteration loop | Shipped |
| `it.skip` with reason for combinations not meaningful (embeddings × Claude, embeddings × Gemini, any × disabled-backend) | Shipped |

What this plan does NOT ship:

| Feature | Plan 13 disposition | Lands in |
|---|---|---|
| Real-API verification (real Claude Max, real Gemini CLI, real LM Studio, real Ollama) | Out of scope — manual smoke test in `docs/smoke-test.md` covers that | Future smoke-test spec |
| Load testing / throughput benchmarks | Out of scope | Future plan if a use case appears |
| Mock-fidelity tests (verifying the mocks perfectly mimic the real APIs) | Out of scope — the mocks are deliberately simple | Ongoing — each backend plan owns its own mock |
| Per-SDK feature exhaustion (every option, every error mode) | Out of scope — this is wire-shape parity, not API exhaustion. Existing unit + integration tests cover behavior; Plan 13 covers shape | n/a |
| Streaming back-pressure / cancellation semantics across SDKs | Out of scope — covered by per-shim unit tests | n/a |
| Tool-use round-trip across all SDKs against all backends | Partial — one tool-use scenario per SDK per non-Ollama backend; full tool-call matrix not exercised | Future plan if drift surfaces |
| OpenAI-SDK Responses API (`responses.create`) | Out of scope — the OpenAI shim implements only `chat.completions` and `embeddings` (Plan 10) | Future plan if a consumer needs it |
| Anthropic-SDK message batches (`messages.batches.*`) | Out of scope — the spec lists `/v1/messages/batches*` as 501 not-implemented | Future plan |
| Anthropic-SDK citations | Out of scope — spec lists as 501 not-implemented across all backends | Future plan |
| Gemini-SDK grounding-metadata round-trip on non-Gemini backends | Out of scope — spec returns synthesized defaults, no assertion of real values | Future plan if a use case appears |

---

## Pinned SDK versions

These are the versions Plan 13 commits as `devDependencies`. The exact pin numbers are filled in by the implementer at the start of Task 1 by running `npm view <pkg> version` and recording the result inline. The plan body below uses placeholder symbols (`<ANTHROPIC_VERSION>`, `<OPENAI_VERSION>`, `<GOOGLE_GENAI_VERSION>`) to be replaced.

| Package | Pinned version (filled in by implementer) | Used by |
|---|---|---|
| `@anthropic-ai/sdk` | `^<ANTHROPIC_VERSION>` | `tests/compat/anthropic-sdk.test.ts` |
| `openai` | `^<OPENAI_VERSION>` | `tests/compat/openai-sdk.test.ts` |
| `@google/generative-ai` | `^<GOOGLE_GENAI_VERSION>` | `tests/compat/google-generative-ai-sdk.test.ts` |

The implementer records the actual pinned versions in the Plan-13 close-out README (Task 8), so future readers know what was tested against. If any SDK has rebranded or moved namespace at the time of execution (e.g., `@google/genai` superseding `@google/generative-ai`), use the current canonical package and document the swap in Task 8.

---

## File map

| File | Responsibility |
|---|---|
| `tests/compat/setup.ts` | NEW. Test helper: `buildCompatServer(opts: CompatServerOptions): Promise<CompatServerHandle>`. Boots a ClaudeMCP server on port 0 with the chosen backends registered against the supplied mock fixtures; returns `{baseURL, apiKey, registry, teardown}`. Caller is responsible for awaiting `teardown()` in `afterAll`. |
| `tests/compat/anthropic-sdk.test.ts` | NEW. Real `@anthropic-ai/sdk` pointed at the test server. Parameterized over `{claude, gemini, lmstudio, ollama}`. Exercises `messages.create` (stream + non-stream), `messages.countTokens`, full `files.*` lifecycle, `models.list`. |
| `tests/compat/openai-sdk.test.ts` | NEW. Real `openai` pkg pointed at the test server. Parameterized over `{claude, gemini, lmstudio, ollama}` for chat; over `{lmstudio, ollama}` only for `embeddings.create`. Skips `embeddings × claude` and `embeddings × gemini` with `it.skip` + reason. |
| `tests/compat/google-generative-ai-sdk.test.ts` | NEW. Real `@google/generative-ai` pkg. Parameterized over `{claude, gemini, lmstudio, ollama}`. Exercises `generateContent`, `generateContentStream`, `countTokens`, `getModel`, full `files.*` lifecycle. |
| `package.json` | EXTEND. Add three SDK packages to `devDependencies`. Add `test:compat` script. Document `--exclude tests/compat/**` in README. |
| `README.md` | EXTEND. Brief note on the compat suite and how to skip it during fast iteration (`npm test -- --exclude tests/compat/**`). |
| `docs/plan-13-compat-tests-readme.md` | NEW. Close-out documentation. |

---

## Pre-flight check

Before starting Task 1, confirm the prior plans are in place:

- [ ] `git log --oneline -15` shows the Plan-12 merge commit (or whichever plan immediately precedes Plan 13 in your branch lineage).
- [ ] `npm test` shows the full prior-plans suite passing (no skips that aren't already documented).
- [ ] `npx tsc --noEmit` clean.
- [ ] `src/server.ts` exposes a function (call it `buildServer(config) => {app, registry, ...}` or similar — exact name from Plan 01) that the compat setup can invoke. Verify by reading `src/server.ts`; if the function is named differently, adapt Task 2 accordingly.
- [ ] `src/backends/registry.ts` exports `BackendRegistry` with `register`, `probe`, `resolveModel`, `lastProbeStatus`, `stop`.
- [ ] All four backend implementations exist: `src/backends/claudeBackend.ts`, `geminiBackend.ts`, `lmstudioBackend.ts`, `ollamaBackend.ts`.
- [ ] All four shim surfaces exist:
  - `src/anthropicShim/` (Plans 03-05): `messages.ts`, `files.ts`, `models.ts`, `countTokens.ts`.
  - `src/geminiShim/` (Plan 07).
  - `src/openaiShim/` (Plan 10 — extended for multi-backend dispatch).
- [ ] All four mock fixtures exist:
  - `tests/fixtures/mock-claude/index.mjs` + `package.json`.
  - `tests/fixtures/mock-gemini/index.mjs` + `package.json`.
  - `tests/fixtures/mock-lmstudio/inProcess.ts` + `server.mjs`.
  - `tests/fixtures/mock-ollama/server.mjs`.
- [ ] `tests/helpers/mockOllamaProcess.ts` exists (Plan 09) for spawning the mock-ollama subprocess.
- [ ] The `mock-claude` and `mock-gemini` bins are reachable on PATH for tests (or invocable as `node tests/fixtures/mock-<name>/index.mjs` per the existing test pattern — match whichever Plans 02 and 06 settled on).
- [ ] `package.json` `"type": "module"` and Node `>=20` constraints unchanged.

If any check fails, stop and resolve before proceeding.

**SDK version sanity check** (do this before Task 1):

- [ ] Run `npm view @anthropic-ai/sdk version` and record the output. Latest stable is expected to be in the `0.30.x` - `0.40.x` family as of mid-2026; if a major (`1.x`) has shipped, prefer it and document the bump in Task 8's deviations section.
- [ ] Run `npm view openai version`. Latest is expected to be in the `4.x` - `5.x` family.
- [ ] Run `npm view @google/generative-ai version`. If the package has been renamed to `@google/genai` (Google has been migrating), use the new name and document.
- [ ] Replace the `<ANTHROPIC_VERSION>` / `<OPENAI_VERSION>` / `<GOOGLE_GENAI_VERSION>` placeholders below with the recorded versions before committing Task 1.

---

## Task 1: Add SDK devDependencies + test scripts

**Files:**
- Modify: `package.json`
- Modify: `README.md` (one paragraph on the compat suite)

The first concrete change. We add the three real SDKs as `devDependencies`, add the `test:compat` npm script, and document the fast-iteration `--exclude` pattern in the README so the next contributor isn't surprised when `npm test` takes longer.

- [ ] **Step 1: Record the pinned versions**

Run:
```bash
npm view @anthropic-ai/sdk version
npm view openai version
npm view @google/generative-ai version   # OR @google/genai if renamed
```

Note the three version strings — they become the `^x.y.z` carets in Step 2. Capture them in the plan margin (or your scratchpad) for use in Task 8's close-out README.

- [ ] **Step 2: Edit `package.json`**

Append to the `devDependencies` block (alphabetical order preserved):

```json
{
  "devDependencies": {
    "@anthropic-ai/sdk": "^<ANTHROPIC_VERSION>",
    "@google/generative-ai": "^<GOOGLE_GENAI_VERSION>",
    "@types/better-sqlite3": "^7.6.12",
    "@types/busboy": "^1.5.4",
    "@types/cross-spawn": "^6.0.6",
    "@types/express": "^4.17.21",
    "@types/node": "^22.10.0",
    "@types/supertest": "^7.0.0",
    "@types/uuid": "^10.0.0",
    "openai": "^<OPENAI_VERSION>",
    "supertest": "^7.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```

Append to the `scripts` block:

```json
{
  "scripts": {
    "test:compat": "vitest run tests/compat",
    "test:nocompat": "vitest run --exclude 'tests/compat/**'"
  }
}
```

Note: keep the existing `"test": "vitest run"` unchanged — it discovers `tests/compat/**` automatically through the existing `vitest.config.ts` `include: ["tests/**/*.test.ts"]` glob.

- [ ] **Step 3: Run `npm install`**

Run: `npm install`
Expected: three new packages resolve, lockfile updates, no peer-dep warnings of substance. If any peer-dep warning surfaces (e.g., the SDKs want a newer Node), document it in Task 8 and decide whether to bump `engines.node` or live with it.

- [ ] **Step 4: Verify the SDKs are importable**

Run:
```bash
node --input-type=module -e "import Anthropic from '@anthropic-ai/sdk'; console.log(typeof Anthropic);"
node --input-type=module -e "import OpenAI from 'openai'; console.log(typeof OpenAI);"
node --input-type=module -e "import {GoogleGenerativeAI} from '@google/generative-ai'; console.log(typeof GoogleGenerativeAI);"
```

Expected each: prints `function`. If the third one fails because the package was renamed, swap to:
```bash
node --input-type=module -e "import {GoogleGenAI} from '@google/genai'; console.log(typeof GoogleGenAI);"
```
and propagate the rename to the test file in Task 5.

- [ ] **Step 5: Update README.md**

Find the existing "Development" / "Testing" / "Architecture" section (whichever exists). Append a short paragraph (about 4-6 lines):

```markdown
### Compatibility test suite

`tests/compat/` exercises the real first-party SDKs (`@anthropic-ai/sdk`, `openai`, `@google/generative-ai`) against the running server with mock backends. These are the highest-signal "1:1 replacement" checks — if a wire envelope drifts, the SDK's own parser throws.

Default `npm test` includes them. For faster iteration on a specific feature, run `npm run test:nocompat` (or `npm test -- --exclude 'tests/compat/**'`). The compat suite alone runs via `npm run test:compat`.

The mock backends fulfill every request, so no real Anthropic / Google / LM Studio / Ollama installation is required.
```

- [ ] **Step 6: Sanity-check existing tests still pass**

Run: `npx vitest run`
Expected: same prior-plan count, no regressions. (Plan 13 hasn't added any tests yet — this confirms the SDK install didn't perturb anything via transitive deps.)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json README.md
git commit -m "deps: add @anthropic-ai/sdk, openai, @google/generative-ai as devDependencies for compat suite

Pinned to caret-ranged latest at <date>. Adds npm scripts test:compat and
test:nocompat for the fast-iteration loop. README documents the exclude
pattern.

No source change — devDependencies only."
```

---

## Task 2: Compat-test setup helper

**Files:**
- Create: `tests/compat/setup.ts`

The single shared helper every compat test imports. Its job: build a configured server, register the chosen mock backends, return a base URL + teardown. Each test parameterizes over backends, so this helper accepts an `enabledBackends` set and only spins up the fixtures actually needed.

- [ ] **Step 1: Write the helper**

Create `tests/compat/setup.ts`:

```ts
import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import { Server } from "node:http";
import { BackendRegistry } from "../../src/backends/registry.js";
import { ClaudeBackend } from "../../src/backends/claudeBackend.js";
import { GeminiBackend } from "../../src/backends/geminiBackend.js";
import { LMStudioBackend } from "../../src/backends/lmstudioBackend.js";
import { OllamaBackend } from "../../src/backends/ollamaBackend.js";
import { buildAnthropicShim } from "../../src/anthropicShim/index.js"; // adapt name per Plan 03
import { buildGeminiShim } from "../../src/geminiShim/index.js";       // adapt name per Plan 07
import { buildOpenAIShim } from "../../src/openaiShim/index.js";       // adapt name per Plan 10
import { buildAdminRouter } from "../../src/admin/index.js";           // adapt name per Plan 11
import { startMockLmStudio, type MockLmStudioHandle } from "../fixtures/mock-lmstudio/inProcess.js";
import { startMockOllama, type MockOllamaHandle } from "../helpers/mockOllamaProcess.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

/** Identifiers for the four backends the compat suite knows about. */
export type CompatBackendId = "claude" | "gemini" | "lmstudio" | "ollama";

export interface CompatServerOptions {
  /**
   * Which backends to register. The setup spins up only the fixtures needed.
   * Defaults to all four when omitted.
   */
  enabledBackends?: ReadonlyArray<CompatBackendId>;
  /**
   * API key clients must send. Defaults to a random string per setup() call
   * so tests don't accidentally share auth state.
   */
  apiKey?: string;
  /**
   * Override the file-store root. Default uses an OS temp dir so parallel
   * runs don't collide.
   */
  fileStoreRoot?: string;
}

export interface CompatServerHandle {
  /** Base URL of the running test server, e.g. http://127.0.0.1:54123. */
  baseURL: string;
  /** The API key clients must send. */
  apiKey: string;
  /** The BackendRegistry, exposed for advanced assertions. */
  registry: BackendRegistry;
  /** Stop the server, kill any spawned mocks, free port. */
  teardown: () => Promise<void>;
}

const DEFAULT_ENABLED: ReadonlyArray<CompatBackendId> = [
  "claude",
  "gemini",
  "lmstudio",
  "ollama"
];

// Model ids each mock backend exposes — must match the canned model lists in
// the mock fixtures from Plans 02/06/08/09. If a mock's model list changes,
// update these constants in lockstep.
export const COMPAT_MODELS: Record<CompatBackendId, { chat: string; embed?: string }> = {
  claude:   { chat: "claude-sonnet-4-6" },                                    // mock-claude default
  gemini:   { chat: "gemini-flash" },                                         // mock-gemini default
  lmstudio: { chat: "mock-chat-model",  embed: "mock-embed-model" },          // mock-lmstudio default
  ollama:   { chat: "llama-3.3-70b",    embed: "nomic-embed-text" }           // mock-ollama default
};

/**
 * Boot a ClaudeMCP server on port 0 with the chosen backends registered
 * against the supplied mock fixtures. Returns base URL + API key + a teardown
 * the caller must `await` in `afterAll`.
 */
export async function buildCompatServer(
  opts: CompatServerOptions = {}
): Promise<CompatServerHandle> {
  const enabled = new Set<CompatBackendId>(opts.enabledBackends ?? DEFAULT_ENABLED);
  const apiKey = opts.apiKey ?? `compat-test-${Math.random().toString(36).slice(2, 12)}`;
  const fileStoreRoot =
    opts.fileStoreRoot ??
    resolve(REPO_ROOT, "data", "compat-test", `run-${process.pid}-${Date.now()}`);

  const lmHandles: MockLmStudioHandle[] = [];
  const ollamaHandles: MockOllamaHandle[] = [];

  const registry = new BackendRegistry({
    claude:   100,
    gemini:   90,
    lmstudio: 50,
    ollama:   40
  });

  // ---- Claude backend (mock CLI on PATH) -----------------------------------
  if (enabled.has("claude")) {
    // The mock-claude bin is either on PATH (per Plan 02 install step) or
    // invocable as `node tests/fixtures/mock-claude/index.mjs`. Match the
    // pattern used by tests/integration/claudeBackend.test.ts.
    const mockClaudeBin = resolve(
      REPO_ROOT, "tests", "fixtures", "mock-claude", "index.mjs"
    );
    registry.register(
      new ClaudeBackend({
        command: ["node", mockClaudeBin],
        timeoutMs: 10_000
      })
    );
  }

  // ---- Gemini backend (mock CLI) -------------------------------------------
  if (enabled.has("gemini")) {
    const mockGeminiBin = resolve(
      REPO_ROOT, "tests", "fixtures", "mock-gemini", "index.mjs"
    );
    registry.register(
      new GeminiBackend({
        command: ["node", mockGeminiBin],
        timeoutMs: 10_000
      })
    );
  }

  // ---- LM Studio backend (in-process mock HTTP) ----------------------------
  if (enabled.has("lmstudio")) {
    const lm = await startMockLmStudio({
      models: ["mock-chat-model", "mock-embed-model"]
    });
    lmHandles.push(lm);
    registry.register(
      new LMStudioBackend({
        enabled: true,
        instances: [
          {
            name: "local",
            baseUrl: lm.url,
            apiKey: "",
            priority: 50,
            timeoutMs: 10_000,
            useNativeApi: null
          }
        ]
      })
    );
  }

  // ---- Ollama backend (subprocess mock HTTP) -------------------------------
  if (enabled.has("ollama")) {
    const olCompat = await startMockOllama();
    ollamaHandles.push(olCompat);
    registry.register(
      new OllamaBackend({
        enabled: true,
        useNativeApi: false,
        instances: [
          {
            name: "compat",
            baseUrl: olCompat.baseUrl,
            priority: 40,
            timeoutMs: 10_000,
            useNativeApi: null
          }
        ]
      })
    );
  }

  // Probe so resolveModel() works immediately for the SDK's first request.
  await registry.probe();

  // ---- Build the Express app with all four shims ---------------------------
  const app: Express = express();
  app.use(express.json({ limit: "16mb" }));

  // Auth: simple x-api-key / Authorization-Bearer / x-goog-api-key check.
  // Plan 01's auth.ts is the canonical place; we just adapt it here. Adapt
  // the import path to whatever Plan 01 settled on.
  const { buildAuthMiddleware } = await import("../../src/auth.js");
  app.use(buildAuthMiddleware({ apiKey }));

  // Mount each shim. Adapt the function names per the actual exports in
  // Plans 03/07/10/11. Some plans may export pre-built routers, others may
  // export factories; match the pattern existing integration tests use.
  app.use(buildAnthropicShim({ registry, fileStoreRoot }));
  app.use(buildGeminiShim({ registry, fileStoreRoot }));
  app.use(buildOpenAIShim({ registry }));
  app.use("/admin", buildAdminRouter({ registry, apiKey }));

  // Listen on port 0; Node assigns a free port.
  const server: Server = await new Promise((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });

  const addr = server.address() as AddressInfo;
  const baseURL = `http://127.0.0.1:${addr.port}`;

  const teardown = async (): Promise<void> => {
    await new Promise<void>((res, rej) =>
      server.close((err) => (err ? rej(err) : res()))
    );
    registry.stop();
    for (const lm of lmHandles) await lm.close();
    for (const ol of ollamaHandles) await ol.stop();
  };

  return { baseURL, apiKey, registry, teardown };
}
```

**Important imports and adaptation:** The exact function names imported above (`buildAnthropicShim`, `buildGeminiShim`, `buildOpenAIShim`, `buildAdminRouter`, `buildAuthMiddleware`) are the *plan-13 best guesses* — they may differ from what Plans 03/07/10/11/01 actually export. The implementer's job in Step 1 is to:

1. Open `src/anthropicShim/index.ts` (or `messages.ts` if no `index.ts`), read its public surface, and use whatever the existing integration tests (e.g. `tests/integration/messages.integration.test.ts`) use. Same for Gemini, OpenAI, admin.
2. Open `src/auth.ts` (or wherever Plan 01's auth middleware lives) and use its actual export.
3. Adapt the imports above before saving. Do not invent function names — reuse the existing ones.

If any shim's export shape is "build a fully wired Express app" rather than "build a router," call that builder directly instead of mounting it as middleware. The end goal — a single Express app with all four surfaces — is what matters.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: clean. Likely first-pass errors:
- Import paths for the shim builders may differ — adjust per "Important imports and adaptation" above.
- `MockOllamaHandle` may be named differently in Plan 09 (`OllamaMockProcess`?) — adapt.
- `startMockLmStudio` return type may differ — adapt.

Fix all errors at the file-path / type-name level — do NOT modify the `src/` modules.

- [ ] **Step 3: Smoke-test the helper from a throwaway test**

Create a temporary file `tests/compat/_smoke.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { buildCompatServer } from "./setup.js";

describe("compat setup smoke test", () => {
  it("boots a server with all four backends and returns a usable baseURL", async () => {
    const handle = await buildCompatServer();
    try {
      expect(handle.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.apiKey.length).toBeGreaterThan(0);
      expect(handle.registry).toBeDefined();
      // A GET /v1/models should respond with 200 once a shim is mounted.
      const res = await fetch(`${handle.baseURL}/v1/models`, {
        headers: { "x-api-key": handle.apiKey }
      });
      expect(res.status).toBe(200);
    } finally {
      await handle.teardown();
    }
  });
});
```

Run: `npx vitest run tests/compat/_smoke.test.ts`
Expected: PASS — confirms the helper boots and the Anthropic shim's `/v1/models` route is mounted under the API-key gate.

- [ ] **Step 4: Delete the smoke test**

Run: `rm tests/compat/_smoke.test.ts` (or `del` on Windows PowerShell).
The real tests in Tasks 3-5 supersede it.

- [ ] **Step 5: Commit**

```bash
git add tests/compat/setup.ts
git commit -m "test(compat): add setup helper booting server + mock backends on port 0

buildCompatServer() spins up a ClaudeMCP server with any subset of the four
backends registered against their mock fixtures. Returns baseURL, apiKey,
registry, and a teardown the caller awaits in afterAll. Used by the three
SDK-per-file compat suites in subsequent tasks."
```

---

## Task 3: Anthropic SDK compat tests

**Files:**
- Create: `tests/compat/anthropic-sdk.test.ts`

The first real compat suite. Instantiate `@anthropic-ai/sdk`'s `Anthropic` client against the test server, drive its documented API surface, assert the SDK's parser accepts every response. Parameterize over all four backends via `describe.each`.

- [ ] **Step 1: Write the test file**

Create `tests/compat/anthropic-sdk.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildCompatServer,
  COMPAT_MODELS,
  type CompatBackendId,
  type CompatServerHandle
} from "./setup.js";

const BACKENDS: ReadonlyArray<CompatBackendId> = ["claude", "gemini", "lmstudio", "ollama"];

describe.each(BACKENDS)("Anthropic SDK × %s backend", (backend) => {
  let handle: CompatServerHandle;
  let client: Anthropic;
  const model = COMPAT_MODELS[backend].chat;

  beforeAll(async () => {
    handle = await buildCompatServer({ enabledBackends: [backend] });
    client = new Anthropic({
      apiKey: handle.apiKey,
      baseURL: handle.baseURL
    });
  });

  afterAll(async () => {
    await handle.teardown();
  });

  // ---- messages.create — non-streaming ------------------------------------

  it("messages.create (non-streaming) returns a Message with a content array", async () => {
    const msg = await client.messages.create({
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: "compat ping" }]
    });

    // The SDK types `msg` as `Message`. If our envelope drifted, this throws
    // BEFORE returning. Assertions below just sanity-check the shape.
    expect(msg.id).toBeDefined();
    expect(msg.type).toBe("message");
    expect(msg.role).toBe("assistant");
    expect(Array.isArray(msg.content)).toBe(true);
    expect(msg.content.length).toBeGreaterThan(0);

    // First content block should be a text block (every mock backend echoes
    // a text reply for non-trigger prompts).
    const first = msg.content[0]!;
    expect(first.type).toBe("text");
    if (first.type === "text") {
      expect(typeof first.text).toBe("string");
      expect(first.text.length).toBeGreaterThan(0);
    }
    expect(msg.model).toBeDefined();
    expect(msg.stop_reason).toBeDefined();
    expect(msg.usage).toBeDefined();
    expect(typeof msg.usage.input_tokens).toBe("number");
    expect(typeof msg.usage.output_tokens).toBe("number");
  });

  // ---- messages.create — streaming ----------------------------------------

  it("messages.create (streaming) produces SDK-typed events in expected order", async () => {
    const stream = client.messages.stream({
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: "compat stream ping" }]
    });

    const seen: string[] = [];
    stream.on("text", () => seen.push("text"));
    stream.on("message", () => seen.push("message"));
    stream.on("error", (err) => {
      throw err;
    });

    const finalMsg = await stream.finalMessage();
    expect(finalMsg.content.length).toBeGreaterThan(0);
    expect(finalMsg.stop_reason).toBeDefined();
    // At minimum we expect one "text" event and one terminal "message" event.
    expect(seen).toContain("text");
    expect(seen).toContain("message");
  });

  it("messages.create (streaming, raw event iterator) emits start → delta → stop in order", async () => {
    const stream = await client.messages.create({
      model,
      max_tokens: 256,
      stream: true,
      messages: [{ role: "user", content: "compat raw stream ping" }]
    });

    const kinds: string[] = [];
    for await (const event of stream) {
      kinds.push(event.type);
    }

    // SDK enforces the event-type sequence:
    //   message_start, (content_block_start, content_block_delta+, content_block_stop)+,
    //   message_delta, message_stop
    expect(kinds[0]).toBe("message_start");
    expect(kinds[kinds.length - 1]).toBe("message_stop");
    expect(kinds).toContain("content_block_start");
    expect(kinds).toContain("content_block_delta");
    expect(kinds).toContain("content_block_stop");
  });

  // ---- messages.countTokens ------------------------------------------------

  it("messages.countTokens returns a positive input_tokens", async () => {
    const res = await client.messages.countTokens({
      model,
      messages: [{ role: "user", content: "count me please" }]
    });
    expect(res.input_tokens).toBeGreaterThan(0);
    expect(typeof res.input_tokens).toBe("number");
  });

  // ---- models.list ---------------------------------------------------------

  it("models.list returns a paginated list whose first page has at least one Model", async () => {
    const page = await client.models.list({ limit: 20 });
    expect(Array.isArray(page.data)).toBe(true);
    expect(page.data.length).toBeGreaterThan(0);
    const m = page.data[0]!;
    expect(m.type).toBe("model");
    expect(typeof m.id).toBe("string");
    expect(typeof m.display_name).toBe("string");
    expect(typeof m.created_at).toBe("string");
  });

  // ---- files lifecycle -----------------------------------------------------
  // The Anthropic SDK files API: upload → list → retrieve → delete.

  it("files.* lifecycle round-trips through the SDK", async () => {
    // upload a tiny text file. The Anthropic SDK accepts a `File` or a
    // `Buffer` with metadata; we use the Buffer route for portability.
    const fileContent = Buffer.from("compat test file contents", "utf-8");

    // The SDK exposes `toFile` for converting Buffer/Stream → upload-ready.
    const { toFile } = await import("@anthropic-ai/sdk");
    const uploaded = await client.files.upload({
      file: await toFile(fileContent, "compat-test.txt", { type: "text/plain" })
    });
    expect(uploaded.id).toMatch(/^file_/);
    expect(uploaded.type).toBe("file");
    expect(uploaded.filename).toBe("compat-test.txt");

    // list — uploaded file should appear.
    const list = await client.files.list({ limit: 100 });
    const found = list.data.find((f) => f.id === uploaded.id);
    expect(found).toBeDefined();
    expect(found?.filename).toBe("compat-test.txt");

    // retrieve by id.
    const retrieved = await client.files.retrieveMetadata(uploaded.id);
    expect(retrieved.id).toBe(uploaded.id);
    expect(retrieved.filename).toBe("compat-test.txt");

    // delete — should return a DeletedFile or similar.
    const deleted = await client.files.delete(uploaded.id);
    expect(deleted.id).toBe(uploaded.id);
    expect(deleted.type).toBe("file_deleted");

    // After delete, retrieve should reject. The SDK throws an APIError
    // (subclass of Error). We catch and inspect it.
    await expect(client.files.retrieveMetadata(uploaded.id)).rejects.toThrow();
  });
});
```

**Notes on the test patterns above:**

- The `messages.stream` API and the `messages.create({stream: true})` event-iterator API exercise two different SDK code paths. Both must succeed. If the helper-method-style `client.messages.stream(...)` doesn't exist in the pinned SDK version (the API has evolved across `0.x` minors), drop that test case and document in Task 8.
- The `files.retrieveMetadata` method name may differ across SDK versions — older versions used `files.retrieve` (deprecated → `retrieveMetadata`). Use whatever the pinned version's TypeScript types accept.
- The `toFile` helper is a top-level export of `@anthropic-ai/sdk`. If the pinned version doesn't expose it (very old `0.x`), construct a `File` via `new File([fileContent], "compat-test.txt", {type: "text/plain"})` (Node 20+ has Web `File`).
- For `backend === "claude"`, the mock-claude fixture from Plan 02 already returns text echoes for non-trigger prompts — every assertion above should pass against it.
- For `backend === "gemini"`, the mock-gemini fixture from Plan 06 returns Gemini-shaped JSON; the Anthropic shim's `requestTranslator` + `responseTranslator` translate between shapes — so the SDK still sees an Anthropic-shaped `Message`.
- For `backend === "lmstudio"` / `"ollama"`, the same Anthropic-shim translation applies. Multi-instance routing and dual-mode (compat vs native) are not exercised here — single-instance default.

- [ ] **Step 2: Run just this file**

Run: `npx vitest run tests/compat/anthropic-sdk.test.ts`
Expected: PASS — 4 backends × ~6 tests = ~24 tests.

If any test fails with an SDK-layer throw (e.g., "Could not parse response body"), that is exactly the kind of envelope drift this suite is designed to surface. Investigate by:
1. Logging the raw response body via a `client.messages.create({...}).asResponse()` interception, or
2. Running the same request via `curl` against the test server and pasting the response into the SDK's type definition to find the missing/misnamed field.

If the test fails because the file API isn't actually wired through for one of the backends (e.g., the Ollama shim doesn't translate `/v1/files` lookups), document it as a known limitation in Task 8 and mark that specific cell with `it.skip` carrying the reason. Do not silently delete the test.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: clean. Likely first-pass issues:
- `client.messages.create(...)` returns a union type; narrowing via `if (first.type === "text")` is required for `first.text` access. Pattern is in the test above.
- The Anthropic SDK's `Anthropic` default export may need `import Anthropic from "@anthropic-ai/sdk"` (default) vs `import {Anthropic} from "@anthropic-ai/sdk"` (named) depending on version. Try default first; if TypeScript objects, swap.

- [ ] **Step 4: Commit**

```bash
git add tests/compat/anthropic-sdk.test.ts
git commit -m "test(compat): exercise @anthropic-ai/sdk against all four backends

messages.create (stream + non-stream + raw event iterator), countTokens,
models.list, files.upload/list/retrieve/delete lifecycle. The SDK's own
parsers fail-loud on any envelope drift; assertions below them are
shape sanity checks rather than behavior coverage."
```

---

## Task 4: OpenAI SDK compat tests

**Files:**
- Create: `tests/compat/openai-sdk.test.ts`

Same pattern as Task 3 for the `openai` package. Chat completions × all four backends. Embeddings × LM Studio + Ollama only (others get `it.skip` with a clear reason — Claude has no embeddings endpoint, Gemini's `text-embedding-004` support is deferred per the spec).

- [ ] **Step 1: Write the test file**

Create `tests/compat/openai-sdk.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import OpenAI from "openai";
import {
  buildCompatServer,
  COMPAT_MODELS,
  type CompatBackendId,
  type CompatServerHandle
} from "./setup.js";

const BACKENDS: ReadonlyArray<CompatBackendId> = ["claude", "gemini", "lmstudio", "ollama"];

describe.each(BACKENDS)("OpenAI SDK × %s backend", (backend) => {
  let handle: CompatServerHandle;
  let client: OpenAI;
  const chatModel = COMPAT_MODELS[backend].chat;
  const embedModel = COMPAT_MODELS[backend].embed;

  beforeAll(async () => {
    handle = await buildCompatServer({ enabledBackends: [backend] });
    client = new OpenAI({
      apiKey: handle.apiKey,
      baseURL: `${handle.baseURL}/v1`
    });
  });

  afterAll(async () => {
    await handle.teardown();
  });

  // ---- chat.completions.create — non-streaming ----------------------------

  it("chat.completions.create (non-streaming) returns a ChatCompletion", async () => {
    const completion = await client.chat.completions.create({
      model: chatModel,
      messages: [{ role: "user", content: "compat openai ping" }]
    });

    expect(completion.id).toBeDefined();
    expect(completion.object).toBe("chat.completion");
    expect(Array.isArray(completion.choices)).toBe(true);
    expect(completion.choices.length).toBeGreaterThan(0);

    const choice = completion.choices[0]!;
    expect(choice.message.role).toBe("assistant");
    expect(typeof choice.message.content).toBe("string");
    expect(choice.message.content!.length).toBeGreaterThan(0);
    expect(choice.finish_reason).toBeDefined();

    expect(completion.usage).toBeDefined();
    expect(typeof completion.usage!.prompt_tokens).toBe("number");
    expect(typeof completion.usage!.completion_tokens).toBe("number");
    expect(typeof completion.usage!.total_tokens).toBe("number");
  });

  // ---- chat.completions.create — streaming --------------------------------

  it("chat.completions.create (streaming) iterates ChatCompletionChunk objects in order", async () => {
    const stream = await client.chat.completions.create({
      model: chatModel,
      messages: [{ role: "user", content: "compat openai stream ping" }],
      stream: true
    });

    const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);

    // First chunk should carry role on a delta.
    const firstWithRole = chunks.find((c) => c.choices[0]?.delta.role);
    expect(firstWithRole?.choices[0]?.delta.role).toBe("assistant");

    // Concatenated content deltas should form a non-empty string.
    const text = chunks
      .map((c) => c.choices[0]?.delta.content ?? "")
      .join("");
    expect(text.length).toBeGreaterThan(0);

    // Terminal chunk should carry a finish_reason.
    const finish = chunks[chunks.length - 1]?.choices[0]?.finish_reason;
    expect(finish).toBeDefined();
  });

  // ---- embeddings.create ---------------------------------------------------

  if (backend === "claude" || backend === "gemini") {
    // Skip with a clear reason — these backends don't expose embeddings.
    // Per the spec's error policy, a real request would 400; the SDK would
    // throw; the assertion would be "expect to throw". We skip rather than
    // assert-throw because the failure mode is intentional and uninteresting.
    it.skip(
      `embeddings.create skipped for ${backend} backend — embeddings not supported (spec: Phase 10 routes only to LM Studio + Ollama)`,
      () => {}
    );
  } else {
    it("embeddings.create returns a CreateEmbeddingResponse with at least one Embedding", async () => {
      const res = await client.embeddings.create({
        model: embedModel!,
        input: ["hello world", "second input"]
      });

      expect(res.object).toBe("list");
      expect(Array.isArray(res.data)).toBe(true);
      expect(res.data.length).toBe(2);

      for (const item of res.data) {
        expect(item.object).toBe("embedding");
        expect(Array.isArray(item.embedding)).toBe(true);
        expect(item.embedding.length).toBeGreaterThan(0);
        expect(typeof item.index).toBe("number");
      }

      expect(res.model).toBeDefined();
      expect(res.usage).toBeDefined();
      expect(typeof res.usage.prompt_tokens).toBe("number");
      expect(typeof res.usage.total_tokens).toBe("number");
    });
  }
});
```

- [ ] **Step 2: Run just this file**

Run: `npx vitest run tests/compat/openai-sdk.test.ts`
Expected: PASS for 4 backends × 2 chat tests = 8, plus 2 embedding tests for {lmstudio, ollama}, plus 2 skipped (claude + gemini embeddings). Total ~10 PASS + 2 SKIP.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: clean. Watch for:
- `OpenAI.Chat.Completions.ChatCompletionChunk` namespace path — the OpenAI SDK's TypeScript namespaces have evolved across versions. If `OpenAI.Chat.Completions.ChatCompletionChunk` is missing, try `OpenAI.ChatCompletionChunk` or import explicitly from `"openai/resources/chat/completions"`.
- `completion.choices[0]!.message.content` — the OpenAI SDK types `content` as `string | null`, so a non-null assertion (`!`) is required after the SDK confirms it's not a function-call response.

- [ ] **Step 4: Commit**

```bash
git add tests/compat/openai-sdk.test.ts
git commit -m "test(compat): exercise openai SDK against all four backends + embeddings on LM Studio/Ollama

chat.completions.create (stream + non-stream) × 4 backends. embeddings.create
× {lmstudio, ollama} (others skipped with reason — Claude has no embeddings,
Gemini text-embedding-004 deferred per spec)."
```

---

## Task 5: Google Generative AI SDK compat tests

**Files:**
- Create: `tests/compat/google-generative-ai-sdk.test.ts`

Last compat suite. The `@google/generative-ai` SDK is pointed at the Gemini shim surface (`/v1beta/models/{model}:generateContent` etc.) on the test server. The shim dispatches to whichever backend resolves the requested model id — so a `gemini-flash` request hits the mock-gemini CLI, a `claude-sonnet-4-6` request hits the mock-claude CLI (via cross-shim dispatch from Plan 07), and so on.

- [ ] **Step 1: Write the test file**

Create `tests/compat/google-generative-ai-sdk.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import {
  buildCompatServer,
  COMPAT_MODELS,
  type CompatBackendId,
  type CompatServerHandle
} from "./setup.js";

const BACKENDS: ReadonlyArray<CompatBackendId> = ["claude", "gemini", "lmstudio", "ollama"];

describe.each(BACKENDS)("Google GenerativeAI SDK × %s backend", (backend) => {
  let handle: CompatServerHandle;
  let client: GoogleGenerativeAI;
  let files: GoogleAIFileManager;
  const modelId = COMPAT_MODELS[backend].chat;

  beforeAll(async () => {
    handle = await buildCompatServer({ enabledBackends: [backend] });
    // The Google SDK's `GoogleGenerativeAI` constructor takes an apiKey;
    // baseUrl override is via `requestOptions.baseUrl` per-call OR via the
    // optional second `requestOptions` arg on `getGenerativeModel`. The exact
    // shape depends on the pinned SDK version — adapt as needed.
    client = new GoogleGenerativeAI(handle.apiKey);
    files = new GoogleAIFileManager(handle.apiKey);

    // Override baseUrl at instantiation level. If the SDK version doesn't
    // expose a constructor-level baseUrl, override per-call via
    // `getGenerativeModel({...}, {baseUrl: handle.baseURL})` below.
    (client as any)._requestOptions = { baseUrl: handle.baseURL };
    (files as any)._requestOptions = { baseUrl: handle.baseURL };
  });

  afterAll(async () => {
    await handle.teardown();
  });

  // ---- getGenerativeModel + generateContent --------------------------------

  it("getModel + generateContent returns a GenerateContentResult", async () => {
    const model = client.getGenerativeModel(
      { model: modelId },
      { baseUrl: handle.baseURL }
    );

    const result = await model.generateContent("compat google-sdk ping");
    expect(result.response).toBeDefined();
    expect(typeof result.response.text()).toBe("string");
    expect(result.response.text().length).toBeGreaterThan(0);

    // candidates[] structure
    const candidates = result.response.candidates;
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates!.length).toBeGreaterThan(0);

    const first = candidates![0]!;
    expect(first.content).toBeDefined();
    expect(Array.isArray(first.content.parts)).toBe(true);
    expect(first.content.parts.length).toBeGreaterThan(0);

    // usageMetadata
    const usage = result.response.usageMetadata;
    expect(usage).toBeDefined();
    expect(typeof usage!.promptTokenCount).toBe("number");
    expect(typeof usage!.candidatesTokenCount).toBe("number");
  });

  // ---- generateContentStream ----------------------------------------------

  it("generateContentStream yields chunks then a resolved response", async () => {
    const model = client.getGenerativeModel(
      { model: modelId },
      { baseUrl: handle.baseURL }
    );

    const result = await model.generateContentStream("compat google-sdk stream ping");

    const chunks: string[] = [];
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text.length > 0) chunks.push(text);
    }

    expect(chunks.length).toBeGreaterThan(0);

    const final = await result.response;
    expect(final.candidates).toBeDefined();
    expect(final.candidates!.length).toBeGreaterThan(0);
    expect(final.text().length).toBeGreaterThan(0);
  });

  // ---- countTokens --------------------------------------------------------

  it("countTokens returns a totalTokens > 0", async () => {
    const model = client.getGenerativeModel(
      { model: modelId },
      { baseUrl: handle.baseURL }
    );

    const { totalTokens } = await model.countTokens("count me please");
    expect(totalTokens).toBeGreaterThan(0);
    expect(typeof totalTokens).toBe("number");
  });

  // ---- files lifecycle ----------------------------------------------------

  it("files.* lifecycle round-trips through the SDK", async () => {
    const fileBuffer = Buffer.from("compat google-sdk test file", "utf-8");

    // The Google SDK expects either a path on disk OR a Buffer / Blob.
    // We use uploadFile via a temp file path because the SDK's web/server
    // entrypoints diverge on whether Buffer is accepted directly.
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = await mkdtemp(join(tmpdir(), "compat-google-"));
    const tmpFile = join(tmp, "compat-google.txt");
    await writeFile(tmpFile, fileBuffer);

    try {
      const uploaded = await files.uploadFile(tmpFile, {
        mimeType: "text/plain",
        displayName: "compat-google.txt"
      });
      expect(uploaded.file.name).toMatch(/^files\//);
      expect(uploaded.file.mimeType).toBe("text/plain");
      expect(uploaded.file.displayName).toBe("compat-google.txt");

      // listFiles
      const list = await files.listFiles({ pageSize: 100 });
      const found = list.files?.find((f) => f.name === uploaded.file.name);
      expect(found).toBeDefined();

      // getFile
      const got = await files.getFile(uploaded.file.name);
      expect(got.name).toBe(uploaded.file.name);
      expect(got.displayName).toBe("compat-google.txt");

      // deleteFile
      await expect(files.deleteFile(uploaded.file.name)).resolves.toBeUndefined();

      // After delete, getFile should throw.
      await expect(files.getFile(uploaded.file.name)).rejects.toThrow();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
```

**Notes:**

- The Google SDK split into a server-side `@google/generative-ai/server` entrypoint specifically for `GoogleAIFileManager`. If the pinned version doesn't export it (very old `0.x`), drop the file lifecycle test from Plan 13 and document the limitation in Task 8 — the Gemini shim's file routes still get coverage via the Anthropic SDK's `files.upload` (Task 3) which round-trips through the same underlying `fileStore`.
- The `requestOptions.baseUrl` override is the supported way to point the SDK at a non-Google host. If your pinned version requires a different mechanism (e.g., an env-var override or a constructor option named `baseUri`), adapt and document. The escape hatch `(client as any)._requestOptions = ...` shown above is a fallback; remove if a clean API exists.
- For non-Gemini backends, the Gemini shim translates request/response shapes via Plan 07's translators. The SDK still sees Gemini-typed `GenerateContentResult` etc.; the assertions above don't change per backend.
- If the SDK has been renamed to `@google/genai`, update both the import and the package name in `package.json` Task 1.

- [ ] **Step 2: Run just this file**

Run: `npx vitest run tests/compat/google-generative-ai-sdk.test.ts`
Expected: PASS — 4 backends × 4 tests = ~16 tests.

If `generateContentStream` fails on a specific backend with a streaming-event-shape error, that's exactly the drift this suite catches. Inspect the raw response and the Gemini shim's `responseTranslator` from Plan 07.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: clean. Watch for:
- The `_requestOptions` private-field hack; ESLint may complain. Either swap to the supported per-call `{baseUrl}` argument (passed to `getGenerativeModel`'s second arg) or add an inline `// eslint-disable-next-line` if a clean API doesn't exist in the pinned version.
- The `GoogleAIFileManager` import path may be `@google/generative-ai/server` (current) or `@google/genai/files` (post-rename). Adapt.

- [ ] **Step 4: Commit**

```bash
git add tests/compat/google-generative-ai-sdk.test.ts
git commit -m "test(compat): exercise @google/generative-ai SDK against all four backends

generateContent, generateContentStream, countTokens, files.* lifecycle
(uploadFile, listFiles, getFile, deleteFile). Non-Gemini backends round-trip
through Plan 07's shim translators; the SDK still sees Gemini-typed responses."
```

---

## Task 6: Full-suite run + runtime measurement

**Files:**
- No file changes — this is a verification + measurement task whose outcomes feed Task 8's README.

The compat suite is heavier than the unit suite (real SDKs + Express + mock subprocesses) so we want a baseline number to document.

- [ ] **Step 1: Run the compat suite in isolation and time it**

Run:
```bash
time npm run test:compat
```
or on Windows PowerShell:
```powershell
Measure-Command { npm run test:compat }
```

Expected: PASS for all (SDK × backend) cells except the documented `it.skip` cells. Record:
- Total runtime (wall clock).
- Per-file runtime (Vitest prints this in the summary table).
- Number of PASS + number of SKIP + number of FAIL (should be 0).

A rough sanity ceiling: 4 backends × 3 SDKs × ~5 tests/backend ≈ 60 tests. At ~1-2s per test (real SDK + real HTTP + mock backend boot), 60-120s total is plausible. If runtime exceeds 5 minutes, investigate the slow cell — most likely a mock-server teardown that isn't releasing the socket.

- [ ] **Step 2: Run the full test suite**

Run:
```bash
npm test
```
Expected: all prior-plan tests still pass + the compat suite passes. Total test count should equal `<prior-plan-count> + <compat-count>`.

Record the delta — used in Task 8's README and the Plan-13 self-review checklist.

- [ ] **Step 3: Verify the `--exclude` pattern works**

Run:
```bash
npm run test:nocompat
```
Expected: compat suite is skipped entirely; only prior-plan tests run. The summary should match the pre-Plan-13 count exactly.

- [ ] **Step 4: Run typecheck across the whole repo**

Run: `npx tsc --noEmit`
Expected: clean. If a new error appears that wasn't there during Tasks 3-5, it's a cross-file typing issue — likely the compat tests use a type alias that conflicts with something already in `tests/`. Investigate and fix at the test-file level.

- [ ] **Step 5: No commit needed**

This task only verifies. No files changed. Capture the numbers for Task 8.

---

## Task 7: Resilience pass — flake-proofing the compat suite

**Files:**
- Modify: `tests/compat/anthropic-sdk.test.ts`, `tests/compat/openai-sdk.test.ts`, `tests/compat/google-generative-ai-sdk.test.ts` (only if needed)
- Modify: `tests/compat/setup.ts` (only if needed)

Run the suite repeatedly to surface flakes. The compat suite touches real network sockets, spawned subprocesses, and the file system; any of these can introduce nondeterminism that doesn't appear on a single run.

- [ ] **Step 1: Loop the compat suite 5 times**

Bash:
```bash
for i in 1 2 3 4 5; do npm run test:compat || break; done
```
PowerShell:
```powershell
for ($i = 1; $i -le 5; $i++) {
  npm run test:compat
  if ($LASTEXITCODE -ne 0) { break }
}
```

Expected: 5/5 PASS. If any iteration fails, treat it as a flake to fix.

- [ ] **Step 2: Diagnose any flakes**

Common patterns and fixes:

| Symptom | Likely cause | Fix |
|---|---|---|
| `EADDRINUSE` on the test server's port | port-0 alloc race on Windows; rare | Wrap server `listen` in retry loop in `setup.ts` |
| Mock subprocess (mock-ollama, mock-gemini) doesn't exit after teardown | child not signaled; orphans in `ps` | Ensure teardown awaits `process.kill` + a `wait` event from the spawner |
| File-store path collides between parallel test files | `fileStoreRoot` default uses `Date.now()`; same ms in parallel | Add a per-suite UUID or use `mkdtemp` |
| SDK stream times out mid-test | mock fixture's terminal event missing | Inspect the mock's last NDJSON / SSE line vs the SDK's expected terminal frame |
| `BackendRegistry.probe()` race — model not yet in map when first request hits | `await registry.probe()` in `beforeAll` already exists, but a periodic re-probe may overwrite | Disable periodic re-probe in compat setup (`registry.stop()` after initial probe? — depends on Plan 01's API) |

If a fix requires modifying `src/`, that's a sign the underlying behavior is genuinely flaky — call it out in Task 8 as an open question rather than papering over with a retry.

- [ ] **Step 3: Apply minimal fixes, re-loop**

After applying fixes:
```bash
for i in 1 2 3 4 5; do npm run test:compat || break; done
```

Expected: 5/5 PASS. If still flaking, document the remaining flake in Task 8's open questions and consider adding a Vitest `retry: 1` annotation on the offending test — but only as a last resort.

- [ ] **Step 4: Commit any test-only fixes**

If only test files changed:
```bash
git add tests/compat/
git commit -m "test(compat): flake-proofing — <one-line summary of the fix>"
```

If `setup.ts` also changed:
```bash
git add tests/compat/setup.ts tests/compat/<file>.test.ts
git commit -m "test(compat): tighten teardown / fileStoreRoot isolation to prevent flakes"
```

If `src/` had to change, that's a separate concern — open a follow-up issue and document in Task 8. Plan 13 doesn't modify `src/`.

---

## Task 8: Plan-13 close-out documentation

**Files:**
- Create: `docs/plan-13-compat-tests-readme.md`

- [ ] **Step 1: Write the document**

```markdown
# Plan 13 — Compat Tests: what shipped

Plan 13 added the cross-SDK × cross-backend compatibility matrix: real first-party SDKs (`@anthropic-ai/sdk`, `openai`, `@google/generative-ai`) pointed at the ClaudeMCP server with mock backends, exercising each SDK's documented API surface. The SDKs' own parsers fail loud on any envelope drift, so this suite is the highest-signal "1:1 replacement" check in the test pyramid.

## Modules added

| Path | Purpose | Lines (approx.) |
|---|---|---|
| `tests/compat/setup.ts` | Helper: `buildCompatServer({enabledBackends})` boots a configured ClaudeMCP server on port 0 with the chosen backends registered against their mock fixtures. Returns `{baseURL, apiKey, registry, teardown}`. | ~210 |
| `tests/compat/anthropic-sdk.test.ts` | Real `@anthropic-ai/sdk` × 4 backends. messages.create (stream + non-stream + raw events), countTokens, models.list, files.* lifecycle. | ~150 |
| `tests/compat/openai-sdk.test.ts` | Real `openai` × 4 backends for chat; × {lmstudio, ollama} only for embeddings. Skipped cells for embeddings × {claude, gemini} carry reason strings. | ~120 |
| `tests/compat/google-generative-ai-sdk.test.ts` | Real `@google/generative-ai` × 4 backends. generateContent, generateContentStream, countTokens, files.* lifecycle. | ~160 |

No `src/` changes — Plan 13 is entirely additive in `tests/`.

## Pinned SDK versions

| Package | Version | Notes |
|---|---|---|
| `@anthropic-ai/sdk` | `^X.Y.Z` (filled in at execution) | Used as default ESM import: `import Anthropic from "@anthropic-ai/sdk"` |
| `openai` | `^X.Y.Z` | Used as default ESM import: `import OpenAI from "openai"` |
| `@google/generative-ai` | `^X.Y.Z` | If the package has been renamed to `@google/genai` since this plan was written, document the rename here. |

## Coverage matrix

|              | Anthropic SDK | OpenAI SDK (chat) | OpenAI SDK (embed) | Google GenAI SDK |
|--------------|:-------------:|:-----------------:|:------------------:|:----------------:|
| **Claude**   | ✓             | ✓                 | skip (no embed)    | ✓                |
| **Gemini**   | ✓             | ✓                 | skip (deferred)    | ✓                |
| **LM Studio**| ✓             | ✓                 | ✓                  | ✓                |
| **Ollama**   | ✓             | ✓                 | ✓                  | ✓                |

12 active cells + 2 skipped (documented). Each cell instantiates a single-backend test server (`enabledBackends: [backend]`) so a regression in one backend doesn't smear into others.

## Test infrastructure

Each `describe.each` block spins up its own server in `beforeAll` and tears it down in `afterAll`. Mock fixtures (mock-claude, mock-gemini, mock-lmstudio, mock-ollama) are the same ones used by their respective per-backend unit/integration tests — no new fixtures introduced. Port-0 binding keeps parallel Vitest workers from colliding.

## Runtime (measured at write time)

- Full compat suite: **~XXs** (filled in at execution from Task 6).
- Full `npm test` (including prior plans): **~XXs**.
- Per-SDK file: **~Xs each**.

If future commits push the compat suite above ~3 minutes, consider running the Anthropic / OpenAI / Google files in parallel via Vitest's `pool: "threads"` config or `--no-isolate`. The current design (one shared `vitest run` discovering all three) is fine at the measured size.

## Skip semantics

`it.skip` with a literal reason string carries forward in the Vitest reporter, so a future contributor can see at a glance why a cell isn't exercised:

- `embeddings × claude` — Claude backend has no embeddings endpoint per `capabilitiesFor()`. Spec routes embeddings only to LM Studio / Ollama (Plan 10).
- `embeddings × gemini` — Gemini has `text-embedding-004` natively, but spec defers wiring it through to a future plan. When that lands, flip the skip to an active test cell.

Backend-disabled cells (when a backend's `enabled: false` in config) are NOT explicitly skipped by Plan 13's tests — the compat suite always builds with the chosen single backend explicitly enabled. If a future config option globally disables a backend, the `buildCompatServer` helper would surface that as a probe failure; the SDK call would 503; the test would fail. That's intentional — if a backend isn't operational, the user should know.

## Plan-13 scope boundary (what does NOT ship here)

- **No real-API verification.** Manual smoke test in `docs/smoke-test.md` (a future doc) covers a real Claude Max / real Gemini CLI / real LM Studio / real Ollama installation. The compat suite uses mocks exclusively.
- **No load testing.** Future plan if a use case appears.
- **No mock-fidelity tests.** Verifying the mocks perfectly mimic the real APIs is ongoing; each backend plan owns its own mock and updates it when the upstream API moves.
- **No exhaustive option coverage per SDK call.** E.g., we don't iterate every possible value of `stream`, `temperature`, `tool_choice`, etc. This is wire-shape parity, not behavior exhaustion.
- **No streaming back-pressure / cancellation tests.** Per-shim unit tests cover those.
- **No tool-use round-trip across the full matrix.** The Anthropic shim's tool-use round-trip is exercised by Plan 04's tests; Plan 13 doesn't re-verify it across every (SDK × backend).
- **No OpenAI Responses API (`responses.create`).** The OpenAI shim only implements `chat.completions` and `embeddings` per Plan 10.
- **No Anthropic message batches or citations.** Both surface 501 per the spec's error policy.
- **No admin endpoints exercised through the SDKs.** Admin routes are non-SDK; covered by Plan 11's integration tests.

## Open questions surfaced during Plan 13

1. **Google SDK rename.** `@google/generative-ai` may have been superseded by `@google/genai`. If so, the pin in `package.json`, the imports in `google-generative-ai-sdk.test.ts`, and the API surface assumed by the test (especially file management via `@google/genai/files` vs `@google/generative-ai/server`) all need updating. Document the actual choice made.
2. **SDK file API parity across backends.** The Anthropic SDK's `files.upload` and the Google SDK's `files.uploadFile` both round-trip through ClaudeMCP's `fileStore` (Plan 05's content-addressed cache). The tests verify upload → list → retrieve → delete works through both SDKs, but they don't verify that a file uploaded via the Anthropic SDK can be referenced from a Gemini-SDK request (cross-shim file reference). Plan 05's integration tests cover that already at the HTTP level; Plan 13 deliberately doesn't double-test through the SDKs.
3. **Streaming event ordering for tool-use round-trip.** The compat tests cover text-only streaming. If a future plan extends the compat suite to verify tool-use streaming events, the Anthropic SDK's `messages.stream({...}).on("tool_use", ...)` event handlers are the natural assertion target; the OpenAI SDK uses `delta.tool_calls`; the Google SDK uses `parts[].functionCall`. Each SDK's event shape is different and each backend's tool-use emission timing is different, so the matrix gets dense fast. Defer until a regression motivates the cost.
4. **CI parallelism.** The default `vitest run` uses parallel workers per file. Three compat files × four backends each = 12 servers booting concurrently in the worst case. Port-0 binding handles port collisions, but mock-subprocess startup latency is the dominant cost. If CI runtime becomes a concern, batch the cells differently — e.g., one file per backend rather than one file per SDK — so each worker only spins up one mock fixture per file.
5. **Coverage report inclusion.** `vitest.config.ts` has `coverage.exclude` for `src/bin.ts`. The compat suite exercises a lot of `src/` code through the SDK round-trips, but it also exercises code already covered by unit + integration tests. If the coverage report shows the compat suite inflating numbers misleadingly (counting one line as "covered" three times), that's not actionable — the suite's value is wire-shape parity, not line coverage. Consider excluding `tests/compat/**` from the coverage run via `--coverage.exclude` if the noise bothers anyone.

## How to add a fifth backend (or a fourth SDK)

Plan 13's matrix is intentionally easy to extend. To add a new backend:

1. Add it to the `CompatBackendId` union and the `COMPAT_MODELS` constant in `tests/compat/setup.ts`.
2. Add a fixture-spawn branch in `buildCompatServer()` for the new `enabled.has("<new>")` block.
3. Add it to the `BACKENDS` constant in each SDK file. The `describe.each` block automatically picks it up.
4. If the new backend doesn't support embeddings, add it to the embedding-skip list in `openai-sdk.test.ts`.

To add a new SDK (e.g., `cohere-ai`):

1. Add the SDK to `devDependencies` in `package.json`.
2. Create `tests/compat/<sdk>-sdk.test.ts` following the pattern of the existing files.
3. Decide which backends the SDK is meaningful against and parameterize accordingly.
4. Update this README's coverage matrix.

## Deviations from this plan that landed during execution

(Filled in by the implementer / reviewer during the actual task cycles. Expected items typically include: SDK version pin adjustments, package rename if `@google/generative-ai` → `@google/genai` happened, file-API entrypoint adjustments for the Google SDK, any test cells that were skipped because a backend genuinely doesn't support the surface, flake fixes applied in Task 7.)
```

- [ ] **Step 2: Fill in the measured runtime numbers from Task 6**

Replace the `~XXs` placeholders with the actual measurements.

- [ ] **Step 3: Fill in the pinned SDK version numbers from Task 1**

Replace the `^X.Y.Z` placeholders with the actual versions.

- [ ] **Step 4: Commit**

```bash
git add docs/plan-13-compat-tests-readme.md
git commit -m "docs: add Plan 13 close-out README — compat matrix, runtimes, skip rationales, extension recipe"
```

---

## Plan 13 — Self-review checklist

Before declaring Plan 13 done, run through this checklist:

- [ ] `npm test` — all tests green, no surprise skips. Compat suite contributes ~12 PASS + 2 SKIP cells (×N tests-per-cell ≈ ~50 new tests). Reconcile the actual count vs expected in the close-out README.
- [ ] `npm run test:compat` — runs only the compat suite, all PASS.
- [ ] `npm run test:nocompat` — runs everything except compat; count matches pre-Plan-13.
- [ ] `npx tsc --noEmit` — no type errors. Particular attention to:
  - The SDK namespace paths (`OpenAI.Chat.Completions.*`) — these moved across `openai` versions; if the pinned version differs, adjust imports.
  - `(client as any)._requestOptions = ...` in the Google SDK test — either keep as a documented escape hatch or replace with the per-call `{baseUrl}` option if the pinned version supports it cleanly.
  - `noUncheckedIndexedAccess` on chunk/array access patterns — every `[0]` needs `!` or a guard.
- [ ] `git status` — clean tree, all changes committed.
- [ ] `git log --oneline -10` — commits read sensibly: deps, setup helper, anthropic-sdk tests, openai-sdk tests, google-generative-ai-sdk tests, (optional flake-proofing), close-out README.
- [ ] `tests/compat/` contains exactly four files: `setup.ts`, `anthropic-sdk.test.ts`, `openai-sdk.test.ts`, `google-generative-ai-sdk.test.ts`. No leftover smoke tests, no `_temp.test.ts`.
- [ ] Three SDK packages appear in `package.json` `devDependencies` with caret-ranged versions matching what was actually pinned.
- [ ] `package.json` scripts include `test:compat` and `test:nocompat`.
- [ ] `README.md` contains the new "Compatibility test suite" paragraph documenting `--exclude tests/compat/**` for the fast iteration loop.
- [ ] `docs/plan-13-compat-tests-readme.md` exists with measured runtime numbers, actual pinned SDK versions, the coverage matrix, and the deviations section filled in (even if just "no deviations").
- [ ] No `src/` modifications — `git diff main -- src/` is empty (or only contains pre-existing changes that landed before Plan 13).
- [ ] No `dist/` modifications — `git log dist/ -5` predates Plan 13.
- [ ] Vitest configuration unchanged — `vitest.config.ts` is untouched. The compat suite is discovered by the existing `include: ["tests/**/*.test.ts"]` glob.
- [ ] No new runtime dependencies — `dependencies` in `package.json` unchanged. Only `devDependencies` grew.
- [ ] `buildCompatServer()` accepts `enabledBackends?: ReadonlyArray<CompatBackendId>` so a test can isolate a single backend per spin-up (which all three SDK files do, one server per `describe.each` cell). This guarantees a regression in one backend doesn't smear into the others' assertions.
- [ ] Skip cells (`embeddings × claude`, `embeddings × gemini`) carry a `reason` string in the skip message, not silent omission.
- [ ] No real Anthropic / Google / LM Studio / Ollama credentials needed — `npm test` runs in a hermetic environment.
- [ ] Loop the compat suite 5x clean (per Task 7) — no flakes.
- [ ] The compat suite teardown leaves no orphaned subprocesses. Verify: `ps aux | grep mock-` (Linux/macOS) or `Get-Process | Where-Object Name -like "*mock*"` (PowerShell) is empty after `npm test` exits.

If all check, Plan 13 is shipped. Open a PR to main; ClaudeMCP is now end-to-end SDK-verified across the full backend matrix.

---

## Final commit + branch hygiene

After all tasks land, the worktree should have these commits in order:

1. `deps: add @anthropic-ai/sdk, openai, @google/generative-ai as devDependencies for compat suite`
2. `test(compat): add setup helper booting server + mock backends on port 0`
3. `test(compat): exercise @anthropic-ai/sdk against all four backends`
4. `test(compat): exercise openai SDK against all four backends + embeddings on LM Studio/Ollama`
5. `test(compat): exercise @google/generative-ai SDK against all four backends`
6. (Optional) `test(compat): flake-proofing — <summary>`
7. `docs: add Plan 13 close-out README — compat matrix, runtimes, skip rationales, extension recipe`

`git log --oneline -10` should show all of these at the top of the branch. Force-push not needed; this is an additive branch.

Open a PR to main titled **"Plan 13 — compat tests (3 SDKs × 4 backends)"** with the body summarizing the coverage matrix, the runtime measurement, and the link to `docs/plan-13-compat-tests-readme.md`. Reviewer should focus on: (a) the skip semantics for the two not-meaningful cells, (b) the close-out README's deviations section, (c) the actual pinned SDK versions.

After merge, ClaudeMCP's spec is fully exercised end-to-end: every shim translates correctly, every backend dispatches correctly, every SDK is a drop-in replacement. The next milestone is operational — real-API smoke tests, production rollout, performance tuning — none of which is Plan 13's job.
