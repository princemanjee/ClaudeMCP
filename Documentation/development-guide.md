# ClaudeMCP — Development Guide

> How to contribute, extend, and maintain the ClaudeMCP codebase. Audience:
> contributors writing TypeScript against the project — new backends, new
> shims, bug fixes, or just curious browsers.

**Companion documents:**
- [README.md](./README.md) — documentation index
- [technical-manual.md](./technical-manual.md) — architecture, request flow, data layout
- [api-reference.md](./api-reference.md) — endpoint reference
- [configuration-guide.md](./configuration-guide.md) — config schema
- [deployment-guide.md](./deployment-guide.md) — installation
- [operations-guide.md](./operations-guide.md) — monitoring + maintenance

---

## 1. Dev setup

### 1.1 Prerequisites

- Node.js 20+ (uses `node:zlib` zstd which landed in Node 22; on Node 20
  install via the polyfill `@mongodb-js/zstd` — but the in-repo path uses
  the native module).
- npm 10+.
- For local Claude CLI testing: `claude` CLI installed and authenticated
  via `claude login` (rides the Claude Max subscription).
- For local Gemini CLI testing: `gemini` CLI installed and authenticated
  via `gemini auth login`.
- For LM Studio backend testing: LM Studio running on `:1234` with at least
  one model loaded.
- For Ollama backend testing: `ollama serve` running on `:11434` with at
  least one model pulled.

None of the above are required for the test suite — every backend has a
mock fixture and the full suite runs in ~4 s without any backend installed.

### 1.2 Clone and install

```bash
git clone https://github.com/princemanjee/ClaudeMCP.git
cd ClaudeMCP
npm install
```

### 1.3 Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Runs the server via `tsx` against `configs/default.json` — no build step. Edits in `src/` take effect on the next request (no hot reload, but no compile step either). |
| `npm run start` | Runs the compiled `dist/bin.js`. Requires `npm run build` first. |
| `npm run build` | `tsc` — emits `dist/`. Required for `npm start` and any production deploy. |
| `npm test` | Full Vitest suite. ~3-5 s. |
| `npm run test:watch` | Vitest watch mode for fast TDD iteration. |
| `npm run test:nocompat` | Everything except `tests/compat/**`. Fast iteration loop when you don't need the cross-SDK matrix. |
| `npm run test:compat` | Just `tests/compat/**`. The cross-SDK × cross-backend matrix (Anthropic SDK × 4, OpenAI SDK × 4, Google SDK × 4). ~1 s. |
| `npm run test:visual` | Playwright visual regression for the admin UI. Gated behind `RUN_VISUAL=1` so CI doesn't run it. |
| `npm run typecheck` | `tsc --noEmit`. The red-light test for type-only changes (Vitest erases types at runtime). |

---

## 2. TypeScript setup

### 2.1 NodeNext module resolution

`tsconfig.json` sets `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`.
Consequence: every relative import must use the `.js` extension even though
the source files are `.ts`:

```ts
// In src/anthropicShim/messages.ts:
import { checkAuth } from "../auth.js";       // ✓ correct
import { BackendRegistry } from "../backends/registry.js";  // ✓ correct

// Common mistake:
import { checkAuth } from "../auth";          // ✗ TypeScript errors at compile time
```

This is non-negotiable under NodeNext — the runtime resolver expects the
actual file URL it would load. `tsc` writes `.js` files out so the import
specifier resolves to the emitted file. (TS will type-check it as `.ts`
during dev; the extension lie is intentional and standard for ESM-in-TS.)

### 2.2 `noUncheckedIndexedAccess`

Enabled. Arrays return `T | undefined` on index access:

```ts
const arr = ["a", "b", "c"];
const first = arr[0];  // type: string | undefined  (NOT string)

// To narrow:
if (arr.length > 0) {
  const first = arr[0]!;             // ✓ assert non-null after guard
  // or
  const first = arr[0] ?? "default"; // ✓ fallback
}
```

You'll see `!` assertions liberally after `if (n > i)` guards in this
codebase. That's the idiom — don't try to refactor them out unless the
underlying invariant changes.

### 2.3 ESM

`"type": "module"` in `package.json`. Plain CommonJS `require()` doesn't
work; use `import`. Top-level `await` is allowed (the test fixtures use it).

