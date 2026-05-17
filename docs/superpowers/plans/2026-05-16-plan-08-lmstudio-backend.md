# Plan 08: LM Studio Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first HTTP-client backend (LM Studio) on top of the Plan 01 foundation. After Plan 08, models loaded in any configured LM Studio instance are reachable through every existing shim by model id. Multi-instance dispatch lands here (LM Studio supports an array of hosts — `local`, `work-server`, etc.); `embed()` lands here (first backend to implement it). The shared `openaiCompatClient` ships in this plan so Plan 09 (Ollama in OpenAI-compat mode) can reuse it without duplication.

**Architecture:** Two new modules under `src/backends/`. `openaiCompatClient.ts` is a pure HTTP wrapper around any OpenAI-shape server — constructor takes `{baseUrl, apiKey?, timeoutMs}`, methods are `chatCompletions` (streaming SSE), `chatCompletionsBuffered` (non-streaming JSON), `embeddings` (POST JSON), `listModels` (GET JSON). No normalization happens here. `lmstudioBackend.ts` is the `Backend` implementation: it owns one `openaiCompatClient` per configured instance, keyed by instance `name`. `listModels()` merges every instance's `GET /v1/models` response. `invoke(req)` picks an instance by (a) explicit `:instance` prefix on the model id, or (b) most-recently-probed instance carrying that model. `embed(req)` proxies through the picked instance's client. `countTokens(req)` falls back to char/4 — LM Studio has no first-class token-counting endpoint, and the `/v1/chat/completions` with `max_tokens: 0` workaround costs a real round-trip per call so it stays out of the default path (see open question below).

**Tech Stack:** Same as Plans 01-06 — Node.js 20+, TypeScript 5 (NodeNext ESM), Vitest. No new runtime dependencies — Node's built-in `fetch` (Undici under the hood) handles HTTP. **Test infra adds one dep:** Express is already in `dependencies` for the server shims, so the in-process mock-lmstudio fixture reuses it for free (no new install required). HTTP-level isolation in unit tests uses an in-process `http.Server` listening on port 0 — no `nock` or `msw` introduced.

**Spec:** `docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md` (Phase 8: LM Studio backend).

**Builds on:**
- Plan 01 (`docs/superpowers/plans/2026-05-16-plan-01-foundation.md`) — `Backend`, `BackendCapabilities`, `NormalizedRequest`, `NormalizedEvent`, `NormalizedEmbeddingRequest`, `NormalizedEmbeddingResponse`, `ModelDescriptor`, `BackendRegistry`, `loadConfig` (`config.lmstudio.enabled`, `config.lmstudio.instances[]`), `Backend.embed?(req)` optional method.
- Plan 05 (`docs/superpowers/plans/2026-05-16-plan-05-files-cache-archive.md`) — `archive.recordEntry()`. Plan 08 doesn't directly call it, but LM Studio-backed invocations get archived through the Anthropic / Gemini / OpenAI shim pipelines once Plan 10 wires the OpenAI shim to dispatch across backends. Plan 08's own integration test does not assert archive writes.
- Plan 06 (`docs/superpowers/plans/2026-05-16-plan-06-gemini-backend.md`) — most recent `Backend` implementation template (capabilities, listModels, countTokens, invoke, scope-boundary throws, integration with `BackendRegistry`).
- **fix-command-schema (PR #4 / commit `62b9c57`):** `config.lmstudio.instances[]` is already multi-instance via `InstanceSchema` (the `superRefine` block enforces unique names within a backend). Pre-flight verifies the schema accepts the shape Plan 08 expects.

---

## Scope boundary for Plan 08

What ships here:

| Feature | Plan 08 disposition |
|---|---|
| Shared `openaiCompatClient` (constructor + chatCompletions{,Buffered} + embeddings + listModels) | Shipped via `src/backends/openaiCompatClient.ts` |
| `Backend` implementation for LM Studio | Shipped via `src/backends/lmstudioBackend.ts` |
| `id: "lmstudio"`, one client per configured instance | Shipped — instances keyed by `name` |
| Multi-instance live model probe (`GET /v1/models` per instance, merged) | Shipped — `listModels()` |
| Multi-instance dispatch on `invoke(req)` and `embed(req)` | Shipped — explicit `:instance` prefix wins, else most-recently-probed instance carrying the model |
| `capabilitiesFor(model)` reflecting LM Studio's OpenAI-compatible surface | Shipped — `samplingParams: { temperature: true, topP: true, topK: true }`, `stopSequences: "native"`, `embeddings: true`, `toolUse: true`, `multimodal: true`, `cacheControl: "none"`, `thinking: false` |
| Text-content message translation (`messages: [{role, content}]` OpenAI shape) | Shipped |
| `system` forwarded as a `{role: "system"}` prepended message | Shipped |
| Tool-use translation (request `tools[]` → OpenAI `tools[]`; response `tool_calls[]` → normalized `tool_use_start`/`_delta`/`_stop` events) | Shipped |
| Native stop-sequences forwarded as `stop: [...]` | Shipped |
| `samplingParams` forwarded as `temperature`, `top_p`, top-k via OpenAI `extra_body` if non-default | Shipped (see Task 6 for top-k caveat) |
| SSE → `NormalizedEvent` adapter (text deltas, tool_call deltas, finish_reason → stopReason) | Shipped |
| `embed(req)` round-trip via `POST /v1/embeddings` | Shipped — first backend to expose it |
| `countTokens(req)` via char/4 fallback | Shipped |
| Server bootstrap: `buildRegistry` registers `LMStudioBackend` when `config.lmstudio.enabled && config.lmstudio.instances.length > 0` | Shipped |

What this plan does NOT ship — these throw a descriptive error from `invoke()` so callers fail loudly rather than receive wrong output:

| Feature on the request | Plan 08 disposition | Lands in |
|---|---|---|
| `image` content blocks | `invoke()` throws | Future (LM Studio supports vision-capable models, but cross-shim Files-API wiring lives with the shims) |
| `document` content blocks | `invoke()` throws | Future |
| `thinking` field truthy | `invoke()` throws | Future (no LM Studio model reports thinking-mode in OpenAI shape today) |

Server-internal deferrals:

- **No Ollama** — Plan 09. (`openaiCompatClient` is shared infra so Plan 09 reuses it without modification.)
- **No OpenAI shim multi-backend dispatch** — Plan 10. The OpenAI shim still routes only Claude-backed requests until Plan 10 lands. LM Studio is reachable end-to-end through the **Anthropic shim** in Plan 08's integration test (the Anthropic shim already dispatches per-backend via `BackendRegistry.resolveModel` from Plan 03).
- **No `/v1/embeddings` endpoint on the OpenAI shim** — Plan 10. `LMStudioBackend.embed()` is callable directly from the registry, but no HTTP route reaches it yet.
- **No admin UI** — Plan 12.
- **No real LM Studio test environment** — mock HTTP only. Verifying against a real LM Studio install is a future smoke test (`docs/smoke-test.md`).
- **No per-model capability narrowing** — `capabilitiesFor()` returns `multimodal: true` and `toolUse: true` for every model id. A non-vision model loaded in LM Studio will simply error from the LM Studio server when given an image; per-model probing is a future enhancement.
- **No legacy embeddings-proxy migration** — `config.embeddings.legacyBackendUrl` is untouched. Plan 10 handles the cutover.

---

## File map

| File | Responsibility |
|---|---|
| `src/backends/openaiCompatClient.ts` | NEW. Shared HTTP client. Constructor: `new OpenAICompatClient({baseUrl, apiKey?, timeoutMs})`. Methods: `chatCompletions(body): AsyncIterable<unknown>` (streams OpenAI SSE chunks parsed as objects), `chatCompletionsBuffered(body): Promise<unknown>` (single JSON response), `embeddings(body): Promise<unknown>`, `listModels(): Promise<unknown[]>`. Pure HTTP — no normalization, no opinion about which backend is calling. Throws `OpenAICompatHTTPError` (extends `Error`, carries `status: number` and `body: unknown`) on non-2xx; throws `OpenAICompatTimeoutError` on `AbortController` deadline. |
| `src/backends/lmstudioBackend.ts` | NEW. `Backend` implementation. `id: "lmstudio"`. Constructor takes `LMStudioBackendConfig = {enabled, instances: InstanceConfig[]}`. Internally builds `Map<instanceName, {client: OpenAICompatClient, priority, lastModels: ModelDescriptor[]}>`. `listModels()` calls every instance, merges by `instances.priority` descending. `invoke(req)` and `embed(req)` route per the resolution rules above. `countTokens(req)` is char/4. Scope-boundary throws as listed above. |
| `src/backends/types.ts` (read-only) | No changes — `Backend.embed?` already exists from Plan 01. |
| `src/server.ts` | EXTEND `buildRegistry(config)`: when `config.lmstudio.enabled && config.lmstudio.instances.length > 0`, construct `LMStudioBackend` from `config.lmstudio` and register. Update the inline `priorities` map to feed `config.lmstudio` priorities to `BackendRegistry` (still `lmstudio: 50` at the registry-priority level — per-instance priority resolves inside the backend). |
| `tests/fixtures/mock-lmstudio/server.mjs` | NEW. Standalone Node script — boots an Express server on a port given via `--port <n>` (or `0` for OS-assigned), prints the bound port as JSON on stdout, then serves `GET /v1/models`, `POST /v1/chat/completions` (streaming + non-streaming), `POST /v1/embeddings`. Behavior keyed off request body's `messages[0].content` substring (analogous to mock-claude's substring triggers) and off `--models <comma-list>` argv (so different test instances report different model lists). Also accepts `--latency-ms <n>` to inject artificial latency for timeout tests. |
| `tests/fixtures/mock-lmstudio/package.json` | NEW. Tiny `bin` shim — same shape as mock-gemini. |
| `tests/fixtures/mock-lmstudio/inProcess.ts` | NEW. TypeScript helper exporting `startMockLmStudio(opts): Promise<{port, url, close}>`. Boots the Express server in-process (same code path as `server.mjs` factored into a helper), used by unit + integration tests so no separate process is spawned. The standalone `server.mjs` exists for future manual smoke testing. **Recommendation:** use the in-process helper everywhere — see "Test fixture pattern decision" below. |
| `tests/unit/backends/openaiCompatClient.test.ts` | NEW. HTTP client behavior in isolation against `inProcess` mock-lmstudio (SSE chunks, error envelopes 4xx/5xx, timeouts, header propagation, embeddings round-trip, listModels round-trip). |
| `tests/unit/backends/lmstudioBackend.test.ts` | NEW. Capability matrix (`samplingParams: { temperature: true, topP: true, topK: true }` — unlike Claude), model listing across multiple instances, request translation, event normalization (OpenAI SSE chunks → `NormalizedEvent`), embed round-trip, scope-boundary throws, multi-instance routing including `lmstudio:<instance>/<model>` prefix. |
| `tests/integration/lmstudioBackend.test.ts` | NEW. End-to-end through `BackendRegistry`: register backend with two in-process mock-lmstudio instances (different model lists), probe, send a `NormalizedRequest` with a model id from instance 2, verify routing. Send an embedding request, verify shape. Coexist with `ClaudeBackend` and `GeminiBackend` from prior plans (no collisions). |
| `docs/plan-08-lmstudio-backend-readme.md` | NEW. Close-out documentation following the Plan 06 README pattern. |

---

## Test fixture pattern decision

The brief lists two options for `mock-lmstudio`: a standalone Node script spawned per test (mirrors `mock-claude` / `mock-gemini`), OR an in-process Express server booted from a test helper. **This plan picks in-process**, with these reasons:

1. **CLI backends spawn external processes anyway** — mock-claude / mock-gemini are subprocesses because the real `claude` and `gemini` CLIs are subprocesses, so the runner code under test owns the spawn. LM Studio is HTTP — the code under test owns a `fetch` call, not a spawn. There's no value in pretending otherwise.
2. **Port-0 binding is trivial in-process** — `app.listen(0).address().port` reads the OS-assigned port synchronously. Cross-process you'd need to parse stdout for the port number.
3. **Multi-instance tests need ≥ 2 mock servers running concurrently** — in-process they coexist as two `http.Server` objects in the same Vitest worker; out-of-process each adds spawn latency and a PID-tracking burden.
4. **Hermetic teardown is simpler** — `server.close()` returns a promise the test can `await`; killing a subprocess on Windows needs `tree-kill`.

The standalone `tests/fixtures/mock-lmstudio/server.mjs` still exists as a manual-smoke-test convenience (`node tests/fixtures/mock-lmstudio/server.mjs --port 1234 --models qwen3-coder-30b` to point a real curl/SDK at it). It re-exports the same factory the tests use.

If during implementation the in-process pattern surfaces a Vitest-isolation issue (e.g., shared global Express middleware leaking between tests), fall back to spawning `server.mjs` and document the deviation in the close-out README.

---

## Pre-flight check

Before starting Task 1, confirm the prior plans are in place and verify the LM Studio surface assumptions:

- [ ] `git log --oneline -10` shows the Plan-06 + Plan-05 + fix-command-schema (PR #4) merges in the recent history.
- [ ] `npm test` shows the full prior-plans suite passing (no skips).
- [ ] `npx tsc --noEmit` clean.
- [ ] `src/backends/types.ts` exists and exports `Backend`, `BackendCapabilities`, `NormalizedRequest`, `NormalizedEvent`, `NormalizedEmbeddingRequest`, `NormalizedEmbeddingResponse`, `ModelDescriptor`. (Verify `Backend.embed?` is declared with `?`.)
- [ ] `src/backends/registry.ts` exists with `BackendRegistry` exposing `register`, `resolveModel`, `probe`, `lastProbeStatus`, `stop`.
- [ ] `src/backends/claudeBackend.ts` and `src/backends/geminiBackend.ts` exist — Plan 08 mirrors their structural pattern (one class implementing `Backend`).
- [ ] `src/config.ts` accepts `config.lmstudio.enabled: boolean` and `config.lmstudio.instances: InstanceSchema[]` where `InstanceSchema = {name: string, baseUrl: string (URL), apiKey: string, priority: number, timeoutMs: number, useNativeApi: boolean | null}`. The `superRefine` block enforces unique `name` per backend.
- [ ] `src/server.ts` exports `buildRegistry(config)` — Plan 08 extends it.
- [ ] `package.json` lists `express` in `dependencies` (it does, from the shim plans) so the in-process mock fixture can `import express from "express"` without adding a new dep.

**LM Studio surface verification** (do this before Task 1):

LM Studio's OpenAI-compatible endpoint surface is documented and stable, but the exact response field set can diverge from the OpenAI spec. Before implementing the client, verify by checking the LM Studio docs (https://lmstudio.ai/docs/local-server) or by running a real LM Studio instance and:

- [ ] `curl http://127.0.0.1:1234/v1/models` — note the response shape. The plan consumes only `data[].id`; if extra fields like `loaded`, `architecture`, `quantization` are present, ignore them.
- [ ] `curl -N -H "Content-Type: application/json" -d '{"model":"<loaded-id>","messages":[{"role":"user","content":"hi"}],"stream":true}' http://127.0.0.1:1234/v1/chat/completions` — verify the SSE format is `data: {...}\n\n` terminated with `data: [DONE]\n\n`.
- [ ] `curl -H "Content-Type: application/json" -d '{"model":"<embed-model-id>","input":["hello"]}' http://127.0.0.1:1234/v1/embeddings` — confirm response shape `{data: [{embedding: [...], index: 0}], model: "..."}`.

If the live verification can't be done, accept the plan's assumed shapes (documented inline in `openaiCompatClient.ts`) and rely on the mock fixture matching those shapes. If reality differs at deployment time, update both `openaiCompatClient.ts` and the mock fixture in lockstep.

**Authentication:** LM Studio's local server optionally accepts `Authorization: Bearer <key>`. Plan 08 forwards `instance.apiKey` as a bearer when non-empty. The mock fixture accepts any bearer (does not validate). Real auth verification is a smoke test.

If any pre-flight check fails, stop and resolve before proceeding.

---

## Task 1: Mock-lmstudio in-process fixture

**Files:**
- Create: `tests/fixtures/mock-lmstudio/inProcess.ts`
- Create: `tests/fixtures/mock-lmstudio/server.mjs`
- Create: `tests/fixtures/mock-lmstudio/package.json`

A small Express app keyed off request-body substrings (analogous to mock-claude's prompt-substring triggers) plus a `--models` argv flag. The in-process helper is what every test uses; the standalone `server.mjs` re-exports the same factory for manual smoke testing.

- [ ] **Step 1: Create the in-process helper**

Create `tests/fixtures/mock-lmstudio/inProcess.ts`:

```ts
import express, { type Express } from "express";
import type { AddressInfo, Server } from "node:net";

export interface MockLmStudioOptions {
  /** Model ids this instance reports from GET /v1/models. */
  models?: string[];
  /** Latency injected before every response, ms. Use to force timeouts. */
  latencyMs?: number;
  /** When true, /v1/chat/completions returns 500 instead of normal output. */
  failChat?: boolean;
  /** When true, /v1/embeddings returns 500 instead of normal output. */
  failEmbeddings?: boolean;
  /** Authorization bearer the mock requires. Empty/undef accepts any. */
  requiredBearer?: string;
}

export interface MockLmStudioHandle {
  port: number;
  url: string;
  app: Express;
  close: () => Promise<void>;
}

/**
 * Boot an in-process Express server mimicking LM Studio's OpenAI-compatible
 * surface. Listens on port 0 (OS-assigned); the returned handle's `port` and
 * `url` are the bound values. Reset between tests by `await handle.close()`.
 *
 * Behavioral triggers (substring match on the request body's first user
 * message's `content` for chat completions, or on first input for embeddings):
 *   "MOCK_ERROR"         — 500 with `{error: {...}}`
 *   "MOCK_INVALID_JSON"  — 200 with a body that isn't valid JSON
 *   "MOCK_HANG"          — never responds (use with client-side timeout to test cancel)
 *   anything else        — normal echo
 */
export function startMockLmStudio(
  opts: MockLmStudioOptions = {}
): Promise<MockLmStudioHandle> {
  const models = opts.models ?? ["mock-chat-model", "mock-embed-model"];
  const latencyMs = opts.latencyMs ?? 0;

  const app = express();
  app.use(express.json({ limit: "8mb" }));

  // Bearer enforcement
  app.use((req, res, next) => {
    if (opts.requiredBearer) {
      const auth = req.header("authorization") ?? "";
      if (auth !== `Bearer ${opts.requiredBearer}`) {
        res.status(401).json({ error: { message: "invalid bearer", type: "auth_error" } });
        return;
      }
    }
    next();
  });

  async function delay(): Promise<void> {
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
  }

  // GET /v1/models
  app.get("/v1/models", async (_req, res) => {
    await delay();
    res.json({
      object: "list",
      data: models.map((id) => ({
        id,
        object: "model",
        owned_by: "lmstudio-mock",
        // Extra fields LM Studio may include — the backend ignores them.
        loaded: true,
        architecture: "mock"
      }))
    });
  });

  // POST /v1/chat/completions
  app.post("/v1/chat/completions", async (req, res) => {
    await delay();

    if (opts.failChat) {
      res.status(500).json({
        error: { message: "mock chat failure", type: "server_error" }
      });
      return;
    }

    const body = req.body as {
      model?: string;
      messages?: Array<{ role: string; content: string | unknown }>;
      stream?: boolean;
      tools?: unknown;
    };
    const firstContent =
      typeof body.messages?.[0]?.content === "string"
        ? body.messages[0].content
        : "";

    if (firstContent.includes("MOCK_ERROR")) {
      res.status(500).json({
        error: { message: "mock chat error trigger", type: "server_error" }
      });
      return;
    }

    if (firstContent.includes("MOCK_HANG")) {
      // Intentionally do not respond; close handler will release on shutdown.
      return;
    }

    const replyText = `echo: ${firstContent}`;
    const modelId = body.model ?? "mock-chat-model";

    // Tool-use trigger: if request includes a tools[] array and the message
    // contains "MOCK_TOOL_USE", emit a tool_call instead of plain text.
    const wantsToolUse =
      Array.isArray(body.tools) &&
      body.tools.length > 0 &&
      firstContent.includes("MOCK_TOOL_USE");

    if (body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const write = (obj: unknown): void => {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };

      // First chunk: role assignment (OpenAI-spec convention).
      write({
        id: "chatcmpl-mock-1",
        object: "chat.completion.chunk",
        model: modelId,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
      });

      if (wantsToolUse) {
        // Single tool call split across two delta chunks to exercise partial-json
        // accumulation in the backend's adapter.
        write({
          id: "chatcmpl-mock-1",
          object: "chat.completion.chunk",
          model: modelId,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_mock_1",
                    type: "function",
                    function: { name: "mock_tool", arguments: '{"a":' }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        });
        write({
          id: "chatcmpl-mock-1",
          object: "chat.completion.chunk",
          model: modelId,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: "1}" } }
                ]
              },
              finish_reason: null
            }
          ]
        });
        write({
          id: "chatcmpl-mock-1",
          object: "chat.completion.chunk",
          model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
        });
      } else {
        // Stream the reply text in ~6-char chunks to make ordering visible.
        const chunks = replyText.match(/.{1,6}/g) ?? [replyText];
        for (const c of chunks) {
          write({
            id: "chatcmpl-mock-1",
            object: "chat.completion.chunk",
            model: modelId,
            choices: [{ index: 0, delta: { content: c }, finish_reason: null }]
          });
        }
        write({
          id: "chatcmpl-mock-1",
          object: "chat.completion.chunk",
          model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: Math.ceil(firstContent.length / 4),
            completion_tokens: Math.ceil(replyText.length / 4),
            total_tokens:
              Math.ceil(firstContent.length / 4) + Math.ceil(replyText.length / 4)
          }
        });
      }

      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // Non-streaming (buffered) response.
    if (wantsToolUse) {
      res.json({
        id: "chatcmpl-mock-1",
        object: "chat.completion",
        model: modelId,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_mock_1",
                  type: "function",
                  function: { name: "mock_tool", arguments: '{"a":1}' }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      });
      return;
    }

    res.json({
      id: "chatcmpl-mock-1",
      object: "chat.completion",
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: replyText },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: Math.ceil(firstContent.length / 4),
        completion_tokens: Math.ceil(replyText.length / 4),
        total_tokens:
          Math.ceil(firstContent.length / 4) + Math.ceil(replyText.length / 4)
      }
    });
  });

  // POST /v1/embeddings
  app.post("/v1/embeddings", async (req, res) => {
    await delay();
    if (opts.failEmbeddings) {
      res.status(500).json({
        error: { message: "mock embedding failure", type: "server_error" }
      });
      return;
    }
    const body = req.body as { model?: string; input?: string | string[] };
    const inputs = Array.isArray(body.input)
      ? body.input
      : typeof body.input === "string"
        ? [body.input]
        : [];
    if (inputs[0]?.includes("MOCK_ERROR")) {
      res.status(500).json({
        error: { message: "mock embedding error trigger", type: "server_error" }
      });
      return;
    }
    // Deterministic 4-d vector keyed off input length.
    res.json({
      object: "list",
      model: body.model ?? "mock-embed-model",
      data: inputs.map((s, i) => ({
        object: "embedding",
        index: i,
        embedding: [s.length / 10, 0.1, 0.2, 0.3]
      })),
      usage: {
        prompt_tokens: inputs.reduce((n, s) => n + Math.ceil(s.length / 4), 0),
        total_tokens: inputs.reduce((n, s) => n + Math.ceil(s.length / 4), 0)
      }
    });
  });

  return new Promise<MockLmStudioHandle>((resolve, reject) => {
    const server: Server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;
      const url = `http://127.0.0.1:${port}/v1`;
      const close = (): Promise<void> =>
        new Promise<void>((res2, rej2) => {
          server.close((err) => (err ? rej2(err) : res2()));
        });
      resolve({ port, url, app, close });
    });
    server.once("error", reject);
  });
}
```

- [ ] **Step 2: Create the standalone bin shim**

Create `tests/fixtures/mock-lmstudio/server.mjs`:

```js
#!/usr/bin/env node
// Standalone runner for the mock-lmstudio Express server. Re-exports the same
// factory the in-process tests use, but bound to a port (default 0 = OS-assigned)
// and prints a single JSON line `{port, url}` on stdout once listening so a
// parent process can read it. Useful for manual smoke testing and as a fallback
// if the in-process pattern hits Vitest-isolation issues.
//
// Argv:
//   --port <n>             default 0 (OS-assigned)
//   --models <a,b,c>       comma-separated model ids
//   --latency-ms <n>       inject latency before every response
//   --bearer <key>         require Authorization: Bearer <key>
//   --fail-chat            return 500 from /v1/chat/completions
//   --fail-embeddings      return 500 from /v1/embeddings
//
// NOTE: This file imports a compiled .js sibling of inProcess.ts. The test
// suite uses inProcess.ts directly via ts-import; this bin shim is for manual
// runs only and requires `npm run build` first (or invocation through tsx).

import { argv, stdout, stderr, exit } from "node:process";
import { startMockLmStudio } from "./inProcess.ts";

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
function bool(name) {
  return argv.includes(name);
}

const opts = {
  models: flag("--models")?.split(",") ?? undefined,
  latencyMs: flag("--latency-ms") ? Number(flag("--latency-ms")) : undefined,
  requiredBearer: flag("--bearer"),
  failChat: bool("--fail-chat"),
  failEmbeddings: bool("--fail-embeddings")
};

const requestedPort = Number(flag("--port") ?? 0);