### 2.4 `strict`

Enabled. `noImplicitOverride: true` means subclasses must `override` to
override. `exactOptionalPropertyTypes` is *not* set as of writing — verify
in tsconfig before relying on `optional !== undefined` distinctions.

---

## 3. Test discipline

### 3.1 Strict TDD

The project was built test-first. Every plan in `docs/superpowers/plans/`
followed the same step:

1. Write the failing test first (`tests/unit/<area>/<feature>.test.ts`
   or `tests/integration/<feature>.test.ts`).
2. Run `npm test` (or just the affected file) — confirm it fails for the
   reason you expect.
3. Write the minimum implementation in `src/` to make the test pass.
4. Run again — confirm it passes.
5. Refactor if needed, re-run to confirm green.
6. Commit (single commit per feature / task).

This discipline is the load-bearing reason the codebase ships with ~862
tests and a ~4 s suite. Don't break it. If your change has no test —
either the test should be obvious in retrospect (TDD missed it) or your
change is unverified.

### 3.2 Mock CLIs

The Claude and Gemini backends spawn real subprocesses. For tests, two
mock CLIs sit under `tests/fixtures/`:

- `tests/fixtures/mock-claude/index.mjs` — mimics `claude` CLI's
  `stream-json` and `--output-format json` paths. Keys behavior off
  substring matches in the prompt:
  - `MOCK_ERROR` → exit code 1
  - `MOCK_SLEEP_FOREVER` → sleep 60s (for timeout tests)
  - `MOCK_INVALID_JSON` → emit garbage
  - `MOCK_TOOL_USE(<name>,<id>,<json>)` → emit tool_use event
  - `MOCK_THINKING(<text>)` → emit thinking_delta
  - anything else → emit a normal text response
- `tests/fixtures/mock-gemini/index.mjs` — same pattern for `gemini` CLI.

To use the mock CLI in a backend test:

```ts
const backend = new ClaudeBackend({
  command: ["node", "tests/fixtures/mock-claude/index.mjs"],
  timeoutMs: 5000
});
```

### 3.3 Mock HTTP servers

LM Studio and Ollama backends speak HTTP. Their mocks bind to **port 0**
(kernel-assigned) so parallel test workers don't collide:

- `tests/fixtures/mock-lmstudio/server.mjs` — standalone Express server,
  spawnable as a subprocess.
- `tests/fixtures/mock-lmstudio/inProcess.ts` — same logic, mountable into
  the in-process Express app for unit tests.
- `tests/fixtures/mock-ollama/server.mjs` — Ollama-shape responses
  (NDJSON for `/api/chat`, JSON for `/api/tags`).

Never hard-code a port in a test. Use the server's reported address:

```ts
const { server, port } = await startMockLMStudio();
const backend = new LMStudioBackend({
  enabled: true,
  instances: [{ name: "test", baseUrl: `http://127.0.0.1:${port}/v1`, ... }]
});
```

### 3.4 The sleep idiom

To keep the event loop alive in a mock CLI without ever resolving:

```js
// ✓ correct
await new Promise((_resolve) => {
  setInterval(() => {}, 1_000_000);
});

// ✗ wrong — Node detects an unsettled top-level await and exits with code 13
//   within milliseconds, defeating timeout-test scenarios
await new Promise(() => {});
```

This is documented in `tests/fixtures/mock-claude/index.mjs` directly above
the sleep block. The interval is the hack that holds the loop open.

### 3.5 Type-only tests

A test file that only asserts types — no runtime expectations — is vacuous
under Vitest. Vitest runs against compiled JS where the types are erased.
Use `tsc --noEmit` (or `npm run typecheck`) as the red-light for type-only
changes:

```bash
# To check the types compile without running tests:
npm run typecheck
```

If you want runtime + type assertions in the same file, structure it as
runtime tests with `expectTypeOf` from Vitest (which both checks types at
compile and asserts truthiness at runtime).

---

## 4. The plan-driven workflow

### 4.1 The artifact set

The project is built from three layered artifacts:

| Artifact | Lives at | Purpose |
|---|---|---|
| Design spec | `docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md` | The architectural source of truth. Capability matrix, endpoint surfaces, data flows. Should be edited when the architecture changes. |
| Implementation plans | `docs/superpowers/plans/2026-05-16-plan-XX-<name>.md` | Bite-sized task lists with TDD per step. Each plan is scoped so a single executor can ship it in one session. |
| Close-out READMEs | `docs/plan-XX-<name>-readme.md` | After execution, the as-built record: what shipped, what deviated from the plan, what's left for the next plan. The plans live in design space; these READMEs document the code. |

### 4.2 Workflow for non-trivial work

1. **If the architecture changes:** edit the spec. Get sign-off (in this
   project, the sign-off was Prince's; for future contributors, an issue
   or PR discussion).
2. **Write a plan.** Bite-sized tasks. Each task has a clear TDD step:
   "Write test X. Run, confirm failure. Write minimum impl. Run, confirm
   pass." Plans for this project averaged ~10-20 tasks and ~1500-3000 lines.
3. **Execute.** Two patterns observed in this project:
   - **Single agent inline:** one Claude session works the whole plan in
     the main worktree.
   - **Dispatched executor in isolated worktree:** the orchestrator opens
     a git worktree off `main`, dispatches the plan to a worker agent,
     reviews the diff, merges.
4. **Write the close-out README.** Document deviations, scope notes, and
   what the next plan needs.
5. **Commit, push, open PR.** PR title matches the lead commit.

### 4.3 Workflow for small fixes

No spec or plan. Just:

```bash
git checkout main && git pull
git checkout -b fix/short-description
# write the failing test
# write the fix
npm test && npm run typecheck
git commit -m "fix(area): one-line summary"
git push -u origin fix/short-description
gh pr create --title "fix(area): one-line summary" --body "..."
```

This is the pattern used by the post-plan-13 fix sprint
(`docs/deferred-items-fix-summary.md`) — six small fixes, six commits,
one PR per fix.

---

## 5. How to add a new backend (worked example: vLLM)

Suppose you want to add a vLLM backend. vLLM speaks OpenAI's wire format,
so the path is largely "another LM Studio" — but the file shapes are the
same regardless of protocol.

### Step 1 — (Optional) edit the spec

If the addition is large enough to be a feature, add a row to the
capability matrix in
`docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md` and the
endpoint surface table. Skip for small experiments.

### Step 2 — Extend the config schema

Edit `src/config.ts`. Add a `vllm` block mirroring the `lmstudio` shape:

```ts
// In ConfigSchema, alongside lmstudio:
vllm: z
  .object({
    enabled: z.boolean().default(true),
    instances: z.array(InstanceSchema).default([])
  })
  .default({ enabled: true, instances: [] }),
```

Also extend the `BackendId` union in `src/backends/types.ts`:

```ts
export type BackendId = "claude" | "gemini" | "lmstudio" | "ollama" | "vllm";
```

And extend `src/modelRouter.ts` to accept the prefix:

```ts
const m = model.match(
  /^(claude|gemini|lmstudio|ollama|vllm)(?::([A-Za-z0-9_-]+))?\/(.+)$/
);
```

(Run `npm run typecheck` — TypeScript will tell you everywhere a switch on
`BackendId` needs a new case.)

### Step 3 — Create the backend module

Create `src/backends/vllmBackend.ts`. Since vLLM speaks OpenAI shape, reuse
`OpenAICompatClient`:

```ts
import type {
  Backend, BackendCapabilities, ModelDescriptor,
  NormalizedEvent, NormalizedRequest
} from "./types.js";
import { OpenAICompatClient } from "./openaiCompatClient.js";

export interface VLLMInstanceConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  priority: number;
  timeoutMs: number;
}

export class VLLMBackend implements Backend {
  readonly id = "vllm" as const;
  private readonly instances = new Map<string, /* InstanceState */>();

  constructor(config: { enabled: boolean; instances: VLLMInstanceConfig[] }) {
    // ... mirror LMStudioBackend's constructor
  }