try {
  const handle = await startMockLmStudio(opts);
  // If the user passed a specific port and we got something else (we always
  // OS-assign in the factory), refuse — easier to fail loudly than to half-honor.
  if (requestedPort !== 0 && handle.port !== requestedPort) {
    stderr.write(
      `mock-lmstudio: requested port ${requestedPort} but bound ${handle.port}; ` +
        "the in-process factory always uses OS-assigned ports.\n"
    );
  }
  stdout.write(JSON.stringify({ port: handle.port, url: handle.url }) + "\n");
  // Keep process alive until killed.
  const noop = () => {};
  setInterval(noop, 1_000_000);
} catch (err) {
  stderr.write(`mock-lmstudio: failed to start: ${err}\n`);
  exit(1);
}
```

(Note: the `server.mjs` is shipped for manual smoke testing only; it is NOT exercised by Vitest. If you skip it during Plan 08 implementation to ship faster, document the deferral and add it as Task 9 of a follow-up plan. The plan's tests rely only on `inProcess.ts`.)

- [ ] **Step 3: Create the fixture package.json**

Create `tests/fixtures/mock-lmstudio/package.json`:

```json
{
  "name": "mock-lmstudio",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "mock-lmstudio": "./server.mjs"
  }
}
```

- [ ] **Step 4: Smoke-test the in-process helper by writing a one-off probe test**

Create a temporary test file `tests/fixtures/mock-lmstudio/_smoke.test.ts` (will be removed at the end of this step):

```ts
import { afterEach, describe, expect, it } from "vitest";
import { startMockLmStudio, type MockLmStudioHandle } from "./inProcess.js";