  capabilitiesFor(_model: string): BackendCapabilities {
    return {
      toolUse: true,
      multimodal: false,           // depends on the model loaded
      thinking: false,
      cacheControl: "none",
      samplingParams: { temperature: true, topP: true, topK: true },
      stopSequences: "native",
      embeddings: false            // vLLM doesn't expose embeddings by default
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    // for each instance: client.listModels(), merge
  }

  async *invoke(req: NormalizedRequest): AsyncIterable<NormalizedEvent> {
    // pick instance by priority, call client.chatCompletions, normalize
  }

  async countTokens(req: NormalizedRequest): Promise<number> {
    // char/4 fallback
  }
}
```

The right model to copy is `src/backends/lmstudioBackend.ts`. Strip the
fields you don't need; rename the class.

### Step 4 — Mock fixture

Create `tests/fixtures/mock-vllm/server.mjs` (Express, port 0). Pattern after
`tests/fixtures/mock-lmstudio/server.mjs`. Endpoints: `GET /v1/models`,
`POST /v1/chat/completions` (with `stream: true` and `stream: false`).

If vLLM diverges from OpenAI in any subtle way (it does — `vllm`-specific
extensions like `guided_json` aren't OpenAI-standard), the mock should
reflect that surface so your backend tests catch drift.

### Step 5 — Tests

- `tests/unit/backends/vllmBackend.test.ts` — capability matrix, listModels
  (with one-instance-failure case), invoke (priority dispatch, complete
  event sequence, HTTP error → `message_stop:error`). Pattern after
  `tests/unit/backends/lmstudioBackend.test.ts`.
- `tests/integration/vllmBackend.test.ts` — full `BackendRegistry`
  round-trip with the mock fixture as a subprocess.

### Step 6 — Server wiring

Extend `src/server.ts` `buildRegistry()`: add `vllm: 45` to the priorities
object and an `if (config.vllm.enabled && config.vllm.instances.length > 0)`
registration block mirroring the LM Studio one.

### Step 7 — Model router

If vLLM models have a distinctive prefix, the prefix-override syntax already
covers `vllm/X` after Step 2. Skip bare-name aliases — the project keeps
those reserved for Claude and Gemini ergonomics.

### Step 8 — Documentation

Update `Documentation/configuration-guide.md` (config example), `api-reference.md`
(capability matrix row), `user-manual.md` (a "Using vLLM" section).

### Step 9 — Compat test (optional but recommended)

Edit `tests/compat/setup.ts`: add `vllm` to `CompatBackendId` and
`COMPAT_MODELS`, add a spawn branch in `buildCompatServer()`. The
`describe.each(BACKENDS)` blocks in each SDK file pick it up automatically.

---

## 6. How to add a new shim (worked example: Cohere)

Suppose Cohere becomes a popular SDK target and you want
`/v1/chat/cohere` to work. The path is symmetric to adding a backend, just
on the other side of the normalized contract.

### Step 1 — (Optional) spec edit

Add the Cohere endpoint surface to the spec's endpoint table.

### Step 2 — Types

Create `src/cohereShim/types.ts` with the Cohere request/response shapes
(see Cohere's API docs).

### Step 3 — Translators

- `src/cohereShim/requestTranslator.ts` — Cohere body → `NormalizedRequest`.
- `src/cohereShim/responseTranslator.ts` — `NormalizedEvent` →
  Cohere SSE / buffered response.

Pattern after `src/anthropicShim/requestTranslator.ts` and
`src/anthropicShim/responseTranslator.ts`. The big decisions:

- How to map Cohere's `chat_history` shape into `NormalizedMessage[]`.
- How to map Cohere's `tool_results` into `NormalizedContentBlock`s with
  `type: "tool_result"`.
- How to map Cohere's `text` SSE events to `NormalizedEvent.text_delta`.

### Step 4 — Errors

Create `src/cohereShim/errors.ts` with envelope helpers — Cohere uses a
`{ message, code }` shape rather than Anthropic's `{ type, error: { ... } }`.

### Step 5 — Handler factories

Per endpoint, a factory `createXHandler(deps)` returning a `RequestHandler`.
Inside: `checkAuth` → `resolveBackend` → translate request → invoke →
translate response (per-event SSE flush) → `recordCompletion(archive, ...)`
for the archive write. Use the shared helper from
`src/admin/recordCompletion.ts`; don't re-implement archive writes per shim.

### Step 6 — Tests

- `tests/unit/cohereShim/*` — translator round-trips, error envelope tests,
  per-handler isolation.
- `tests/integration/cohereChat.test.ts` — full HTTP stack against
  mock-claude (or whichever backend you want to exercise).

### Step 7 — Server wiring

Mount in `src/server.ts` `buildApp`:

```ts
app.post(
  "/v1/cohere/chat",
  createChatHandler({
    registry: deps.registry,
    archive: deps.archive,
    config: cohereHandlerConfig
  })
);
```

### Step 8 — Auth verification

The shared `checkAuth` already handles `Bearer`. If Cohere uses
`x-cohere-api-key` (it doesn't, but as an example), extend `src/auth.ts`'s
`extractKey` to look for that header too. Add tests for the new scheme.

### Step 9 — Compat test

Add `tests/compat/cohere-sdk.test.ts` parameterized over the 4 backends.
Pattern after `tests/compat/anthropic-sdk.test.ts`. Pin the SDK version in
`package.json` `devDependencies`.

### Step 10 — Documentation

- `Documentation/api-reference.md` — Cohere endpoint surface, error shapes.
- `Documentation/user-manual.md` — "Using the Cohere SDK against ClaudeMCP."

---

## 7. How to add a new admin endpoint

Smaller scope than a backend or shim. Pattern:

### Step 1 — Handler factory

Create `src/admin/<name>.ts`:

```ts
import type { RequestHandler } from "express";
import { checkAuth } from "../auth.js";

export function createMyHandlers(deps: { ... }): { list: RequestHandler; ... } {
  return {
    list: (req, res) => {
      if (!checkAuth({ headers: req.headers, query: req.query }, deps.config.apiKey)) {
        return res.status(401).json(authenticationError("..."));
      }
      // ... handler logic
      res.json({ ok: true, ... });
    }
  };
}
```

### Step 2 — Mount

Edit `src/admin/router.ts` and register your routes inside `mountAdminRoutes`
(under the `bindLocalhost` fence, which is applied to the whole router):

```ts
const myHandlers = createMyHandlers({ ... });
router.get("/my-thing", myHandlers.list);
router.post("/my-thing/action", myHandlers.act);
```

### Step 3 — Tests

- `tests/unit/admin/<name>.test.ts` with `supertest`:

```ts
import request from "supertest";
const app = buildApp({ ... });
const res = await request(app).get("/admin/my-thing").set("x-api-key", "k");
expect(res.status).toBe(200);
```

### Step 4 — Admin UI (if applicable)

If the endpoint backs a UI panel, edit `src/admin-ui/app.js` to add an
Alpine component:

```js
Alpine.data('myPanel', () => ({
  data: [],
  loading: false,
  async load() {
    this.loading = true;
    const res = await fetch('/admin/my-thing', { credentials: 'include' });
    this.data = (await res.json()).data;
    this.loading = false;
  }
}));
```

And add the panel to `src/admin-ui/index.html`. Styles live in
`src/admin-ui/styles.css` — keyed off the existing custom properties so
both themes work without per-panel rules.

---

## 8. Commit message conventions

[Conventional Commits](https://www.conventionalcommits.org/), with scope:

```
<type>(<scope>): <imperative summary, ~70 chars>

<optional body>
```

Types in use:
- `feat:` — new feature
- `fix:` — bug fix
- `chore:` — tooling / dependency / config
- `docs:` — documentation only
- `test:` — test-only changes (rare — most test additions go with the
  feature commit)
- `refactor:` — non-behavior-changing code reorganization

Common scopes:
- `feat(backends): add VLLMBackend skeleton`
- `fix(geminiShim): accept Google SDK's countTokens envelope wrapper`
- `chore(deps): bump openai to 6.38.0`
- `docs: summarize deferred-item fix sprint`

Imperative mood ("add", not "added" or "adds"). Subject under 70 chars.
Body wraps at 72 if present.

---

## 9. PR conventions

- **Title:** matches the lead commit verbatim.
- **Body sections (Markdown):**
  - `## Summary` — one paragraph, the *why*.
  - `## What landed` — bulleted list of concrete changes.
  - `## Deviations` (if any) — anything that didn't match the plan.
  - `## Test Plan` — checkbox list of how you verified.
- **Co-author trailer** if generated with Claude:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

Example PR body from the deferred-items fix sprint:

```markdown
## Summary

Six fixes for the deferred items surfaced by Plan-13's executors. Each
fix has its own commit with TDD discipline; full suite goes from 847 to
862 passing.

## What landed

- fix(archive): wire config.archive.compressionLevel through to zstd
- fix(openaiShim): archive every chat completion and embedding request
- fix(geminiShim): archive every generateContent and countTokens request
- fix(geminiShim): accept Google SDK's countTokens envelope wrapper
- fix(geminiShim): accept Google SDK's resumable /upload/v1beta/files route
- fix(openaiShim): populate usage field on embeddings responses

## Test Plan

- [x] `npm test` — 862 passing, 4 skipped (down from 12 skipped)
- [x] `npm run typecheck` clean
- [x] `npm run test:compat` — 0 skipped in Google SDK matrix
```

Keep PR scope tight. The project has favored small, well-tested PRs over
sweeping refactors.

---

## 10. Where things live (cross-reference)

| Artifact | Path |
|---|---|
| Design spec | `docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md` |
| Implementation plans | `docs/superpowers/plans/2026-05-16-plan-XX-<name>.md` |
| Close-out READMEs | `docs/plan-XX-<name>-readme.md` |
| Deferred-items sprint summary | `docs/deferred-items-fix-summary.md` |
| User-facing docs (this set) | `Documentation/` |
| Source | `src/` |
| Tests | `tests/{unit,integration,compat,fixtures,helpers}/` |
| Mock fixtures | `tests/fixtures/mock-{claude,gemini,lmstudio,ollama}/` |
| Test helpers | `tests/helpers/` |
| Build output | `dist/` (gitignored except for the legacy single-Claude openaiShim) |
| Config defaults | `configs/default.json`, `configs/example.json` |
| Scripts | `scripts/{archive-prune.ts, setup-lan-access.ps1, ...}` |
| Persistent state | `data/{archive.sqlite, files/, response-cache.json, sessions.json}` |

---

## 11. Common patterns to copy

```ts
// Async-iterable backend test
for await (const ev of backend.invoke(req)) events.push(ev);
expect(events[0]).toMatchObject({ kind: "message_start" });
expect(events.at(-1)).toMatchObject({ kind: "message_stop" });

// supertest HTTP test
const app = buildApp({ ... });
const res = await request(app)
  .post("/v1/messages")
  .set("x-api-key", "test-key")
  .send({ model: "claude-sonnet-4-6", max_tokens: 100, messages: [...] });
expect(res.status).toBe(200);

// Streaming SSE assertion (response is concatenated event blocks)
const chunks = res.text.split("\n\n").filter(Boolean);
expect(chunks[0]).toMatch(/^event: message_start/);
expect(chunks.at(-1)).toMatch(/^event: message_stop/);
```

---

## 12. Anti-patterns (don't do these)

- Skipping TDD — every feature ships with a failing-test-first commit.
- Adding a backend without a mock fixture — real CLIs/daemons are too slow
  and flaky for the suite.
- Hard-coding ports — bind to 0 and read the kernel-assigned port.
- Mutating `Config` after `loadConfig` — it's `deepFreeze`d; use
  `ConfigSnapshotStore` for live edits.
- Bypassing `checkAuth` — every shim handler authenticates first.
- Cross-shim translator imports — reach down through the `Backend` interface.
- Materializing async iterables up front — consume runner streams via
  `for await` only.

---

## 13. Getting unstuck

- **Test failure you don't understand?** Run the single test in isolation:
  `npx vitest run tests/path/to/file.test.ts -t "test name"`.
- **TypeScript error you don't understand?** `npm run typecheck` and read
  the error in full. NodeNext + strict can produce verbose messages but
  they're almost always literally true.
- **HTTP behavior unclear?** Look at `tests/compat/*` — those exercise the
  real SDKs and assert against the wire shape. If your change passes those,
  the SDK contract is intact.
- **Architecture question?** Re-read [technical-manual.md](./technical-manual.md)
  and grep the source for the type or function name. The codebase has
  load-bearing comments — read them before refactoring around them.
- **Plan workflow question?** Read `docs/plan-01-foundation-readme.md`
  through `docs/plan-13-compat-tests-readme.md` — they're the worked
  examples of every workflow described above.