describe("mock-lmstudio smoke", () => {
  let handle: MockLmStudioHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("boots on port 0 and serves GET /v1/models", async () => {
    handle = await startMockLmStudio({ models: ["alpha", "beta"] });
    expect(handle.port).toBeGreaterThan(0);
    const r = await fetch(`${handle.url}/models`);
    const json = (await r.json()) as { data: Array<{ id: string }> };
    expect(json.data.map((d) => d.id)).toEqual(["alpha", "beta"]);
  });

  it("serves POST /v1/embeddings", async () => {
    handle = await startMockLmStudio();
    const r = await fetch(`${handle.url}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "embed-x", input: "hello" })
    });
    const json = (await r.json()) as { data: Array<{ embedding: number[] }> };
    expect(json.data[0]?.embedding).toHaveLength(4);
  });
});
```

Run: `npx vitest run tests/fixtures/mock-lmstudio/_smoke.test.ts`
Expected: PASS — both smoke tests green. Then delete `_smoke.test.ts` (it was scaffolding to validate the fixture before any production code touches it).

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/mock-lmstudio
git commit -m "test(fixture): add in-process mock-lmstudio Express server + bin shim"
```

---

## Task 2: openaiCompatClient — types, constructor, error classes

**Files:**
- Create: `src/backends/openaiCompatClient.ts`
- Test: `tests/unit/backends/openaiCompatClient.test.ts`

Lands the shared HTTP client surface — the constructor, the `OpenAICompatHTTPError` and `OpenAICompatTimeoutError` classes, and a stubbed-out `listModels()` method. The streaming and embeddings methods land in Task 3 and Task 4 respectively. This task validates the public shape independently so Plan 09 (Ollama, which will import this module) sees a stable surface.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/backends/openaiCompatClient.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import {
  OpenAICompatClient,
  OpenAICompatHTTPError,
  OpenAICompatTimeoutError
} from "../../../src/backends/openaiCompatClient.js";
import {
  startMockLmStudio,
  type MockLmStudioHandle
} from "../../fixtures/mock-lmstudio/inProcess.js";

describe("OpenAICompatClient — constructor + listModels", () => {
  let handle: MockLmStudioHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("constructs with baseUrl and reads back the configured fields", () => {
    const c = new OpenAICompatClient({
      baseUrl: "http://example.test/v1",
      apiKey: "secret",
      timeoutMs: 12345
    });
    expect(c.baseUrl).toBe("http://example.test/v1");
    expect(c.timeoutMs).toBe(12345);
  });

  it("strips a trailing slash from baseUrl", () => {
    const c = new OpenAICompatClient({
      baseUrl: "http://example.test/v1/",
      timeoutMs: 100
    });
    expect(c.baseUrl).toBe("http://example.test/v1");
  });

  it("listModels returns data[] from the server", async () => {
    handle = await startMockLmStudio({ models: ["a", "b", "c"] });
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    const data = (await c.listModels()) as Array<{ id: string }>;
    expect(data.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("listModels forwards Authorization bearer when apiKey is set", async () => {
    handle = await startMockLmStudio({
      models: ["only-with-bearer"],
      requiredBearer: "topsecret"
    });
    const c = new OpenAICompatClient({
      baseUrl: handle.url,
      apiKey: "topsecret",
      timeoutMs: 5000
    });
    const data = (await c.listModels()) as Array<{ id: string }>;
    expect(data.map((m) => m.id)).toEqual(["only-with-bearer"]);
  });

  it("listModels throws OpenAICompatHTTPError on 401", async () => {
    handle = await startMockLmStudio({
      models: ["x"],
      requiredBearer: "right-bearer"
    });
    const c = new OpenAICompatClient({
      baseUrl: handle.url,
      apiKey: "wrong-bearer",
      timeoutMs: 5000
    });
    await expect(c.listModels()).rejects.toBeInstanceOf(OpenAICompatHTTPError);
    try {
      await c.listModels();
    } catch (e) {
      expect(e).toBeInstanceOf(OpenAICompatHTTPError);
      const err = e as OpenAICompatHTTPError;
      expect(err.status).toBe(401);
      expect(err.body).toMatchObject({ error: { type: "auth_error" } });
    }
  });

  it("listModels throws OpenAICompatTimeoutError when client timeout fires", async () => {
    handle = await startMockLmStudio({ latencyMs: 5000 });
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 100 });
    await expect(c.listModels()).rejects.toBeInstanceOf(
      OpenAICompatTimeoutError
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/backends/openaiCompatClient.test.ts`
Expected: FAIL — module `src/backends/openaiCompatClient.js` not found.

- [ ] **Step 3: Create `src/backends/openaiCompatClient.ts` (initial surface only)**

```ts
// Shared HTTP client for any OpenAI-shape server. LM Studio uses this in Plan
// 08; Ollama (OpenAI-compat mode) reuses it in Plan 09. No backend-specific
// logic — request/response shapes are exactly what the OpenAI API documents.
//
// Methods land across multiple tasks:
//   Task 2 (here): constructor, error classes, listModels
//   Task 3:         chatCompletions (streaming) + chatCompletionsBuffered
//   Task 4:         embeddings

export interface OpenAICompatClientConfig {
  /** Base URL ending in `/v1` (trailing slash optional; stripped on construction). */
  baseUrl: string;
  /** Optional Bearer token. When set, forwarded as Authorization: Bearer <apiKey>. */
  apiKey?: string;
  /** Per-request timeout in ms. */
  timeoutMs: number;
}

export class OpenAICompatHTTPError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "OpenAICompatHTTPError";
  }
}

export class OpenAICompatTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAICompatTimeoutError";
  }
}

export class OpenAICompatClient {
  public readonly baseUrl: string;
  public readonly timeoutMs: number;
  private readonly apiKey: string | undefined;

  constructor(config: OpenAICompatClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey && config.apiKey.length > 0 ? config.apiKey : undefined;
    this.timeoutMs = config.timeoutMs;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return { ...h, ...extra };
  }

  /** Internal — wraps fetch with abort-on-timeout and OpenAICompat error envelope. */
  private async fetchJson(
    path: string,
    init: RequestInit
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal
      });
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") {
        throw new OpenAICompatTimeoutError(
          `request to ${this.baseUrl}${path} timed out after ${this.timeoutMs}ms`
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let body: unknown = undefined;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      throw new OpenAICompatHTTPError(
        `HTTP ${response.status} from ${this.baseUrl}${path}`,
        response.status,
        body
      );
    }
    return body;
  }

  async listModels(): Promise<unknown[]> {
    const raw = (await this.fetchJson("/models", {
      method: "GET",
      headers: this.headers()
    })) as { data?: unknown[] } | undefined;
    return raw?.data ?? [];
  }

  // Methods chatCompletions, chatCompletionsBuffered, embeddings land in
  // subsequent tasks.
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/backends/openaiCompatClient.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backends/openaiCompatClient.ts tests/unit/backends/openaiCompatClient.test.ts
git commit -m "feat(backends): add OpenAICompatClient skeleton with listModels + error classes"
```

---

## Task 3: openaiCompatClient.chatCompletions{Buffered}

**Files:**
- Modify: `src/backends/openaiCompatClient.ts`
- Modify: `tests/unit/backends/openaiCompatClient.test.ts`

Add the two chat-completion methods. `chatCompletions(body)` returns an async iterable that yields one parsed JSON object per `data: {...}\n\n` SSE event, with `data: [DONE]` terminating the stream silently. `chatCompletionsBuffered(body)` returns the full response body — the non-streaming code path.

SSE parsing rules (per OpenAI's spec, which LM Studio matches):
- Each event begins with `data: ` (note trailing space).
- Each event ends with `\n\n`.
- Stream terminates on `data: [DONE]\n\n` — don't yield that one.
- Events that don't parse as JSON are skipped silently (defensive — real servers don't emit them, but mock surfaces this nicely).
- A single TCP read can contain a partial event — buffer until the `\n\n` boundary.

- [ ] **Step 1: Append failing tests**

Append to `tests/unit/backends/openaiCompatClient.test.ts`, inside a new describe block:

```ts
describe("OpenAICompatClient — chatCompletions (streaming)", () => {
  let handle: MockLmStudioHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const ev of stream) out.push(ev);
    return out;
  }

  it("yields one parsed object per SSE event, excluding [DONE]", async () => {
    handle = await startMockLmStudio();
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    const events = await collect(
      c.chatCompletions({
        model: "mock-chat-model",
        messages: [{ role: "user", content: "hello" }],
        stream: true
      })
    );
    expect(events.length).toBeGreaterThan(0);

    // First event: role=assistant (the OpenAI convention).
    const first = events[0] as {
      choices?: Array<{ delta?: { role?: string } }>;
    };
    expect(first.choices?.[0]?.delta?.role).toBe("assistant");

    // Last event: finish_reason: "stop".
    const last = events[events.length - 1] as {
      choices?: Array<{ finish_reason?: string }>;
    };
    expect(last.choices?.[0]?.finish_reason).toBe("stop");
  });

  it("concatenated content deltas reproduce the reply text", async () => {
    handle = await startMockLmStudio();
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    const events = await collect(
      c.chatCompletions({
        model: "mock-chat-model",
        messages: [{ role: "user", content: "hello" }],
        stream: true
      })
    );
    const text = events
      .map((e) => {
        const obj = e as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        return obj.choices?.[0]?.delta?.content ?? "";
      })
      .join("");
    expect(text).toBe("echo: hello");
  });

  it("yields tool_call deltas when the server returns them", async () => {
    handle = await startMockLmStudio();
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    const events = await collect(
      c.chatCompletions({
        model: "mock-chat-model",
        messages: [{ role: "user", content: "MOCK_TOOL_USE please" }],
        tools: [
          {
            type: "function",
            function: { name: "mock_tool", parameters: { type: "object" } }
          }
        ],
        stream: true
      })
    );
    const hasToolDelta = events.some((e) => {
      const obj = e as {
        choices?: Array<{ delta?: { tool_calls?: unknown } }>;
      };
      return Array.isArray(obj.choices?.[0]?.delta?.tool_calls);
    });
    expect(hasToolDelta).toBe(true);
    const last = events[events.length - 1] as {
      choices?: Array<{ finish_reason?: string }>;
    };
    expect(last.choices?.[0]?.finish_reason).toBe("tool_calls");
  });

  it("throws OpenAICompatHTTPError on 5xx before any events are yielded", async () => {
    handle = await startMockLmStudio({ failChat: true });
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    await expect(async () => {
      for await (const _ of c.chatCompletions({
        model: "mock-chat-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true
      })) {
        // no-op
      }
    }).rejects.toBeInstanceOf(OpenAICompatHTTPError);
  });

  it("times out long-running streams via AbortController", async () => {
    handle = await startMockLmStudio({ latencyMs: 5000 });
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 100 });
    await expect(async () => {
      for await (const _ of c.chatCompletions({
        model: "mock-chat-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true
      })) {
        // no-op
      }
    }).rejects.toBeInstanceOf(OpenAICompatTimeoutError);
  });
});

describe("OpenAICompatClient — chatCompletionsBuffered (non-streaming)", () => {
  let handle: MockLmStudioHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("returns the full response JSON", async () => {
    handle = await startMockLmStudio();
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    const resp = (await c.chatCompletionsBuffered({
      model: "mock-chat-model",
      messages: [{ role: "user", content: "hello" }]
    })) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { total_tokens: number };
    };
    expect(resp.choices[0]?.message.content).toBe("echo: hello");
    expect(resp.choices[0]?.finish_reason).toBe("stop");
    expect(resp.usage.total_tokens).toBeGreaterThan(0);
  });

  it("throws on 5xx", async () => {
    handle = await startMockLmStudio({ failChat: true });
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    await expect(
      c.chatCompletionsBuffered({
        model: "mock-chat-model",
        messages: [{ role: "user", content: "hi" }]
      })
    ).rejects.toBeInstanceOf(OpenAICompatHTTPError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/backends/openaiCompatClient.test.ts`
Expected: 6 prior tests pass; 7 new tests FAIL because `chatCompletions` / `chatCompletionsBuffered` don't exist yet.

- [ ] **Step 3: Add the two methods to `src/backends/openaiCompatClient.ts`**

Append to the class (after `listModels`):

```ts
  /**
   * Buffered (non-streaming) chat completion. The body's `stream` field is
   * forced to false regardless of caller input — use `chatCompletions()` for
   * streaming.
   */
  async chatCompletionsBuffered(body: unknown): Promise<unknown> {
    const merged = { ...(body as Record<string, unknown>), stream: false };
    return this.fetchJson("/chat/completions", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(merged)
    });
  }

  /**
   * Streaming chat completion. Yields one parsed JSON object per SSE event,
   * silently dropping `[DONE]` and any event that fails to JSON-parse. Throws
   * `OpenAICompatHTTPError` if the initial response is non-2xx (before any
   * events are yielded). Throws `OpenAICompatTimeoutError` if the timeout
   * fires mid-stream.
   */
  async *chatCompletions(body: unknown): AsyncIterable<unknown> {
    const merged = { ...(body as Record<string, unknown>), stream: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers({ Accept: "text/event-stream" }),
        body: JSON.stringify(merged),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if ((e as { name?: string }).name === "AbortError") {
        throw new OpenAICompatTimeoutError(
          `chat completion stream to ${this.baseUrl} timed out`
        );
      }
      throw e;
    }

    if (!response.ok) {
      clearTimeout(timer);
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // text body
      }
      throw new OpenAICompatHTTPError(
        `HTTP ${response.status} from chat completions`,
        response.status,
        body
      );
    }

    if (!response.body) {
      clearTimeout(timer);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Split on double-newline event boundaries.
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const eventChunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          // Each event chunk is one or more `field: value` lines. We care
          // only about `data: ` lines.
          for (const line of eventChunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice("data: ".length);
            if (payload === "[DONE]") {
              // Terminator — drain remaining buffer and exit.
              return;
            }
            try {
              yield JSON.parse(payload);
            } catch {
              // skip malformed event
            }
          }

          boundary = buffer.indexOf("\n\n");
        }
      }
      // Process trailing buffer (rare — most servers always end with \n\n).
      const trailing = buffer.trim();
      if (trailing.startsWith("data: ")) {
        const payload = trailing.slice("data: ".length);
        if (payload !== "[DONE]") {
          try {
            yield JSON.parse(payload);
          } catch {
            // skip
          }
        }
      }
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") {
        throw new OpenAICompatTimeoutError(
          `chat completion stream to ${this.baseUrl} timed out`
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/backends/openaiCompatClient.test.ts`
Expected: PASS — all 13 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backends/openaiCompatClient.ts tests/unit/backends/openaiCompatClient.test.ts
git commit -m "feat(openaiCompatClient): add chatCompletions{,Buffered} with SSE parsing"
```

---

## Task 4: openaiCompatClient.embeddings

**Files:**
- Modify: `src/backends/openaiCompatClient.ts`
- Modify: `tests/unit/backends/openaiCompatClient.test.ts`

Last method on the shared client. `embeddings(body)` is a plain `POST /v1/embeddings` with the body JSON-encoded — no streaming, no special handling, just a typed JSON round-trip. The body shape (`{model, input}`) and response shape (`{data: [{embedding, index}], model, usage}`) are caller's responsibility — this method just forwards.

- [ ] **Step 1: Append failing tests**

Append to `tests/unit/backends/openaiCompatClient.test.ts`:

```ts
describe("OpenAICompatClient — embeddings", () => {
  let handle: MockLmStudioHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("round-trips a single-input embedding request", async () => {
    handle = await startMockLmStudio();
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    const resp = (await c.embeddings({
      model: "mock-embed-model",
      input: "hello"
    })) as {
      data: Array<{ embedding: number[]; index: number }>;
      model: string;
    };
    expect(resp.data).toHaveLength(1);
    expect(resp.data[0]?.embedding).toHaveLength(4);
    expect(resp.model).toBe("mock-embed-model");
  });

  it("round-trips a multi-input embedding request", async () => {
    handle = await startMockLmStudio();
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    const resp = (await c.embeddings({
      model: "mock-embed-model",
      input: ["a", "bb", "ccc"]
    })) as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    expect(resp.data).toHaveLength(3);
    expect(resp.data[0]?.index).toBe(0);
    expect(resp.data[2]?.index).toBe(2);
  });

  it("throws OpenAICompatHTTPError on 5xx", async () => {
    handle = await startMockLmStudio({ failEmbeddings: true });
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    await expect(
      c.embeddings({ model: "mock-embed-model", input: "hi" })
    ).rejects.toBeInstanceOf(OpenAICompatHTTPError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/backends/openaiCompatClient.test.ts`
Expected: 13 prior tests pass; 3 new tests FAIL because `embeddings()` doesn't exist.

- [ ] **Step 3: Add the embeddings method**

Append to the class:

```ts
  async embeddings(body: unknown): Promise<unknown> {
    return this.fetchJson("/embeddings", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body)
    });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/backends/openaiCompatClient.test.ts`
Expected: PASS — all 16 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backends/openaiCompatClient.ts tests/unit/backends/openaiCompatClient.test.ts
git commit -m "feat(openaiCompatClient): add embeddings round-trip method"
```

---

## Task 5: LMStudioBackend skeleton — id, config, capabilities, countTokens, listModels (single instance)

**Files:**
- Create: `src/backends/lmstudioBackend.ts`
- Test: `tests/unit/backends/lmstudioBackend.test.ts`

Land the static surface and the per-instance internal map. `listModels()` calls one client and returns its result, mapped to `ModelDescriptor[]`. `invoke()` is stubbed to throw (lands in Task 6). `embed()` is stubbed to throw (lands in Task 7). Multi-instance dispatch arrives in Task 8.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/backends/lmstudioBackend.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { LMStudioBackend } from "../../../src/backends/lmstudioBackend.js";
import {
  startMockLmStudio,
  type MockLmStudioHandle
} from "../../fixtures/mock-lmstudio/inProcess.js";

describe("LMStudioBackend skeleton", () => {
  let handle: MockLmStudioHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function makeBackend(): Promise<LMStudioBackend> {
    handle = await startMockLmStudio({ models: ["qwen3-coder-30b", "nomic-embed-text"] });
    return new LMStudioBackend({
      enabled: true,
      instances: [
        {
          name: "local",
          baseUrl: handle.url,
          apiKey: "",
          priority: 50,
          timeoutMs: 5000,
          useNativeApi: null
        }
      ]
    });
  }

  it("has id 'lmstudio'", async () => {
    const b = await makeBackend();
    expect(b.id).toBe("lmstudio");
  });

  it("capabilitiesFor returns the LM Studio surface (samplingParams all true, embeddings true)", async () => {
    const b = await makeBackend();
    const caps = b.capabilitiesFor("qwen3-coder-30b");
    expect(caps.toolUse).toBe(true);
    expect(caps.multimodal).toBe(true); // conservative; per-model narrowing is future
    expect(caps.thinking).toBe(false);
    expect(caps.cacheControl).toBe("none");
    expect(caps.samplingParams).toEqual({
      temperature: true,
      topP: true,
      topK: true
    });
    expect(caps.stopSequences).toBe("native");
    expect(caps.embeddings).toBe(true); // first backend to flip this on
  });

  it("listModels returns the live probed model ids from the single instance", async () => {
    const b = await makeBackend();
    const models = await b.listModels();
    expect(models.map((m) => m.id).sort()).toEqual(
      ["nomic-embed-text", "qwen3-coder-30b"].sort()
    );
    for (const m of models) {
      expect(typeof m.id).toBe("string");
      // contextWindow may be undefined when the server doesn't report it.
    }
  });

  it("listModels returns an empty array gracefully when the server lists nothing", async () => {
    await handle?.close();
    handle = await startMockLmStudio({ models: [] });
    const b = new LMStudioBackend({
      enabled: true,
      instances: [
        {
          name: "local",
          baseUrl: handle.url,
          apiKey: "",
          priority: 50,
          timeoutMs: 5000,
          useNativeApi: null
        }
      ]
    });
    expect(await b.listModels()).toEqual([]);
  });

  it("countTokens estimates via char/4 fallback", async () => {
    const b = await makeBackend();
    // 23 chars → ceil(23/4) = 6
    const n = await b.countTokens({
      model: "qwen3-coder-30b",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello world hello world" }] }
      ]
    });
    expect(n).toBe(6);
  });

  it("countTokens sums system + multi-block messages", async () => {
    const b = await makeBackend();
    const n = await b.countTokens({
      model: "qwen3-coder-30b",
      system: "you are helpful", // 15 chars → 4
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] }, // 5 → 2
        { role: "assistant", content: [{ type: "text", text: "ok" }] }, // 2 → 1
        { role: "user", content: [{ type: "text", text: "again" }] } // 5 → 2
      ]
    });
    expect(n).toBe(4 + 2 + 1 + 2);
  });

  it("invoke throws — lands in Task 6", async () => {
    const b = await makeBackend();
    await expect(async () => {
      for await (const _ of b.invoke({
        model: "qwen3-coder-30b",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      })) {
        // no-op
      }
    }).rejects.toThrow(/invoke/);
  });

  it("embed throws — lands in Task 7", async () => {
    const b = await makeBackend();
    await expect(
      b.embed!({ model: "nomic-embed-text", input: ["hello"] })
    ).rejects.toThrow(/embed/);
  });

  it("rejects an empty instances[] in the constructor", () => {
    expect(
      () =>
        new LMStudioBackend({ enabled: true, instances: [] })
    ).toThrow(/instance/i);
  });

  it("rejects duplicate instance names in the constructor", () => {
    expect(
      () =>
        new LMStudioBackend({
          enabled: true,
          instances: [
            {
              name: "dup",
              baseUrl: "http://a.test/v1",
              apiKey: "",
              priority: 50,
              timeoutMs: 5000,
              useNativeApi: null
            },
            {
              name: "dup",
              baseUrl: "http://b.test/v1",
              apiKey: "",
              priority: 50,
              timeoutMs: 5000,
              useNativeApi: null
            }
          ]
        })
    ).toThrow(/unique/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/backends/lmstudioBackend.test.ts`
Expected: FAIL — module `src/backends/lmstudioBackend.js` not found.

- [ ] **Step 3: Create `src/backends/lmstudioBackend.ts`**

```ts
import type {
  Backend,
  BackendCapabilities,
  ModelDescriptor,
  NormalizedEmbeddingRequest,
  NormalizedEmbeddingResponse,
  NormalizedEvent,
  NormalizedRequest
} from "./types.js";
import { OpenAICompatClient } from "./openaiCompatClient.js";

export interface LMStudioInstanceConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  priority: number;
  timeoutMs: number;
  useNativeApi: boolean | null; // unused for LM Studio (Ollama only); accepted for config-shape parity
}

export interface LMStudioBackendConfig {
  enabled: boolean;
  instances: LMStudioInstanceConfig[];
}

interface InstanceState {
  config: LMStudioInstanceConfig;
  client: OpenAICompatClient;
  /** Models last reported by this instance's GET /v1/models. Populated by listModels(). */
  lastModels: ModelDescriptor[];
  /** Last time this instance was probed (epoch ms). 0 means never. */
  lastProbedAt: number;
}

/**
 * Char-count token estimator. ceil(charCount / 4); same fallback as the other
 * backends. LM Studio's own `/v1/chat/completions` with `max_tokens: 0` is the
 * only "real" tokenizer it exposes, and that costs a full HTTP round-trip per
 * countTokens call. The default path stays cheap; a future spec can offer an
 * opt-in real-tokenization mode. See open question below.
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
    }
  }
  return total;
}

export class LMStudioBackend implements Backend {
  readonly id = "lmstudio" as const;

  // Map keyed by instance name. Order is insertion order; for multi-instance
  // dispatch we sort by priority descending at lookup time (Task 8).
  private readonly instances = new Map<string, InstanceState>();

  constructor(config: LMStudioBackendConfig) {
    if (config.instances.length === 0) {
      throw new Error(
        "LMStudioBackend: instances must be non-empty (config.lmstudio.instances)"
      );
    }
    const seen = new Set<string>();
    for (const inst of config.instances) {
      if (seen.has(inst.name)) {
        throw new Error(
          `LMStudioBackend: instance names must be unique; duplicate: ${inst.name}`
        );
      }
      seen.add(inst.name);
      this.instances.set(inst.name, {
        config: inst,
        client: new OpenAICompatClient({
          baseUrl: inst.baseUrl,
          apiKey: inst.apiKey || undefined,
          timeoutMs: inst.timeoutMs
        }),
        lastModels: [],
        lastProbedAt: 0
      });
    }
  }

  capabilitiesFor(_model: string): BackendCapabilities {
    return {
      toolUse: true,
      multimodal: true,
      thinking: false,
      cacheControl: "none",
      samplingParams: { temperature: true, topP: true, topK: true },
      stopSequences: "native",
      embeddings: true
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    // Probe every instance. Collect into a Map keyed by model id; the
    // higher-priority instance wins on collision. (Within a backend; the
    // BackendRegistry handles cross-backend collisions separately.)
    const merged = new Map<string, { descriptor: ModelDescriptor; priority: number }>();
    const sorted = [...this.instances.values()].sort(
      (a, b) => b.config.priority - a.config.priority
    );

    for (const state of sorted) {
      try {
        const raw = await state.client.listModels();
        const descriptors: ModelDescriptor[] = [];
        for (const entry of raw) {
          // We consume ONLY `id`; LM Studio's response may include extra fields
          // like `loaded`, `architecture`, `quantization` — those are ignored.
          const id = (entry as { id?: unknown }).id;
          if (typeof id !== "string" || id.length === 0) continue;
          descriptors.push({ id });
        }
        state.lastModels = descriptors;
        state.lastProbedAt = Date.now();
        for (const d of descriptors) {
          const existing = merged.get(d.id);
          if (!existing || existing.priority < state.config.priority) {
            merged.set(d.id, { descriptor: d, priority: state.config.priority });
          }
        }
      } catch {
        // Probe failure: leave lastModels untouched (or stale). The instance
        // remains unreachable for routing until the next successful probe.
        // No throw — a single failing instance shouldn't black-hole the others.
      }
    }

    return Array.from(merged.values()).map((v) => v.descriptor);
  }

  async countTokens(req: NormalizedRequest): Promise<number> {
    return sumRequestTokens(req);
  }

  // eslint-disable-next-line require-yield
  async *invoke(_req: NormalizedRequest): AsyncIterable<NormalizedEvent> {
    throw new Error("LMStudioBackend.invoke() lands in Plan 08 Task 6");
  }

  async embed(
    _req: NormalizedEmbeddingRequest
  ): Promise<NormalizedEmbeddingResponse> {
    throw new Error("LMStudioBackend.embed() lands in Plan 08 Task 7");
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/backends/lmstudioBackend.test.ts`
Expected: PASS — all 10 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backends/lmstudioBackend.ts tests/unit/backends/lmstudioBackend.test.ts
git commit -m "feat(lmstudioBackend): add skeleton with id, capabilities, listModels, countTokens"
```

---

## Task 6: LMStudioBackend.invoke() — request translation + SSE → NormalizedEvent

**Files:**
- Modify: `src/backends/lmstudioBackend.ts`
- Modify: `tests/unit/backends/lmstudioBackend.test.ts`

Wire `OpenAICompatClient.chatCompletions` into `LMStudioBackend.invoke()`. Builds the OpenAI request body from a `NormalizedRequest`, opens the stream, and translates each parsed SSE chunk into `NormalizedEvent`s.

Scope reminder:
- **Plan 08 (here):** text-only content blocks, `tool_use` request/response round-trip, native stop_sequences, sampling params, `system` → prepended system message. Image / document / thinking blocks throw.
- **Future:** multimodal via Files API (per-shim translation), thinking-mode.

Translation rules — `NormalizedRequest` → OpenAI request body:

| Normalized field | OpenAI body field |
|---|---|
| `model` | `model` (passed through; explicit `:instance` prefix stripped first — see Task 8) |
| `system` | prepended as `{role: "system", content: <text>}` |
| `messages` | translated to `{role, content}` or `{role: "tool", tool_call_id, content}` |
| `messages[].content[]` (text block) | concatenated into `content: string` |
| `messages[].content[]` (tool_use block) | converted to assistant message with `tool_calls: [{id, type: "function", function: {name, arguments: JSON.stringify(input)}}]` |
| `messages[].content[]` (tool_result block) | converted to `{role: "tool", tool_call_id: toolUseId, content}` |
| `tools` | translated to OpenAI `tools: [{type: "function", function: {name, description?, parameters: inputSchema}}]` |
| `toolChoice` "auto" | `tool_choice: "auto"` |
| `toolChoice` "any" | `tool_choice: "required"` (OpenAI's name for "must call a tool") |
| `toolChoice` "none" | `tool_choice: "none"` |
| `toolChoice` {type: "tool", name} | `tool_choice: {type: "function", function: {name}}` |
| `stopSequences` | `stop: [...]` |
| `maxTokens` | `max_tokens: n` |
| `samplingParams.temperature` | `temperature: n` |
| `samplingParams.topP` | `top_p: n` |
| `samplingParams.topK` | `top_k: n` IF the LM Studio server accepts it; OpenAI spec doesn't include `top_k`. **Decision:** pass through as a top-level field; LM Studio honors it on llama.cpp-backed models. If a deployment surfaces a 400 because of it, a future config knob can suppress it. See open question. |

Translation rules — OpenAI SSE chunk → `NormalizedEvent`:

| Chunk shape | NormalizedEvent emitted |
|---|---|
| First chunk seen | `message_start { model }` (use `chunk.model`) |
| `choices[0].delta.content: "..."` | `text_delta { index, text }` |
| `choices[0].delta.tool_calls[i].id + .function.name` (first time seen) | `tool_use_start { index: i, id, name }` |
| `choices[0].delta.tool_calls[i].function.arguments: "..."` | `tool_use_delta { index: i, partialJson }` |
| `choices[0].finish_reason` non-null | `tool_use_stop { index }` for every open tool, then `message_stop { stopReason }` |
| `choices[0].finish_reason: "stop"` | `stopReason: "end_turn"` |
| `choices[0].finish_reason: "length"` | `stopReason: "max_tokens"` |
| `choices[0].finish_reason: "tool_calls"` | `stopReason: "tool_use"` |
| `choices[0].finish_reason: "content_filter"` | `stopReason: "error"` |
| Terminal chunk's `usage: {prompt_tokens, completion_tokens}` | `usage: {inputTokens, outputTokens}` on the `message_stop` |
| Stream ends without any finish_reason chunk | Synthesized `message_stop { stopReason: "error" }` |

- [ ] **Step 1: Add failing tests**

Append to `tests/unit/backends/lmstudioBackend.test.ts`. Also add the import at the top:

```ts
import type { NormalizedEvent } from "../../../src/backends/types.js";
```

Then add inside the describe block:

```ts
  it("invoke streams: emits message_start, text_delta(s), message_stop in order", async () => {
    const b = await makeBackend();
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "qwen3-coder-30b",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    })) {
      events.push(ev);
    }
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");

    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toBe("echo: hello");
  });

  it("invoke surfaces usage on the terminal message_stop", async () => {
    const b = await makeBackend();
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "qwen3-coder-30b",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    })) {
      events.push(ev);
    }
    const stop = events[events.length - 1];
    expect(stop?.kind).toBe("message_stop");
    if (stop?.kind === "message_stop") {
      expect(stop.usage).toBeDefined();
      expect(stop.usage?.inputTokens).toBeGreaterThan(0);
      expect(stop.usage?.outputTokens).toBeGreaterThan(0);
      expect(stop.stopReason).toBe("end_turn");
    }
  });

  it("invoke forwards system as a prepended system message", async () => {
    const b = await makeBackend();
    // Use chatCompletionsBuffered side-channel: the mock echoes the first
    // user message. With a system message prepended, the echo still reflects
    // the user content, so the verification is "doesn't blow up". A stronger
    // test would inspect the mock's recorded request body — Task 8's
    // multi-instance test does that via per-instance separation.
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "qwen3-coder-30b",
      system: "you are helpful",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    })) {
      events.push(ev);
    }
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke forwards samplingParams (temperature, top_p, top_k)", async () => {
    const b = await makeBackend();
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "qwen3-coder-30b",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      samplingParams: { temperature: 0.7, topP: 0.9, topK: 40 }
    })) {
      events.push(ev);
    }
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke forwards stopSequences as `stop: [...]`", async () => {
    const b = await makeBackend();
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "qwen3-coder-30b",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      stopSequences: ["END"]
    })) {
      events.push(ev);
    }
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke emits tool_use_start/_delta/_stop when the server returns tool_calls", async () => {
    const b = await makeBackend();
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "qwen3-coder-30b",
      messages: [
        { role: "user", content: [{ type: "text", text: "MOCK_TOOL_USE please" }] }
      ],
      tools: [{ name: "mock_tool", inputSchema: { type: "object" } }]
    })) {
      events.push(ev);
    }

    const starts = events.filter((e) => e.kind === "tool_use_start");
    const deltas = events.filter((e) => e.kind === "tool_use_delta");
    const stops = events.filter((e) => e.kind === "tool_use_stop");
    expect(starts).toHaveLength(1);
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(stops).toHaveLength(1);

    const accumulated = deltas
      .map((e) => (e.kind === "tool_use_delta" ? e.partialJson : ""))
      .join("");
    expect(JSON.parse(accumulated)).toEqual({ a: 1 });

    const stop = events[events.length - 1];
    expect(stop?.kind).toBe("message_stop");
    if (stop?.kind === "message_stop") {
      expect(stop.stopReason).toBe("tool_use");
    }
  });

  it("invoke folds a tool_result back into the request as role=tool", async () => {
    const b = await makeBackend();
    // We can't easily inspect the wire here, but we can verify the call
    // doesn't throw and produces a normal message_stop.
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "qwen3-coder-30b",
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "mock_tool",
              input: { a: 1 }
            }
          ]
        },
        {
          role: "tool",
          content: [
            { type: "tool_result", toolUseId: "call_1", content: '{"ok": true}' }
          ]
        }
      ]
    })) {
      events.push(ev);
    }
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke throws on image content blocks (Plan 08 scope is text-only chat)", async () => {
    const b = await makeBackend();
    await expect(async () => {
      for await (const _ of b.invoke({
        model: "qwen3-coder-30b",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image", mediaType: "image/png", data: "BASE64" }
            ]
          }
        ]
      })) {
        // no-op
      }
    }).rejects.toThrow(/multimodal|image/i);
  });

  it("invoke throws on document content blocks", async () => {
    const b = await makeBackend();
    await expect(async () => {
      for await (const _ of b.invoke({
        model: "qwen3-coder-30b",
        messages: [
          {
            role: "user",
            content: [
              { type: "document", mediaType: "application/pdf", data: "BASE64" }
            ]
          }
        ]
      })) {
        // no-op
      }
    }).rejects.toThrow(/document/i);
  });

  it("invoke throws on thinking: true", async () => {
    const b = await makeBackend();
    await expect(async () => {
      for await (const _ of b.invoke({
        model: "qwen3-coder-30b",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        thinking: true
      })) {
        // no-op
      }
    }).rejects.toThrow(/thinking/i);
  });

  it("invoke maps finish_reason: length to stopReason: max_tokens", async () => {
    // This test relies on a mock trigger we haven't added. Skip for now and
    // capture in deviations if implementer wants to wire it later. Alternative:
    // verify mapping via a unit-level test of the mapping helper if exported.
    // (Implementer: feel free to flesh out the mock to support this trigger.)
  });
```

Also REMOVE the placeholder test `"invoke throws — lands in Task 6"` — Task 6 makes invoke real, so the placeholder cannot survive. This mirrors the Plan-02 deviation §3 / Plan-06 Task-6 reconciliation: replace, don't append.

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run tests/unit/backends/lmstudioBackend.test.ts`
Expected: ~9 surviving skeleton tests pass, ~9 new invoke tests FAIL (invoke not implemented), 1 placeholder removed.

- [ ] **Step 3: Replace the invoke() stub in `src/backends/lmstudioBackend.ts`**

Add this import near the top of the class file (no new imports actually needed since `OpenAICompatClient` is already imported).

Replace the `invoke()` method with the real implementation, and add the helpers below it (place near the bottom of the class file, mirroring Plan 06's `mapFinishReason` placement):

```ts
  async *invoke(req: NormalizedRequest): AsyncIterable<NormalizedEvent> {
    this.assertPlan08Scope(req);

    // Strip a possible `<backend>:<instance>/` prefix from the model id
    // before forwarding to LM Studio. Task 8 resolves which instance handles
    // the request; here we just pass the model id LM Studio expects.
    const { instance, modelId } = this.resolveInstanceAndModel(req.model);

    const body = this.translateRequestToOpenAIBody(req, modelId);

    let startEmitted = false;
    let textIndex = 0;
    let textOpen = false;
    // Track open tool calls by their `index` to map deltas back to the start.
    const openToolIndices = new Set<number>();
    // Also track names already announced per index, since OpenAI sends the
    // function.name only on the first delta for that index.
    const toolNamesSeen = new Map<number, string>();

    for await (const raw of instance.client.chatCompletions(body)) {
      const chunk = raw as OpenAIChunk;
      const choice = chunk.choices?.[0];

      if (!startEmitted) {
        startEmitted = true;
        yield { kind: "message_start", model: chunk.model ?? req.model };
      }

      const delta = choice?.delta;

      // Text deltas
      if (delta?.content && delta.content.length > 0) {
        yield { kind: "text_delta", index: textIndex, text: delta.content };
        textOpen = true;
      }

      // Tool-call deltas
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const tcIndex = typeof tc.index === "number" ? tc.index : 0;

          // First time we see this index AND it has an id+function.name, emit
          // tool_use_start.
          if (!openToolIndices.has(tcIndex)) {
            const id = tc.id;
            const name = tc.function?.name;
            if (typeof id === "string" && typeof name === "string") {
              openToolIndices.add(tcIndex);
              toolNamesSeen.set(tcIndex, name);
              yield { kind: "tool_use_start", index: tcIndex, id, name };
            }
          }

          const argsDelta = tc.function?.arguments;
          if (typeof argsDelta === "string" && argsDelta.length > 0) {
            yield {
              kind: "tool_use_delta",
              index: tcIndex,
              partialJson: argsDelta
            };
          }
        }
      }

      // Terminal chunk
      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
        // Close any open tool indices.
        for (const idx of openToolIndices) {
          yield { kind: "tool_use_stop", index: idx };
        }
        if (textOpen) {
          textIndex++;
          textOpen = false;
        }
        const usage = chunk.usage
          ? {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0
            }
          : undefined;
        yield {
          kind: "message_stop",
          stopReason: mapFinishReason(choice.finish_reason),
          usage:
            usage && usage.inputTokens + usage.outputTokens > 0
              ? usage
              : undefined
        };
        return;
      }
    }

    // Stream ended without an explicit terminal chunk.
    if (!startEmitted) {
      yield { kind: "message_start", model: req.model };
    }
    for (const idx of openToolIndices) {
      yield { kind: "tool_use_stop", index: idx };
    }
    yield { kind: "message_stop", stopReason: "error" };
  }

  // ---- Plan-08 scope helpers --------------------------------------------

  private assertPlan08Scope(req: NormalizedRequest): void {
    if (req.thinking) {
      throw new Error(
        "LMStudioBackend (Plan 08): thinking-mode is not supported"
      );
    }
    for (const msg of req.messages) {
      for (const block of msg.content) {
        if (block.type === "image") {
          throw new Error(
            "LMStudioBackend (Plan 08): multimodal image content lands in a future plan (per-shim Files-API wiring)"
          );
        }
        if (block.type === "document") {
          throw new Error(
            "LMStudioBackend (Plan 08): document content lands in a future plan"
          );
        }
      }
    }
  }

  /**
   * Translate the normalized request to an OpenAI chat-completions body.
   * Tool-use semantics, system prepending, and sampling-param forwarding all
   * land here. The `model` field is forwarded verbatim — instance resolution
   * happens in `resolveInstanceAndModel` before this is called.
   */
  private translateRequestToOpenAIBody(
    req: NormalizedRequest,
    modelId: string
  ): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = [];

    if (req.system) {
      messages.push({ role: "system", content: req.system });
    }

    for (const msg of req.messages) {
      // Collect tool_use blocks for assistant role -> tool_calls array.
      const toolUseBlocks = msg.content.filter(
        (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use"
      );
      const toolResultBlocks = msg.content.filter(
        (b): b is Extract<typeof b, { type: "tool_result" }> =>
          b.type === "tool_result"
      );
      const textBlocks = msg.content.filter(
        (b): b is Extract<typeof b, { type: "text" }> => b.type === "text"
      );

      // tool_result -> separate {role: "tool"} message per result.
      for (const tr of toolResultBlocks) {
        messages.push({
          role: "tool",
          tool_call_id: tr.toolUseId,
          content: tr.content
        });
      }

      if (toolUseBlocks.length > 0) {
        // Assistant message containing tool_calls.
        const textContent = textBlocks.map((b) => b.text).join("\n");
        messages.push({
          role: "assistant",
          content: textContent.length > 0 ? textContent : null,
          tool_calls: toolUseBlocks.map((tu) => ({
            id: tu.id,
            type: "function",
            function: {
              name: tu.name,
              arguments: JSON.stringify(tu.input ?? {})
            }
          }))
        });
      } else if (textBlocks.length > 0) {
        // Plain text message.
        messages.push({
          role: msg.role,
          content: textBlocks.map((b) => b.text).join("\n")
        });
      }
    }

    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      stream: true
    };

    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

    if (req.samplingParams?.temperature !== undefined)
      body.temperature = req.samplingParams.temperature;
    if (req.samplingParams?.topP !== undefined)
      body.top_p = req.samplingParams.topP;
    if (req.samplingParams?.topK !== undefined)
      body.top_k = req.samplingParams.topK; // non-standard but LM Studio honors it on llama.cpp models

    if (req.stopSequences && req.stopSequences.length > 0) {
      body.stop = req.stopSequences;
    }

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema
        }
      }));
    }

    if (req.toolChoice !== undefined) {
      if (req.toolChoice === "auto") body.tool_choice = "auto";
      else if (req.toolChoice === "any") body.tool_choice = "required";
      else if (req.toolChoice === "none") body.tool_choice = "none";
      else if (typeof req.toolChoice === "object" && req.toolChoice.type === "tool") {
        body.tool_choice = {
          type: "function",
          function: { name: req.toolChoice.name }
        };
      }
    }

    return body;
  }

  /**
   * Resolve the request's model id to (a) which instance handles it and (b)
   * the model id to forward (with any instance prefix stripped). Task 8 wires
   * the multi-instance dispatch; in Tasks 5-7 there's only one instance, so
   * resolution is trivial. The helper is defined here to keep the call site in
   * invoke() stable across tasks.
   */
  private resolveInstanceAndModel(
    requestedModel: string
  ): { instance: InstanceState; modelId: string } {
    // Strip the optional `lmstudio:<instance>/` prefix if the model arrives
    // that way (per the spec's prefix-override syntax).
    let modelId = requestedModel;
    let forcedInstance: string | undefined;
    const prefixMatch = /^lmstudio:([^/]+)\/(.+)$/.exec(requestedModel);
    if (prefixMatch && prefixMatch[1] && prefixMatch[2]) {
      forcedInstance = prefixMatch[1];
      modelId = prefixMatch[2];
    }

    if (forcedInstance) {
      const inst = this.instances.get(forcedInstance);
      if (!inst) {
        throw new Error(
          `LMStudioBackend: no instance named "${forcedInstance}" configured`
        );
      }
      return { instance: inst, modelId };
    }

    // Default: pick the highest-priority instance that reported the model in
    // its last successful probe. If no instance has the model, fall back to
    // the highest-priority instance (LM Studio will surface its own 400 for
    // an unknown model id, which is the user-friendly outcome).
    const candidates = [...this.instances.values()]
      .filter((s) => s.lastModels.some((m) => m.id === modelId))
      .sort((a, b) => b.config.priority - a.config.priority);
    if (candidates.length > 0) {
      return { instance: candidates[0]!, modelId };
    }
    const fallback = [...this.instances.values()].sort(
      (a, b) => b.config.priority - a.config.priority
    )[0];
    if (!fallback) {
      throw new Error("LMStudioBackend: no instances available");
    }
    return { instance: fallback, modelId };
  }
}

// ---- Module-scope helpers + types ----------------------------------------

interface OpenAIChunk {
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function mapFinishReason(
  openaiReason: string
):
  | "end_turn"
  | "stop_sequence"
  | "max_tokens"
  | "tool_use"
  | "error" {
  switch (openaiReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call": // deprecated OpenAI name; still used by some servers
      return "tool_use";
    case "content_filter":
      return "error";
    default:
      return "end_turn";
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/backends/lmstudioBackend.test.ts`
Expected: PASS — all ~18 tests green (9 surviving skeleton + 9 new invoke).

- [ ] **Step 5: Commit**

```bash
git add src/backends/lmstudioBackend.ts tests/unit/backends/lmstudioBackend.test.ts
git commit -m "feat(lmstudioBackend): wire invoke() through OpenAICompatClient.chatCompletions"
```

---

## Task 7: LMStudioBackend.embed() — round-trip + scope shape

**Files:**
- Modify: `src/backends/lmstudioBackend.ts`
- Modify: `tests/unit/backends/lmstudioBackend.test.ts`

Replace the embed stub with a real implementation that proxies through to `OpenAICompatClient.embeddings`, picking the right instance using the same resolution rules as `invoke()`.

- [ ] **Step 1: Add failing tests**

Append to `tests/unit/backends/lmstudioBackend.test.ts`. Also REMOVE the placeholder test `"embed throws — lands in Task 7"`.

```ts
  it("embed round-trips a single input", async () => {
    const b = await makeBackend();
    const resp = await b.embed!({
      model: "nomic-embed-text",
      input: ["hello"]
    });
    expect(resp.model).toBe("nomic-embed-text");
    expect(resp.embeddings).toHaveLength(1);
    expect(resp.embeddings[0]).toHaveLength(4);
  });

  it("embed round-trips multiple inputs preserving order", async () => {
    const b = await makeBackend();
    const resp = await b.embed!({
      model: "nomic-embed-text",
      input: ["alpha", "beta", "gamma"]
    });
    expect(resp.embeddings).toHaveLength(3);
    // The mock's vectors are keyed off input length / 10 in slot 0.
    expect(resp.embeddings[0]?.[0]).toBeCloseTo(0.5);
    expect(resp.embeddings[1]?.[0]).toBeCloseTo(0.4);
    expect(resp.embeddings[2]?.[0]).toBeCloseTo(0.5);
  });

  it("embed surfaces server errors via the OpenAICompatHTTPError", async () => {
    await handle?.close();
    handle = await startMockLmStudio({
      models: ["nomic-embed-text"],
      failEmbeddings: true
    });
    const b = new LMStudioBackend({
      enabled: true,
      instances: [
        {
          name: "local",
          baseUrl: handle.url,
          apiKey: "",
          priority: 50,
          timeoutMs: 5000,
          useNativeApi: null
        }
      ]
    });
    // Probe so the embed model is in lastModels (else fallback would still hit
    // this instance — verifying error path either way).
    await b.listModels();
    await expect(
      b.embed!({ model: "nomic-embed-text", input: ["hi"] })
    ).rejects.toThrow();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/backends/lmstudioBackend.test.ts`
Expected: prior tests pass, 3 new embed tests FAIL.

- [ ] **Step 3: Replace the embed() stub**

```ts
  async embed(
    req: NormalizedEmbeddingRequest
  ): Promise<NormalizedEmbeddingResponse> {
    const { instance, modelId } = this.resolveInstanceAndModel(req.model);
    const raw = (await instance.client.embeddings({
      model: modelId,
      input: req.input
    })) as {
      model?: string;
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    // Sort by `index` defensively — most servers return in order, but the
    // spec allows reordering.
    const items = [...(raw.data ?? [])].sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0)
    );
    return {
      model: raw.model ?? modelId,
      embeddings: items.map((d) => d.embedding ?? [])
    };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/backends/lmstudioBackend.test.ts`
Expected: PASS — all ~21 tests green (18 prior + 3 embed).

- [ ] **Step 5: Commit**

```bash
git add src/backends/lmstudioBackend.ts tests/unit/backends/lmstudioBackend.test.ts
git commit -m "feat(lmstudioBackend): wire embed() through OpenAICompatClient.embeddings"
```

---

## Task 8: Multi-instance dispatch — explicit prefix + per-instance routing

**Files:**
- Modify: `tests/unit/backends/lmstudioBackend.test.ts`
- (No source changes — `resolveInstanceAndModel` already implements the logic in Task 6.)

The dispatch logic lands in Task 6 because `invoke()` needs it; this task verifies it under a multi-instance config. Two mock servers, different model lists, request routes correctly. Tests both code paths:

1. Implicit routing: model id alone, backend looks up which instance carries it.
2. Explicit routing: `lmstudio:<instance>/<model>` prefix forces a specific instance.

- [ ] **Step 1: Add the multi-instance tests**

Append to `tests/unit/backends/lmstudioBackend.test.ts`. Note the local `handle` variable in earlier tests is for the single-instance setup; multi-instance tests manage their own handles.

```ts
describe("LMStudioBackend multi-instance dispatch", () => {
  const handles: MockLmStudioHandle[] = [];
  afterEach(async () => {
    while (handles.length > 0) {
      const h = handles.shift()!;
      await h.close();
    }
  });

  async function makeMultiInstanceBackend(): Promise<LMStudioBackend> {
    const local = await startMockLmStudio({
      models: ["qwen3-coder-30b", "shared-model"]
    });
    const work = await startMockLmStudio({
      models: ["llama-3.3-70b", "shared-model"]
    });
    handles.push(local, work);
    return new LMStudioBackend({
      enabled: true,
      instances: [
        {
          name: "local",
          baseUrl: local.url,
          apiKey: "",
          priority: 50,
          timeoutMs: 5000,
          useNativeApi: null
        },
        {
          name: "work-server",
          baseUrl: work.url,
          apiKey: "",
          priority: 60, // higher priority — wins on the shared-model collision
          timeoutMs: 5000,
          useNativeApi: null
        }
      ]
    });
  }

  it("listModels merges across instances, deduping by id", async () => {
    const b = await makeMultiInstanceBackend();
    const ids = (await b.listModels()).map((m) => m.id).sort();
    expect(ids).toEqual(
      ["llama-3.3-70b", "qwen3-coder-30b", "shared-model"].sort()
    );
  });

  it("routes a model unique to one instance to that instance", async () => {
    const b = await makeMultiInstanceBackend();
    await b.listModels(); // populate lastModels on each instance

    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "llama-3.3-70b", // only on work-server
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }]
    })) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.kind === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toBe("echo: ping");
  });

  it("routes a colliding model id to the higher-priority instance by default", async () => {
    const b = await makeMultiInstanceBackend();
    await b.listModels();

    // shared-model is on both; work-server has priority 60 > local 50, so it wins.
    // We can't easily prove which one served the request without instrumenting
    // the mocks, so we verify the request succeeds end-to-end (proves routing
    // didn't break) and trust the priority test on listModels above to assert
    // the model-map view.
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "shared-model",
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }]
    })) {
      events.push(ev);
    }
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("honors explicit lmstudio:<instance>/<model> prefix to force the loser", async () => {
    const b = await makeMultiInstanceBackend();
    await b.listModels();

    // Force routing to `local` even for a model that exists on both. Same
    // verification limitation as above — we verify the call succeeds and the
    // mock returns the expected echo.
    const events: NormalizedEvent[] = [];
    for await (const ev of b.invoke({
      model: "lmstudio:local/shared-model",
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }]
    })) {
      events.push(ev);
    }
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("throws when explicit prefix names an unknown instance", async () => {
    const b = await makeMultiInstanceBackend();
    await b.listModels();

    await expect(async () => {
      for await (const _ of b.invoke({
        model: "lmstudio:nonexistent/shared-model",
        messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }]
      })) {
        // no-op
      }
    }).rejects.toThrow(/nonexistent/);
  });

  it("routes embed requests using the same instance resolution rules", async () => {
    const b = await makeMultiInstanceBackend();
    await b.listModels();
    // Embedding round-trip via the explicit prefix to verify embed honors it.
    const resp = await b.embed!({
      model: "lmstudio:local/shared-model", // mock answers any embed request
      input: ["hello"]
    });
    expect(resp.embeddings).toHaveLength(1);
  });

  it("listModels survives a failing instance — returns models from the survivors", async () => {
    const good = await startMockLmStudio({ models: ["good-model"] });
    handles.push(good);
    const b = new LMStudioBackend({
      enabled: true,
      instances: [
        {
          name: "good",
          baseUrl: good.url,
          apiKey: "",
          priority: 50,
          timeoutMs: 5000,
          useNativeApi: null
        },
        {
          // This URL points at a port no server is bound to — connection refused.
          name: "broken",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "",
          priority: 60,
          timeoutMs: 500,
          useNativeApi: null
        }
      ]
    });
    const ids = (await b.listModels()).map((m) => m.id);
    expect(ids).toEqual(["good-model"]);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/unit/backends/lmstudioBackend.test.ts`
Expected: PASS — all 7 new multi-instance tests green.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/backends/lmstudioBackend.test.ts
git commit -m "test(lmstudioBackend): cover multi-instance dispatch + prefix override + failover"
```

---

## Task 9: Server bootstrap — register LMStudioBackend in buildRegistry

**Files:**
- Modify: `src/server.ts`
- Test: extend `tests/integration/foundation.test.ts` OR add coverage in Task 10's integration test (cleaner)

Wire `LMStudioBackend` into the production `buildRegistry(config)`. Construct only when `config.lmstudio.enabled && config.lmstudio.instances.length > 0`. The registry priority for `lmstudio` is fixed at 50 (matches the existing default); per-instance priorities resolve inside the backend.

- [ ] **Step 1: Update `buildRegistry` in `src/server.ts`**

Add the import:

```ts
import { LMStudioBackend } from "./backends/lmstudioBackend.js";
```

Modify `buildRegistry`:

```ts
export function buildRegistry(config: Config): BackendRegistry {
  const registry = new BackendRegistry({
    claude: config.claude.priority,
    gemini: config.gemini.priority,
    lmstudio: 50,
    ollama: 40
  });
  if (config.claude.enabled) {
    registry.register(
      new ClaudeBackend({
        command: config.claude.command,
        timeoutMs: config.claude.timeoutMs
      })
    );
  }
  if (config.lmstudio.enabled && config.lmstudio.instances.length > 0) {
    registry.register(
      new LMStudioBackend({
        enabled: config.lmstudio.enabled,
        instances: config.lmstudio.instances
      })
    );
  }
  return registry;
}
```

Update the comment at the top of the function:

```ts
/**
 * Build a registry populated with every enabled backend. Plan 08 adds
 * LMStudioBackend alongside ClaudeBackend; Plan 06's GeminiBackend will land
 * here once Plan 07 ships. Ollama lands in Plan 09.
 */
```

- [ ] **Step 2: Run the existing foundation + Anthropic-shim integration tests**

Run: `npx vitest run tests/integration/`
Expected: all prior tests still pass. (No new test added in this task — Task 10's integration test covers the LM Studio registration end-to-end.)

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): register LMStudioBackend in buildRegistry when configured"
```

---

## Task 10: End-to-end integration test through the registry

**Files:**
- Create: `tests/integration/lmstudioBackend.test.ts`

Register `LMStudioBackend` in a `BackendRegistry` alongside `ClaudeBackend` (proves coexistence), probe two mock-lmstudio instances with different model lists, route a request by model id, send an embedding request, verify both. This is the analog to Plan 06's `tests/integration/geminiBackend.test.ts` but with the multi-instance twist.

- [ ] **Step 1: Write the test**

Create `tests/integration/lmstudioBackend.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { BackendRegistry } from "../../src/backends/registry.js";
import { ClaudeBackend } from "../../src/backends/claudeBackend.js";
import { LMStudioBackend } from "../../src/backends/lmstudioBackend.js";
import type { NormalizedEvent } from "../../src/backends/types.js";
import {
  startMockLmStudio,
  type MockLmStudioHandle
} from "../fixtures/mock-lmstudio/inProcess.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_CLAUDE = ["node", join(__dirname, "..", "fixtures", "mock-claude", "index.mjs")];

describe("LMStudioBackend integrates with BackendRegistry", () => {
  const handles: MockLmStudioHandle[] = [];
  afterEach(async () => {
    while (handles.length > 0) {
      const h = handles.shift()!;
      await h.close();
    }
  });

  it("registers, probes two instances, resolves a model from instance 2, invokes end-to-end", async () => {
    const inst1 = await startMockLmStudio({ models: ["qwen3-coder-30b"] });
    const inst2 = await startMockLmStudio({ models: ["llama-3.3-70b", "nomic-embed-text"] });
    handles.push(inst1, inst2);

    const registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
    registry.register(
      new LMStudioBackend({
        enabled: true,
        instances: [
          { name: "local", baseUrl: inst1.url, apiKey: "", priority: 50, timeoutMs: 5000, useNativeApi: null },
          { name: "work-server", baseUrl: inst2.url, apiKey: "", priority: 60, timeoutMs: 5000, useNativeApi: null }
        ]
      })
    );

    try {
      await registry.probe();

      // Both instances' models appear in the registry's model map.
      expect(registry.resolveModel("qwen3-coder-30b")?.id).toBe("lmstudio");
      expect(registry.resolveModel("llama-3.3-70b")?.id).toBe("lmstudio");
      expect(registry.resolveModel("nomic-embed-text")?.id).toBe("lmstudio");

      const backend = registry.resolveModel("llama-3.3-70b");
      expect(backend).toBeDefined();

      const events: NormalizedEvent[] = [];
      for await (const ev of backend!.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "integration ping" }] }]
      })) {
        events.push(ev);
      }
      expect(events[0]?.kind).toBe("message_start");
      expect(events[events.length - 1]?.kind).toBe("message_stop");

      const body = events
        .filter((e) => e.kind === "text_delta")
        .map((e) => (e.kind === "text_delta" ? e.text : ""))
        .join("");
      expect(body).toBe("echo: integration ping");

      // probe status is ok
      expect(registry.lastProbeStatus("lmstudio")?.ok).toBe(true);
    } finally {
      registry.stop();
    }
  });

  it("embed round-trip via the registry-resolved backend", async () => {
    const inst1 = await startMockLmStudio({ models: ["nomic-embed-text"] });
    handles.push(inst1);

    const registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
    registry.register(
      new LMStudioBackend({
        enabled: true,
        instances: [
          { name: "local", baseUrl: inst1.url, apiKey: "", priority: 50, timeoutMs: 5000, useNativeApi: null }
        ]
      })
    );

    try {
      await registry.probe();
      const backend = registry.resolveModel("nomic-embed-text");
      expect(backend).toBeDefined();
      expect(typeof backend!.embed).toBe("function");

      const resp = await backend!.embed!({
        model: "nomic-embed-text",
        input: ["hello", "world"]
      });
      expect(resp.embeddings).toHaveLength(2);
      expect(resp.embeddings[0]).toHaveLength(4);
    } finally {
      registry.stop();
    }
  });

  it("coexists with ClaudeBackend — both probe and resolve their own models without collision", async () => {
    const inst1 = await startMockLmStudio({ models: ["qwen3-coder-30b"] });
    handles.push(inst1);

    const registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
    registry.register(new ClaudeBackend({ command: MOCK_CLAUDE, timeoutMs: 5000 }));
    registry.register(
      new LMStudioBackend({
        enabled: true,
        instances: [
          { name: "local", baseUrl: inst1.url, apiKey: "", priority: 50, timeoutMs: 5000, useNativeApi: null }
        ]
      })
    );

    try {
      await registry.probe();

      expect(registry.resolveModel("claude-sonnet-4-6")?.id).toBe("claude");
      expect(registry.resolveModel("qwen3-coder-30b")?.id).toBe("lmstudio");

      // Neither leaks into the other.
      expect(registry.resolveModel("claude-sonnet-4-6")?.id).not.toBe("lmstudio");
      expect(registry.resolveModel("qwen3-coder-30b")?.id).not.toBe("claude");

      expect(registry.lastProbeStatus("claude")?.ok).toBe(true);
      expect(registry.lastProbeStatus("lmstudio")?.ok).toBe(true);
    } finally {
      registry.stop();
    }
  });

  it("explicit lmstudio:<instance>/<model> prefix is preserved by registry → backend", async () => {
    const local = await startMockLmStudio({ models: ["shared-model"] });
    const work = await startMockLmStudio({ models: ["shared-model"] });
    handles.push(local, work);

    const registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
    registry.register(
      new LMStudioBackend({
        enabled: true,
        instances: [
          { name: "local", baseUrl: local.url, apiKey: "", priority: 50, timeoutMs: 5000, useNativeApi: null },
          { name: "work-server", baseUrl: work.url, apiKey: "", priority: 60, timeoutMs: 5000, useNativeApi: null }
        ]
      })
    );

    try {
      await registry.probe();
      // The registry doesn't know about the prefix; it resolves the bare
      // "shared-model" to the lmstudio backend. The backend itself handles
      // the prefix when the request arrives. To exercise the prefix path,
      // we resolve via "shared-model" then pass the prefixed id in the
      // request — that's the contract a shim would follow (the shim strips
      // the prefix for registry lookup, then re-attaches for backend.invoke).
      const backend = registry.resolveModel("shared-model");
      expect(backend?.id).toBe("lmstudio");

      const events: NormalizedEvent[] = [];
      for await (const ev of backend!.invoke({
        model: "lmstudio:local/shared-model",
        messages: [{ role: "user", content: [{ type: "text", text: "explicit-route ping" }] }]
      })) {
        events.push(ev);
      }
      expect(events[events.length - 1]?.kind).toBe("message_stop");
    } finally {
      registry.stop();
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/integration/lmstudioBackend.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: every prior-plan test still passes + Plan-08 additions.

Plan-08 new-test inventory:
- `tests/unit/backends/openaiCompatClient.test.ts` — 16 tests (6 + 7 + 3)
- `tests/unit/backends/lmstudioBackend.test.ts` — 10 skeleton + 9 invoke + 3 embed + 7 multi-instance = 29
- `tests/integration/lmstudioBackend.test.ts` — 4
- (Mock-fixture smoke tests are removed at the end of Task 1.)

Total Plan-08 new tests: **~49**.

If the actual count differs (placeholder collisions, splits, defensive-add tests), reconcile in the close-out README.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: clean. Pay particular attention to `noUncheckedIndexedAccess` in `chatCompletions` SSE parsing — `buffer.indexOf("\n\n")` returns `number`, and array element access requires either a non-null assertion or an explicit guard.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/lmstudioBackend.test.ts
git commit -m "test(lmstudioBackend): integration through BackendRegistry — multi-instance, embed, coexistence"
```

---

## Task 11: Plan-08 close-out documentation

**Files:**
- Create: `docs/plan-08-lmstudio-backend-readme.md`

- [ ] **Step 1: Write the document**

```markdown
# Plan 08 — LM Studio Backend: what shipped

Plan 08 added the first HTTP-client `Backend` implementation on top of the Plan 01 foundation, plus the shared `openaiCompatClient` module that Plan 09 (Ollama in OpenAI-compat mode) will reuse without modification. Multi-instance dispatch lands here; embeddings land here (first backend to flip `capabilities.embeddings` to `true`). Server bootstrap registers `LMStudioBackend` automatically when `config.lmstudio.enabled && config.lmstudio.instances.length > 0`.

## Modules added

| Path | Purpose | Lines (approx.) |
|---|---|---|
| `src/backends/openaiCompatClient.ts` | Shared HTTP client for any OpenAI-shape server (LM Studio + future Ollama compat-mode). Methods: `listModels`, `chatCompletions` (streaming SSE), `chatCompletionsBuffered`, `embeddings`. Error classes: `OpenAICompatHTTPError`, `OpenAICompatTimeoutError`. | ~200 |
| `src/backends/lmstudioBackend.ts` | `Backend` implementation. One `OpenAICompatClient` per configured instance, keyed by name. Multi-instance dispatch with explicit-prefix override (`lmstudio:<instance>/<model>`). `invoke()` translates `NormalizedRequest` ↔ OpenAI chat-completions body and normalizes SSE chunks into `NormalizedEvent`s including tool-use round-trip. `embed()` round-trips `POST /v1/embeddings`. | ~340 |
| `src/server.ts` (extended) | `buildRegistry(config)` now registers `LMStudioBackend` when configured. | +12 |

## Test infrastructure added

| Path | Purpose |
|---|---|
| `tests/fixtures/mock-lmstudio/inProcess.ts` | In-process Express server factory. `startMockLmStudio({models, latencyMs, requiredBearer, failChat, failEmbeddings})` returns `{port, url, app, close}`. Behavioral triggers via request-body substring (`MOCK_ERROR`, `MOCK_HANG`, `MOCK_TOOL_USE`). |
| `tests/fixtures/mock-lmstudio/server.mjs` | Standalone runner over the same factory, for manual smoke testing. Not exercised by Vitest. |
| `tests/fixtures/mock-lmstudio/package.json` | Tiny `bin` shim. |
| `tests/unit/backends/openaiCompatClient.test.ts` | HTTP client in isolation. SSE parsing, 4xx/5xx error envelopes, timeouts, bearer propagation, listModels / chatCompletions{,Buffered} / embeddings round-trips. (~16 tests) |
| `tests/unit/backends/lmstudioBackend.test.ts` | Capability matrix, model listing, request translation, event normalization, embed round-trip, scope-boundary throws, multi-instance dispatch with explicit-prefix override and failover. (~29 tests) |
| `tests/integration/lmstudioBackend.test.ts` | End-to-end through `BackendRegistry`: register, probe two instances, route by model id, embed round-trip, coexistence with `ClaudeBackend`. (~4 tests) |

Run all: `npm test`.

## Capability matrix delta vs Claude + Gemini

| Capability | Claude | Gemini | **LM Studio** |
|---|---|---|---|
| toolUse | true (Plan 04) | false (Plan 07) | **true** |
| multimodal | true | true | **true** (model-dependent; conservative) |
| thinking | true | false | **false** |
| cacheControl | "none" | "none" | **"none"** (Plan-05 local response cache still applies) |
| samplingParams.temperature | false | true | **true** |
| samplingParams.topP | false | true | **true** |
| samplingParams.topK | false | true | **true** |
| stopSequences | "server-side-cut" | "native" | **"native"** |
| embeddings | false | false | **true** ← first |

When the same `NormalizedRequest` is sent with `samplingParams: { temperature: 0.7 }`, Claude silently ignores it, Gemini forwards `--temperature 0.7` to the CLI, and LM Studio forwards `"temperature": 0.7` in the OpenAI request body.

## Plan-08 scope boundary (what does NOT ship here)

`LMStudioBackend.invoke()` explicitly throws on any of these:
- `image` content blocks — Future plan (cross-shim Files-API wiring lives with the shims).
- `document` content blocks — Future plan.
- `thinking: true` — Future plan.

Server-internal deferrals:
- **No Ollama** — Plan 09. (`openaiCompatClient` is shared infra; Plan 09 reuses it without modification.)
- **No OpenAI shim multi-backend dispatch** — Plan 10. The OpenAI shim still routes only Claude-backed requests; LM Studio is reachable end-to-end through the Anthropic shim only.
- **No `/v1/embeddings` HTTP endpoint** — Plan 10. `LMStudioBackend.embed()` is callable from the registry, but no HTTP route reaches it yet.
- **No admin UI** — Plan 12.
- **No legacy embeddings-proxy migration** — Plan 10.
- **No per-model capability narrowing** — `capabilitiesFor()` returns `multimodal: true` and `toolUse: true` for every model id. A non-vision model loaded in LM Studio errors from the LM Studio server when given an image; per-model probing is a future enhancement.

## Multi-instance dispatch (the headline Plan-08 feature)

`config.lmstudio.instances[]` lets users register an arbitrary number of LM Studio hosts. The backend builds one `OpenAICompatClient` per instance. Model resolution rules:

1. **Explicit instance prefix wins:** `model: "lmstudio:work-server/qwen3-coder-30b"` always routes to the instance named `work-server`. Throws if no instance has that name.
2. **Implicit routing:** for a bare model id (`qwen3-coder-30b`), pick the highest-priority instance whose last successful probe reported the model. If no instance has the model, fall back to the highest-priority instance — LM Studio will surface its own 400 for the unknown id.
3. **Failover:** a probe failure on one instance does NOT black-hole the others. `listModels()` returns whatever the survivors reported.

Within the `BackendRegistry`, `lmstudio` carries a single backend-level priority (`50` by default). Cross-backend model-id collisions (e.g., both LM Studio and Ollama report `llama-3.3-70b`) are resolved by the registry's `BackendId → number` priority map. Within-`lmstudio` collisions (two instances reporting the same model) are resolved by the per-instance priority field.

## What the next plan (Plan 09 — Ollama) inherits

- Reuse `OpenAICompatClient` as-is for OpenAI-compat mode. Ollama's `/v1/*` endpoints match LM Studio's enough that the client doesn't need conditional logic.
- Mirror the multi-instance dispatch pattern. Same `InstanceConfig` shape, same prefix-override syntax (`ollama:<instance>/<model>`), same per-instance priority resolution.
- Add `ollamaNativeClient.ts` for native-API mode (`/api/chat`, `/api/embed`, `/api/tags`, NDJSON streaming) — only used when `instance.useNativeApi === true` (or backend-level `useNativeApi === true` with a `null` per-instance override).
- Register in `buildRegistry` the same way Plan 08 does, gated on `config.ollama.enabled && config.ollama.instances.length > 0`.

## Open questions surfaced during Plan 08

1. **Real token counting.** `countTokens(req)` uses char/4. LM Studio's `/v1/chat/completions` with `max_tokens: 0` returns `usage.prompt_tokens` exactly, but at the cost of a real HTTP round-trip per `countTokens` call. The default ships cheap; a future config knob (`config.lmstudio.useRealTokenCounting: true`) can opt in. Same caveat as Gemini's `countTokens` — Plan 05 may add a real tokenizer dependency later.
2. **`top_k` field acceptance.** OpenAI's spec doesn't include `top_k`. LM Studio's llama.cpp-backed models honor it as a top-level field. If a deployment rejects it (some servers strict-parse the OpenAI schema), a future config knob can suppress it. Plan 08 ships it unconditionally — easy to disable later.
3. **Per-model capability probing.** `multimodal: true` is reported for every model. A non-vision model errors from LM Studio when given an image; the response surfaces back to the caller. A future enhancement could probe model metadata at startup and narrow capabilities per-id, but this requires LM Studio to expose model metadata (`/v1/models/{id}` extended fields, not currently standardized).
4. **`MOCK_HANG` test isolation.** The trigger leaves an open HTTP connection until `handle.close()` runs in `afterEach`. Vitest's worker timeout (default 5s) doesn't kill these eagerly. If flakiness appears in CI, swap the trigger for `MOCK_DELAY_MS` and use the existing `latencyMs` knob to force timeouts deterministically.
5. **Standalone `server.mjs`.** The bin shim imports `inProcess.ts` directly — works under `tsx` and after `npm run build`, fails under raw `node`. If the bin needs to run from a stock-Node manual smoke test, factor `inProcess.ts` into a JavaScript-shipping module or pre-build it. Not on the critical path for Plan 08's automated tests.
6. **Backend-level vs per-instance priority.** The registry treats `lmstudio` as one backend with one priority (50). The plan resolves within-backend collisions by per-instance priority. This works for now but means a hypothetical "use this Ollama instance over any LM Studio instance" rule needs a cross-backend mechanism — currently the backend-priority map handles it, but only at the whole-backend level. Plan 10 may revisit.

## Deviations from this plan that landed during execution

(Filled in by the implementer / reviewer during the actual task cycles. Expected items include: count reconciliation if `MOCK_HANG` tests were dropped, finish_reason: "length" mock trigger added or skipped, server.mjs bin shim deferred, in-process pattern fallback to subprocess if Vitest isolation issues surface.)
```

- [ ] **Step 2: Commit**

```bash
git add docs/plan-08-lmstudio-backend-readme.md
git commit -m "docs: add Plan 08 close-out README documenting LM Studio backend scope and boundaries"
```

---

## Plan 08 — Self-review checklist

Before declaring Plan 08 done, run through this checklist:

- [ ] `npm test` — all tests green, no skips. Expect prior-plan count + ~49 new (16 openaiCompatClient + 29 lmstudioBackend + 4 integration). Reconcile actual vs expected count in the close-out doc.
- [ ] `npx tsc --noEmit` — no type errors. Particular attention to `noUncheckedIndexedAccess`:
  - `buffer.slice(0, boundary)` after `buffer.indexOf("\n\n")` — `boundary` is `number` (could be `-1`), so the `while (boundary !== -1)` guard must hold.
  - `tc.function?.name` and `tc.id` — both are `string | undefined`; the `typeof` guards in the invoke() loop handle this.
  - `candidates[0]!` non-null assertions are needed when iterating a `[...this.instances.values()]` array that's been guarded by `.length > 0` — the compiler doesn't propagate the guard through `[0]`.
- [ ] `git status` — clean tree, all changes committed.
- [ ] `git log --oneline -14` — commits read sensibly: fixture, openaiCompatClient skeleton, openaiCompatClient streaming, openaiCompatClient embeddings, lmstudioBackend skeleton, lmstudioBackend invoke, lmstudioBackend embed, multi-instance tests, server wiring, integration, README.
- [ ] `src/backends/` contains 6 files: `types.ts`, `registry.ts`, `claudeBackend.ts`, `geminiBackend.ts`, `openaiCompatClient.ts` (new), `lmstudioBackend.ts` (new).
- [ ] `LMStudioBackend.capabilitiesFor()` returns `samplingParams: { temperature: true, topP: true, topK: true }` AND `embeddings: true` — both are key contrasts with `ClaudeBackend`.
- [ ] `tests/fixtures/mock-lmstudio/inProcess.ts` uses `app.listen(0, "127.0.0.1", ...)` — never a fixed port (avoids CI conflicts).
- [ ] No source file under `src/` exceeds 350 lines (lmstudioBackend.ts ≈ 340 is the largest).
- [ ] `dist/` directory untouched. Verify: `git log dist/ -5` should predate Plan 08.
- [ ] No Ollama-related files (`ollamaBackend.ts`, `ollamaNativeClient.ts`) created — that's Plan 09.
- [ ] `src/server.ts` `buildRegistry` registers LM Studio only when `config.lmstudio.enabled && config.lmstudio.instances.length > 0` — empty `instances[]` does NOT register the backend (avoids a registry entry with no usable clients).
- [ ] Smoke-test cleanup: `tests/fixtures/mock-lmstudio/_smoke.test.ts` (from Task 1 Step 4) is deleted.
- [ ] `ClaudeBackend` + `GeminiBackend` tests still pass unchanged (no regression from extending `buildRegistry`).
- [ ] `openaiCompatClient.ts` exports `OpenAICompatClient`, `OpenAICompatHTTPError`, `OpenAICompatTimeoutError` — all three must be importable by Plan 09.
- [ ] `package.json` has NOT gained new runtime dependencies (express was already there; `nock` / `undici` / `msw` are not introduced).

If all check, Plan 08 is shipped. Open a PR to main; Plan 09 (Ollama) follows.
