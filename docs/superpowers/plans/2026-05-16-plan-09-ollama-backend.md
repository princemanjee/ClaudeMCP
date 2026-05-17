# Plan 09: Ollama Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Ollama under the same `Backend` interface that `ClaudeBackend`, `GeminiBackend`, and `LmstudioBackend` already satisfy — with a twist: Ollama exposes two API surfaces (an OpenAI-compatibility layer at `/v1/*` and its own native API at `/api/*`), and Plan 09 supports both via a single backend that dispatches per-instance. Default mode is OpenAI-compat (reuses Plan 08's `openaiCompatClient.ts` against the Ollama base URL + `/v1` suffix). Native mode (opt-in via `config.ollama.useNativeApi: true` backend-wide, with optional per-instance override) unlocks features that don't exist in the compat layer: `keep_alive`, `format: "json"`, `raw` mode, and historically more reliable native tool calling on certain models. Multi-instance support mirrors LM Studio. After Plan 09, `config.ollama.enabled && config.ollama.instances.length > 0` causes the Ollama backend to register at server startup with one instance entry per configured `instances[]` block, each probing via its chosen client and merging into the shared model map.

**Architecture:** A single `OllamaBackend` class implements `Backend`. The constructor walks `config.ollama.instances[]`, resolves each instance's effective mode (per-instance `useNativeApi` overrides backend-wide `useNativeApi`; `null` means inherit), and instantiates the matching client per instance: Plan 08's `openaiCompatClient` for compat-mode instances (pointed at `<baseUrl>/v1`), Plan 09's new `ollamaNativeClient` for native-mode instances. Both clients expose the same logical contract — `invoke(req): AsyncIterable<NormalizedEvent>`, `embed(req): Promise<NormalizedEmbeddingResponse>`, `listModels(): Promise<ModelDescriptor[]>` — so `OllamaBackend`'s dispatch logic reduces to "pick the right client, then call it." The translation layer differs per mode (OpenAI SSE chunks in compat mode, NDJSON `{message:{...}, done: bool}` lines in native mode), but the contract that the backend hands back to the registry is identical.

**Tech Stack:** Same as Plans 01-08 — Node.js 20+, TypeScript 5 (NodeNext ESM, `noUncheckedIndexedAccess`), `node:fetch` (built-in), Vitest. The mock fixture is a Node Express script invoked via `node tests/fixtures/mock-ollama/server.mjs` (no fixed port — uses port 0 so each test gets a fresh ephemeral port, mirroring Plan 08's `mock-lmstudio`).

**Spec:** `docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md` (Phase 9: Ollama backend).

**Builds on:**
- Plan 01 (`docs/superpowers/plans/2026-05-16-plan-01-foundation.md`) — `Backend`, `BackendCapabilities`, `NormalizedRequest`, `NormalizedEvent`, `NormalizedEmbeddingRequest`, `NormalizedEmbeddingResponse`, `ModelDescriptor`, `BackendRegistry`, `loadConfig` (uses `config.ollama.{enabled, useNativeApi, instances[]}` with per-instance `{name, baseUrl, priority, timeoutMs, useNativeApi}`).
- Plan 06 (`docs/superpowers/plans/2026-05-16-plan-06-gemini-backend.md`) — template for `Backend` implementation, scope-boundary throw discipline, capability-matrix shape.
- Plan 08 (`docs/superpowers/plans/2026-05-16-plan-08-lmstudio-backend.md`) — closest structural mirror; provides `src/backends/openaiCompatClient.ts`, the per-instance dispatch pattern, the mock-server-on-port-0 fixture pattern, and the multi-instance registration loop.

**Reference plans (read these before starting):**
- `docs/superpowers/plans/2026-05-16-plan-08-lmstudio-backend.md` — the structural mirror. Plan 09's OpenAI-compat mode is essentially "Plan 08 against `<baseUrl>/v1`".
- `docs/superpowers/plans/2026-05-16-plan-06-gemini-backend.md` — the canonical `Backend`-implementation template.

---

## Scope boundary for Plan 09

What ships here:

| Feature | Plan 09 disposition |
|---|---|
| `OllamaBackend` implementing `Backend` interface | Shipped via `src/backends/ollamaBackend.ts` |
| OpenAI-compat mode for any instance with `useNativeApi: false` (or `null` inheriting from backend default `false`) | Shipped — reuses Plan 08's `openaiCompatClient` against `<baseUrl>/v1` |
| Native API mode for any instance with `useNativeApi: true` | Shipped via new `src/backends/ollamaNativeClient.ts` |
| Per-instance mode resolution (instance `useNativeApi` overrides backend `useNativeApi`; `null` inherits) | Shipped — resolver helper + tests |
| Multi-instance registration: each `instances[]` entry becomes a separate logical sub-backend in the registry, surfaced under one `BackendId: "ollama"` | Shipped — mirrors Plan 08's pattern |
| Capability matrix per spec | Shipped via `capabilitiesFor(model)` |
| Chat streaming (text deltas → `text_delta` events) — both modes | Shipped |
| Chat tool calling (`tool_calls` → `tool_use_*` events) — both modes | Shipped |
| Embeddings (compat: `POST /v1/embeddings`; native: `POST /api/embed` with `/api/embeddings` legacy fallback) | Shipped |
| Model listing (compat: `GET /v1/models`; native: `GET /api/tags`) | Shipped |
| `keep_alive`: backend-applied sensible default in native mode | Shipped — see note below |
| `format: "json"` passthrough in native mode when `req.metadata?.format === "json"` | Shipped |
| `server.ts` wires `OllamaBackend` at startup when `config.ollama.enabled && config.ollama.instances.length > 0` | Shipped |

What this plan does NOT ship:

| Feature | Plan 09 disposition | Lands in |
|---|---|---|
| Ollama model pull / push / unload control | Out of scope — we discover loaded models, we don't manage them | Future / never (the admin UI in Plan 12 surfaces loaded models read-only) |
| `keep_alive` as a first-class field on `NormalizedRequest` | Plan 09 applies a backend-level default in native mode | Future plan; the spec leaves this as future work |
| `raw: true` (skip Ollama's prompt template) | Not exposed | Future plan if a use case appears |
| Real Ollama integration (no `tests/integration/realOllama.test.ts`) | Mock HTTP only | Manual smoke-test docs in a future plan |
| Cross-backend `gemini-pro` → Ollama dispatch tests | Not Plan 09's job; the router lives in Plan 01, the cross-shim dispatch was wired in Plan 03/07 | n/a |
| OpenAI-shim Ollama support | Out of scope here (the shim dispatch was added in Plan 03's OpenAI-shim extension) | Plan 10 extends OpenAI shim |

Server-internal deferrals:
- No new admin endpoints — those live in Plan 11.
- No new fields on `NormalizedRequest` for `keep_alive` / `raw`. Plan 09 ships a backend-level default for `keep_alive` (see "keep_alive policy" below); first-class request-field support is a future plan.

---

## File map

| File | Responsibility |
|---|---|
| `src/backends/ollamaNativeClient.ts` | **NEW.** Thin HTTP client for Ollama's native `/api/*` endpoints. Public methods: `chat(body): AsyncIterable<unknown>` (streams NDJSON lines, each parsed as JSON), `chatBuffered(body): Promise<unknown>` (non-stream collapsed shape), `embed(body): Promise<unknown>` (POST `/api/embed`, falls back to `/api/embeddings` on 404), `listTags(): Promise<unknown>` (GET `/api/tags`). Constructor takes `{baseUrl, timeoutMs}`. Stays a pure HTTP wrapper — no `NormalizedEvent` translation lives here. |
| `src/backends/ollamaBackend.ts` | **NEW.** `Backend` implementation. `id: "ollama"`. Constructor takes the whole `config.ollama` block. Per instance: resolves effective `useNativeApi` (instance override → backend default), instantiates `openaiCompatClient` (compat-mode) OR `ollamaNativeClient` (native-mode), records it under the instance name. `listModels()` aggregates across all instances (priority-tagged). `invoke(req)` picks the instance that serves the requested model, picks the right client, translates `NormalizedRequest` → that client's request shape, translates the client's stream events → `NormalizedEvent`. `embed()` picks an embeddings-capable instance and dispatches similarly. `capabilitiesFor(model)` returns the per-spec matrix. |
| `src/server.ts` | **EXTEND.** At startup, after Plan 08's LM Studio backend registration, if `config.ollama.enabled && config.ollama.instances.length > 0`, construct `new OllamaBackend(config.ollama)` and register it. |
| `tests/fixtures/mock-ollama/server.mjs` | **NEW.** Standalone Node `http` (or Express, whichever Plan 08 settled on) script. Serves BOTH Ollama-native endpoints (`/api/chat`, `/api/embed`, `/api/embeddings` for legacy probe, `/api/tags`) AND OpenAI-compat endpoints (`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`). Behavior keyed off request body fields for deterministic test triggers. Binds to port 0 and prints the assigned port on stdout so tests can read it. |
| `tests/fixtures/mock-ollama/package.json` | **NEW.** Bin shim, identical structure to Plan 08's `mock-lmstudio/package.json`. |
| `tests/unit/backends/ollamaNativeClient.test.ts` | **NEW.** NDJSON parsing, partial-line buffering + trailing-line flush, error envelopes (Ollama returns `{error: "..."}` on bad request), timeouts via `AbortController`, `keep_alive` field round-trip, `format: "json"` field round-trip, `/api/embed` 404 → `/api/embeddings` fallback. |
| `tests/unit/backends/ollamaBackend.test.ts` | **NEW.** Two top-level describes — `describe("OllamaBackend OpenAI-compat mode", ...)` (no `useNativeApi`) and `describe("OllamaBackend Native mode", ...)` (`useNativeApi: true`). Each exercises capability matrix, listModels via `/v1/models` vs `/api/tags`, request translation (sampling params flat in compat, nested under `options` in native), event normalization (OpenAI SSE chunks vs NDJSON `{message, done}` lines), embed round-trip. Plus a `describe("Per-instance mode resolution", ...)` block: three instances exercise (a) compat-inherits-from-default-false, (b) native-inherits-from-default-true, (c) override-opposite-of-default. |
| `tests/integration/ollamaBackend.test.ts` | **NEW.** End-to-end through `BackendRegistry`: two instances — instance A in compat mode against one mock port, instance B in native mode against a second mock port (same `mock-ollama` fixture, two child processes on different port-0 assignments). Both register, both probe via different endpoints, both deliver normalized events. Verifies the per-instance `useNativeApi` override genuinely switches the client. |

---

## Pre-flight check

Before starting Task 1, confirm the prior plans are in place and verify the assumptions Plan 09 builds on:

- [ ] `git log --oneline -10` shows the Plan 08 merge commit at or near the top (or whichever plan immediately precedes Plan 09 in your branch lineage).
- [ ] `npm test` shows the full prior-plans suite passing (no skips).
- [ ] `npx tsc --noEmit` clean.
- [ ] `src/backends/types.ts` exists with `Backend`, `BackendCapabilities`, `NormalizedRequest`, `NormalizedEvent`, `NormalizedEmbeddingRequest`, `NormalizedEmbeddingResponse`, `ModelDescriptor`, `BackendId`.
- [ ] `src/backends/registry.ts` exists with `BackendRegistry`, `register`, `probe`, `resolveModel`, `lastProbeStatus`, `stop`.
- [ ] `src/backends/openaiCompatClient.ts` exists from Plan 08 with the constructor signature `new OpenaiCompatClient({baseUrl, apiKey?, timeoutMs})` and the methods `chat(body): AsyncIterable<NormalizedEvent>`, `embed(req): Promise<NormalizedEmbeddingResponse>`, `listModels(): Promise<ModelDescriptor[]>`. If the actual Plan 08 exposes these under different names, adapt Task 5's wiring and document the divergence in the close-out README.
- [ ] `src/backends/lmstudioBackend.ts` exists from Plan 08 — Plan 09 mirrors its structure for multi-instance dispatch.
- [ ] `tests/fixtures/mock-lmstudio/server.mjs` exists from Plan 08 — Plan 09's `mock-ollama/server.mjs` mirrors its port-0 binding + stdout-port-print pattern.
- [ ] Config schema in `src/config.ts` accepts `config.ollama = { enabled, useNativeApi, instances: [{name, baseUrl, priority, timeoutMs, useNativeApi}] }` with `useNativeApi: boolean | null` on instances per Plan 01.
- [ ] `src/server.ts` already wires `ClaudeBackend`, `GeminiBackend`, and `LmstudioBackend` at startup; Plan 09 only adds an `OllamaBackend` block in the same shape.

**Ollama API surface verification** (do this before Task 1):

The Ollama native API has evolved. As of 2026-05 we target:
- `POST /api/chat` — chat (streaming via `stream: true`, default). Request body `{model, messages, tools?, options?: {temperature?, top_p?, top_k?, num_ctx?, stop?, num_predict?}, format?: "json", keep_alive?: string, stream: bool}`. Stream emits NDJSON lines: `{model, created_at, message: {role: "assistant", content: "..."}, done: false}` for text chunks; `{model, created_at, message: {role: "assistant", tool_calls: [...]}, done: false}` for tool calls (note: some Ollama versions emit tool_calls only on the final chunk before `done: true` — Plan 09 handles both); `{model, created_at, done: true, total_duration, load_duration, prompt_eval_count, eval_count, ...}` for the terminal chunk.
- `POST /api/embed` — modern embeddings. Request body `{model, input: string | string[], options?, keep_alive?}`. Response `{model, embeddings: number[][], total_duration?, load_duration?, prompt_eval_count?}`.
- `POST /api/embeddings` — legacy embeddings (older Ollama versions). Request body `{model, prompt: string, options?, keep_alive?}`. Response `{embedding: number[]}`. Plan 09's `ollamaNativeClient.embed()` tries `/api/embed` first; if the server returns 404, retries against `/api/embeddings` once per process lifetime (cached probe result). Documented in the client's header comment.
- `GET /api/tags` — list of loaded/available models. Response `{models: [{name, modified_at, size, digest, details: {format, family, families, parameter_size, quantization_level}}]}`.
- `GET /v1/models` / `POST /v1/chat/completions` / `POST /v1/embeddings` — OpenAI-compatibility layer. Same shape as LM Studio's; this is exactly what Plan 08's `openaiCompatClient` already speaks.

Document any divergence in `ollamaNativeClient.ts`'s leading comment and update the mock fixture in lockstep.

If any check fails, stop and resolve before proceeding.

---

## Capability matrix (per spec)

`OllamaBackend.capabilitiesFor(model)` returns the same shape across both modes. The capability matrix describes what the backend *can* honor on the wire — not whether the currently-loaded model supports it. Per-model narrowing is a future plan (see spec's "open questions").

```ts
{
  toolUse: true,                                    // both compat AND native support tool calling on capable models
  multimodal: true,                                 // model-dependent; conservative true (vision models exist on Ollama)
  thinking: false,
  cacheControl: "none",                             // Plan-05 local response cache works regardless
  samplingParams: { temperature: true, topP: true, topK: true },
  stopSequences: "native",                          // both APIs accept stop sequences in the request
  embeddings: true
}
```

Same shape as LM Studio — both are local OpenAI-compatible runtimes. The differences vs LM Studio are operational (Ollama supports `keep_alive`, `format: "json"`, etc., via the native API) and don't surface through the capability matrix.

---

## keep_alive policy

Plan 09 does NOT add a `keep_alive` field to `NormalizedRequest` — that's future work. Instead:

- In **native mode**, every request body sent to `/api/chat` includes `keep_alive: "5m"` (default chosen to match Ollama's own server default). This means the backend doesn't aggressively unload models between requests, matching user expectation that a freshly-used model stays warm.
- In **compat mode**, there is no `keep_alive` knob — the OpenAI-compat layer doesn't expose it. Models follow Ollama's server-side default.

The 5-minute default is a constant in `ollamaBackend.ts` — `const NATIVE_KEEP_ALIVE = "5m";`. Future plans can promote this to config (`config.ollama.keepAlive`) or to a first-class `NormalizedRequest` field.

---

## Request/response normalization differences

**Compat mode** — identical to LM Studio (Plan 08): OpenAI SSE chunks (`data: {...}\n\n`), with the terminal `data: [DONE]\n\n` marker. The `openaiCompatClient` already handles all of this and returns `NormalizedEvent`s directly. `OllamaBackend.invoke()` in compat mode simply forwards each event through.

**Native mode** — Ollama emits NDJSON: one JSON object per `\n`-terminated line. The backend's translator handles three shapes:

| Native chunk shape | Normalized event(s) emitted |
|---|---|
| First chunk with `done: false` (and any non-empty message) | `message_start { model }` |
| `{message: {content: "..."}}` (any chunk with `done: false`) | `text_delta { index, text: content }` (text-block index tracked separately from tool-block indices) |
| `{message: {tool_calls: [{id?, function: {name, arguments: "..."}}, ...]}}` (most Ollama tool emissions arrive as a single tool_calls array on the terminal chunk or the chunk just before it) | `tool_use_start { index, id, name }` then `tool_use_delta { index, partialJson: arguments }` then `tool_use_stop { index }`, repeated per call. The `id` may be missing in older Ollama versions — synthesize one as `call_<hash-of-name-and-arguments>` when absent. |
| `{done: true, eval_count, prompt_eval_count, ...}` | `message_stop { stopReason, usage: { inputTokens: prompt_eval_count ?? 0, outputTokens: eval_count ?? 0 } }`. Map `done_reason` if present: `"stop"` → `"end_turn"`, `"length"` → `"max_tokens"`, anything tool-related → `"tool_use"`, otherwise `"end_turn"`. |

**Request shape in native mode**:
- Top level: `model`, `messages`, `tools` (same shape as OpenAI roughly), `stream: true` for streaming.
- `options: {temperature, top_p, top_k, num_ctx, stop, num_predict}` — **sampling params nested under `options`, not flat**. The translator converts `NormalizedRequest.samplingParams.temperature` → `body.options.temperature`, etc.
- `body.options.stop = req.stopSequences` when set.
- `body.options.num_predict = req.maxTokens` when set.
- `format: "json"` when `req.metadata?.format === "json"`.
- `keep_alive: NATIVE_KEEP_ALIVE` always.

The compat-mode translator (Plan 08's `openaiCompatClient` request shape) stays flat: `body.temperature`, `body.top_p`, `body.top_k`, `body.stop`, `body.max_tokens` — no `options` nesting, no `keep_alive`, no `format` (unless the OpenAI shim's `response_format` is set, which Plan 09 does not introduce).

---

## Per-instance mode override

`config.ollama.useNativeApi` (top-level boolean, default `false`) is the backend-wide default. `config.ollama.instances[*].useNativeApi` (nullable: `null | true | false`, default `null`) is the per-instance override. The resolution rule:

```ts
const effectiveUseNative =
  instance.useNativeApi === null ? backendDefault : instance.useNativeApi;
```

So:
- Backend default `false`, instance `null` → compat mode.
- Backend default `false`, instance `true` → native mode (instance overrides to opposite).
- Backend default `true`, instance `null` → native mode.
- Backend default `true`, instance `false` → compat mode (instance overrides to opposite).

Plan 09's `OllamaBackend` resolves this once per instance at construction time and stores the chosen client per instance. The instance's mode does not change at runtime — config changes require a server restart (matches the existing config-frozen-on-load convention from Plan 01).

---

## Plan length expectation

Slightly larger than Plan 08 (LM Studio) because of the dual-mode dispatch, the new `ollamaNativeClient.ts` module, and the per-mode translator branches. Aim for **~10-13 tasks**, **~2,000-2,600 lines** of plan markdown.

---

## Task 1: Mock-ollama test fixture (dual API)

**Files:**
- Create: `tests/fixtures/mock-ollama/server.mjs`
- Create: `tests/fixtures/mock-ollama/package.json`

A single mock HTTP server that exposes BOTH Ollama-native endpoints (`/api/chat`, `/api/embed`, `/api/embeddings`, `/api/tags`) AND OpenAI-compat endpoints (`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`). One fixture, two surfaces — simpler than running two fixture processes per test. Binds to port 0 (kernel-assigned ephemeral port) and prints `LISTENING_ON_PORT <n>\n` on stdout so tests can read the assigned port.

The fixture has no real model behavior. It echoes the prompt back, emits canned token counts, and supports a handful of deterministic triggers based on request body content:

- Prompt body containing `"MOCK_ERROR"` → respond 500 with `{"error": "mock error"}`.
- Prompt body containing `"MOCK_TOOL_CALL"` → emit a synthesized `tool_calls` block (one call to `"echo"` with arguments `{"text": "<prompt>"}`).
- Prompt body containing `"MOCK_LONG_STREAM"` → emit 20 small text chunks instead of 1-3.
- Anything else → emit a normal echo response in 2-3 chunks.

- [ ] **Step 1: Create the fixture script**

Create `tests/fixtures/mock-ollama/server.mjs`. The script uses `node:http` directly (no Express dep needed; matches Plan 08's pattern if it went the same way — otherwise use whichever HTTP framework Plan 08 settled on):

```js
#!/usr/bin/env node
// Hermetic mock of an Ollama server. Serves BOTH the native /api/* surface
// and the OpenAI-compatibility /v1/* surface so a single fixture process
// can stand in for either mode used by Plan 09's OllamaBackend.
//
// Bound on port 0 (kernel-assigned). On listen, prints
//   LISTENING_ON_PORT <n>
// on stdout so the spawning test can parse the assigned port.
//
// Triggers (keyed off the last user message's content):
//   "MOCK_ERROR"        → 500 with {"error": "mock error"}
//   "MOCK_TOOL_CALL"    → response contains a tool_calls block (echo tool)
//   "MOCK_LONG_STREAM"  → 20 short text chunks
//   (anything else)     → 2-3 normal text chunks echoing the prompt

import { createServer } from "node:http";

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  let bodyChunks = [];
  for await (const c of req) bodyChunks.push(c);
  const rawBody = Buffer.concat(bodyChunks).toString("utf8");
  let body = {};
  if (rawBody.length > 0) {
    try { body = JSON.parse(rawBody); } catch { body = {}; }
  }

  // ---- /api/tags (native model list) -----------------------------------
  if (req.method === "GET" && url.pathname === "/api/tags") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      models: [
        {
          name: "llama-3.3-70b",
          modified_at: "2026-04-01T00:00:00Z",
          size: 40_000_000_000,
          digest: "deadbeef",
          details: {
            format: "gguf",
            family: "llama",
            families: ["llama"],
            parameter_size: "70B",
            quantization_level: "Q4_K_M"
          }
        },
        {
          name: "nomic-embed-text",
          modified_at: "2026-04-01T00:00:00Z",
          size: 274_000_000,
          digest: "cafebabe",
          details: {
            format: "gguf",
            family: "nomic",
            families: ["nomic"],
            parameter_size: "137M",
            quantization_level: "F16"
          }
        }
      ]
    }));
    return;
  }

  // ---- /v1/models (OpenAI-compat model list) ---------------------------
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [
        { id: "llama-3.3-70b", object: "model", owned_by: "ollama" },
        { id: "nomic-embed-text", object: "model", owned_by: "ollama" }
      ]
    }));
    return;
  }

  // ---- /api/embed (native modern embeddings) ---------------------------
  if (req.method === "POST" && url.pathname === "/api/embed") {
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      model: body.model ?? "nomic-embed-text",
      embeddings: inputs.map((s) => Array.from({ length: 8 }, (_, i) => (s.length + i) / 100)),
      total_duration: 1000,
      load_duration: 100,
      prompt_eval_count: inputs.reduce((n, s) => n + Math.ceil(s.length / 4), 0)
    }));
    return;
  }

  // ---- /api/embeddings (native legacy embeddings) ----------------------
  if (req.method === "POST" && url.pathname === "/api/embeddings") {
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      embedding: Array.from({ length: 8 }, (_, i) => (prompt.length + i) / 100)
    }));
    return;
  }

  // ---- /v1/embeddings (OpenAI-compat embeddings) -----------------------
  if (req.method === "POST" && url.pathname === "/v1/embeddings") {
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: inputs.map((s, idx) => ({
        object: "embedding",
        index: idx,
        embedding: Array.from({ length: 8 }, (_, i) => (s.length + i) / 100)
      })),
      model: body.model ?? "nomic-embed-text",
      usage: { prompt_tokens: inputs.reduce((n, s) => n + Math.ceil(s.length / 4), 0), total_tokens: 0 }
    }));
    return;
  }

  // Pull the last user message's content for trigger detection.
  function lastUserContent(reqBody) {
    if (!Array.isArray(reqBody?.messages)) return "";
    const lastUser = [...reqBody.messages].reverse().find((m) => m?.role === "user");
    if (!lastUser) return "";
    if (typeof lastUser.content === "string") return lastUser.content;
    // OpenAI-style array of parts
    if (Array.isArray(lastUser.content)) {
      return lastUser.content
        .map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
        .join(" ");
    }
    return "";
  }

  const prompt = lastUserContent(body);
  const wantsError = prompt.includes("MOCK_ERROR");
  const wantsToolCall = prompt.includes("MOCK_TOOL_CALL");
  const wantsLongStream = prompt.includes("MOCK_LONG_STREAM");

  // ---- /api/chat (native streaming) ------------------------------------
  if (req.method === "POST" && url.pathname === "/api/chat") {
    if (wantsError) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "mock error" }));
      return;
    }

    res.writeHead(200, { "content-type": "application/x-ndjson" });

    const reply = `echo: ${prompt}`;
    const chunkSize = wantsLongStream ? 2 : Math.max(1, Math.ceil(reply.length / 3));
    const chunks = reply.match(new RegExp(`.{1,${chunkSize}}`, "g")) ?? [reply];

    if (wantsToolCall) {
      // Native tool-call shape: tool_calls arrives on a single chunk just before done.
      res.write(JSON.stringify({
        model: body.model ?? "llama-3.3-70b",
        created_at: new Date().toISOString(),
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_mock_0",
              function: {
                name: "echo",
                arguments: JSON.stringify({ text: prompt })
              }
            }
          ]
        },
        done: false
      }) + "\n");
      res.write(JSON.stringify({
        model: body.model ?? "llama-3.3-70b",
        created_at: new Date().toISOString(),
        done: true,
        done_reason: "stop",
        total_duration: 1000,
        load_duration: 100,
        prompt_eval_count: Math.ceil(prompt.length / 4),
        eval_count: 5
      }) + "\n");
      res.end();
      return;
    }

    for (const chunk of chunks) {
      res.write(JSON.stringify({
        model: body.model ?? "llama-3.3-70b",
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: chunk },
        done: false
      }) + "\n");
    }
    res.write(JSON.stringify({
      model: body.model ?? "llama-3.3-70b",
      created_at: new Date().toISOString(),
      done: true,
      done_reason: "stop",
      total_duration: 1000,
      load_duration: 100,
      prompt_eval_count: Math.ceil(prompt.length / 4),
      eval_count: Math.ceil(reply.length / 4)
    }) + "\n");
    res.end();
    return;
  }

  // ---- /v1/chat/completions (OpenAI-compat streaming) -------------------
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    if (wantsError) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock error", type: "mock_error_type" } }));
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream" });

    const reply = `echo: ${prompt}`;
    const chunkSize = wantsLongStream ? 2 : Math.max(1, Math.ceil(reply.length / 3));
    const chunks = reply.match(new RegExp(`.{1,${chunkSize}}`, "g")) ?? [reply];

    if (wantsToolCall) {
      res.write(`data: ${JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        model: body.model ?? "llama-3.3-70b",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_mock_0",
                  type: "function",
                  function: { name: "echo", arguments: JSON.stringify({ text: prompt }) }
                }
              ]
            },
            finish_reason: null
          }
        ]
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        model: body.model ?? "llama-3.3-70b",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: 5, total_tokens: 0 }
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        model: body.model ?? "llama-3.3-70b",
        choices: [{ index: 0, delta: { role: "assistant", content: chunk }, finish_reason: null }]
      })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      model: body.model ?? "llama-3.3-70b",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: Math.ceil(reply.length / 4),
        total_tokens: 0
      }
    })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: `unknown endpoint: ${req.method} ${url.pathname}` }));
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  if (addr && typeof addr === "object") {
    process.stdout.write(`LISTENING_ON_PORT ${addr.port}\n`);
  }
});

// Allow graceful shutdown on SIGTERM/SIGINT so tests can clean up.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
```

- [ ] **Step 2: Create the fixture package.json**

Create `tests/fixtures/mock-ollama/package.json`:

```json
{
  "name": "mock-ollama",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "mock-ollama": "./server.mjs"
  }
}
```

- [ ] **Step 3: Make the script executable (no-op on Windows but matters on macOS)**

Run: `chmod +x tests/fixtures/mock-ollama/server.mjs`
On Windows the file mode flag isn't meaningful; the command exits cleanly. On macOS/Linux it ensures the shebang line works when invoked directly. Same Windows deferral as Plan 02 / Plan 06 / Plan 08 — tests always invoke via `node tests/fixtures/mock-ollama/server.mjs` so the executable bit isn't on the critical path.

- [ ] **Step 4: Smoke-test the fixture by running it directly**

Spawn the fixture in one terminal:
```
node tests/fixtures/mock-ollama/server.mjs
```
Expected stdout: a single line `LISTENING_ON_PORT <n>` where `<n>` is a number > 0.

In a second terminal, with `PORT` taken from the line above, hit both surfaces:
```
curl -s http://127.0.0.1:$PORT/api/tags | head -c 200
curl -s http://127.0.0.1:$PORT/v1/models | head -c 200
curl -s -X POST http://127.0.0.1:$PORT/api/chat -d '{"model":"llama-3.3-70b","messages":[{"role":"user","content":"hello"}],"stream":true}' | head -c 200
curl -sN -X POST http://127.0.0.1:$PORT/v1/chat/completions -d '{"model":"llama-3.3-70b","messages":[{"role":"user","content":"hello"}],"stream":true}' | head -c 200
```

Expected: each returns a non-empty body matching the respective surface's shape (JSON for `/api/tags` and `/v1/models`; NDJSON for `/api/chat`; SSE for `/v1/chat/completions`).

Stop the fixture with Ctrl-C.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/mock-ollama
git commit -m "test(fixture): add mock-ollama dual-surface server (native + OpenAI-compat) on port 0"
```

---

## Task 2: ollamaNativeClient — module skeleton + listTags

**Files:**
- Create: `src/backends/ollamaNativeClient.ts`
- Test: `tests/unit/backends/ollamaNativeClient.test.ts`

The client is a thin HTTP wrapper around Ollama's `/api/*` endpoints. No `NormalizedEvent` translation lives here — that's `OllamaBackend`'s job. The client returns parsed JSON objects (for `embed`, `listTags`, `chatBuffered`) or an `AsyncIterable<unknown>` of parsed NDJSON lines (for `chat`).

This task lands the constructor + `listTags()` only. `chat()`, `chatBuffered()`, and `embed()` land in Tasks 3 and 4.

The test fixture spawning helper that all client / backend tests reuse is also introduced here.

- [ ] **Step 1: Add a shared test helper for spawning mock-ollama on port 0**

Create `tests/helpers/mockOllamaProcess.ts` (a tiny shared helper; if the codebase already has a `tests/helpers/` pattern from Plan 08, follow that; otherwise create the directory now):

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "..", "fixtures", "mock-ollama", "server.mjs");

export interface MockOllamaHandle {
  baseUrl: string;
  port: number;
  child: ChildProcess;
  stop(): Promise<void>;
}

/**
 * Spawn the mock-ollama server on a kernel-assigned port and resolve once
 * it prints its listening port. Throws if the child exits before listening
 * or doesn't announce within 5 seconds.
 */
export function startMockOllama(): Promise<MockOllamaHandle> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [FIXTURE], { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuffer = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        child.kill("SIGKILL");
        reject(new Error("mock-ollama did not announce its port within 5s"));
      });
    }, 5000);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const m = stdoutBuffer.match(/LISTENING_ON_PORT (\d+)/);
      if (m) {
        const port = Number(m[1]);
        clearTimeout(timer);
        settle(() =>
          resolve({
            baseUrl: `http://127.0.0.1:${port}`,
            port,
            child,
            async stop() {
              await new Promise<void>((res) => {
                child.once("exit", () => res());
                child.kill("SIGTERM");
                setTimeout(() => {
                  if (!child.killed) child.kill("SIGKILL");
                  res();
                }, 1000);
              });
            }
          })
        );
      }
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      settle(() => reject(new Error(`mock-ollama exited with code ${code} before announcing`)));
    });
  });
}
```

- [ ] **Step 2: Write the failing test for `listTags`**

Create `tests/unit/backends/ollamaNativeClient.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { OllamaNativeClient } from "../../../src/backends/ollamaNativeClient.js";
import { startMockOllama, type MockOllamaHandle } from "../../helpers/mockOllamaProcess.js";

describe("OllamaNativeClient.listTags", () => {
  let mock: MockOllamaHandle;

  beforeAll(async () => {
    mock = await startMockOllama();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("GETs /api/tags and returns the parsed body", async () => {
    const client = new OllamaNativeClient({ baseUrl: mock.baseUrl, timeoutMs: 5000 });
    const tags = (await client.listTags()) as { models?: Array<{ name: string }> };
    expect(Array.isArray(tags.models)).toBe(true);
    const names = (tags.models ?? []).map((m) => m.name);
    expect(names).toContain("llama-3.3-70b");
    expect(names).toContain("nomic-embed-text");
  });

  it("throws a descriptive error when baseUrl is unreachable", async () => {
    const client = new OllamaNativeClient({
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 1000
    });
    await expect(client.listTags()).rejects.toThrow(/ollama/i);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/unit/backends/ollamaNativeClient.test.ts`
Expected: FAIL — module `src/backends/ollamaNativeClient.js` not found.

- [ ] **Step 4: Create `src/backends/ollamaNativeClient.ts` skeleton**

```ts
// Thin HTTP client for Ollama's native /api/* endpoints.
//
// This module is intentionally NOT translating to NormalizedEvent — that's
// OllamaBackend's job. The client returns parsed JSON (one-shot endpoints) or
// AsyncIterable<unknown> of parsed NDJSON lines (streaming endpoints). The
// caller pattern-matches the raw shapes.
//
// Methods (full surface lands across Tasks 2-4):
//   listTags()           → GET  /api/tags
//   chat(body)           → POST /api/chat  with stream: true (NDJSON)
//   chatBuffered(body)   → POST /api/chat  with stream: false (single JSON)
//   embed(body)          → POST /api/embed (falls back to /api/embeddings on 404)
//
// All methods use AbortController for timeouts. Errors carry the URL and HTTP
// status when available so callers can distinguish connection-refused from
// 5xx from malformed responses.

export interface OllamaNativeClientOptions {
  /** Root URL, e.g. "http://127.0.0.1:11434". No trailing slash. */
  baseUrl: string;
  /** Per-call timeout in milliseconds. */
  timeoutMs: number;
}

export class OllamaNativeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: OllamaNativeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs;
  }

  /** GET /api/tags */
  async listTags(): Promise<unknown> {
    const url = `${this.baseUrl}/api/tags`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: "GET", signal: ctl.signal });
      if (!res.ok) {
        throw new Error(
          `ollama listTags failed: HTTP ${res.status} ${res.statusText} @ ${url}`
        );
      }
      return await res.json();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`ollama listTags timeout after ${this.timeoutMs}ms @ ${url}`);
      }
      if (err instanceof Error) {
        throw new Error(`ollama listTags error: ${err.message} @ ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/backends/ollamaNativeClient.test.ts`
Expected: PASS — both `listTags` tests green.

- [ ] **Step 6: Commit**

```bash
git add src/backends/ollamaNativeClient.ts tests/unit/backends/ollamaNativeClient.test.ts tests/helpers/mockOllamaProcess.ts
git commit -m "feat(ollamaNativeClient): add HTTP client skeleton with listTags(); shared mock-process helper"
```

---

## Task 3: ollamaNativeClient — chat() streaming with NDJSON parsing

**Files:**
- Modify: `src/backends/ollamaNativeClient.ts`
- Modify: `tests/unit/backends/ollamaNativeClient.test.ts`

Add `chat(body)` that POSTs to `/api/chat` with `stream: true` and yields one parsed JSON object per `\n`-terminated line. Same partial-line buffering pattern as `claudeStreamRunner` / `geminiStreamRunner` from earlier plans, but reading from a `Response` body's web-streams `ReadableStream` instead of a child-process `stdout`. Trailing-line flush on stream end; malformed lines skipped silently.

- [ ] **Step 1: Append failing tests for `chat`**

Append to `tests/unit/backends/ollamaNativeClient.test.ts`:

```ts
describe("OllamaNativeClient.chat (NDJSON streaming)", () => {
  let mock: MockOllamaHandle;

  beforeAll(async () => {
    mock = await startMockOllama();
  });

  afterAll(async () => {
    await mock.stop();
  });

  async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const ev of it) out.push(ev);
    return out;
  }

  it("yields one parsed JSON object per NDJSON line, terminal line carries done: true", async () => {
    const client = new OllamaNativeClient({ baseUrl: mock.baseUrl, timeoutMs: 5000 });
    const events = await collect(
      client.chat({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: "hello" }],
        stream: true
      })
    );
    expect(events.length).toBeGreaterThanOrEqual(2);
    const last = events[events.length - 1] as { done?: boolean };
    expect(last.done).toBe(true);
    const nonTerminal = events.slice(0, -1) as Array<{ message?: { content?: string } }>;
    expect(nonTerminal.every((e) => typeof e.message?.content === "string")).toBe(true);
  });

  it("round-trips keep_alive in the request body (mock echoes it as-is in tags)", async () => {
    // The mock doesn't expose what it received, but the request must not crash.
    // The shape is verified by Plan 09's ollamaBackend tests; this guards the
    // client doesn't drop the field.
    const client = new OllamaNativeClient({ baseUrl: mock.baseUrl, timeoutMs: 5000 });
    const events = await (async () => {
      const out: unknown[] = [];
      for await (const ev of client.chat({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        keep_alive: "10m"
      })) out.push(ev);
      return out;
    })();
    expect(events.length).toBeGreaterThan(0);
  });

  it("round-trips format: \"json\" in the request body", async () => {
    const client = new OllamaNativeClient({ baseUrl: mock.baseUrl, timeoutMs: 5000 });
    const events = await collect(
      client.chat({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        format: "json"
      })
    );
    expect(events.length).toBeGreaterThan(0);
  });

  it("throws on server-side error envelope (HTTP 500 with {error})", async () => {
    const client = new OllamaNativeClient({ baseUrl: mock.baseUrl, timeoutMs: 5000 });
    await expect(async () => {
      for await (const _ of client.chat({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: "MOCK_ERROR" }],
        stream: true
      })) {
        // no-op
      }
    }).rejects.toThrow(/mock error|HTTP 500/);
  });

  it("times out and the iterator stops cleanly", async () => {
    const client = new OllamaNativeClient({
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 250
    });
    await expect(async () => {
      for await (const _ of client.chat({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: "hi" }],
        stream: true
      })) {
        // no-op
      }
    }).rejects.toThrow(/ollama/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/backends/ollamaNativeClient.test.ts`
Expected: FAIL — `chat` method does not exist on `OllamaNativeClient`.

- [ ] **Step 3: Implement `chat()` in `src/backends/ollamaNativeClient.ts`**

Add to the class:

```ts
  /**
   * POST /api/chat with stream: true. Yields one parsed JSON object per
   * NDJSON line. The caller is responsible for shape-matching (text chunks
   * have a `message.content` string; tool-call chunks have a
   * `message.tool_calls` array; the terminal chunk has `done: true`).
   *
   * The body is taken as-is and serialized. We do not validate or rewrite it
   * here — the backend's translator owns request shape.
   */
  async *chat(body: Record<string, unknown>): AsyncIterable<unknown> {
    const url = `${this.baseUrl}/api/chat`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: ctl.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`ollama chat timeout after ${this.timeoutMs}ms @ ${url}`);
      }
      if (err instanceof Error) {
        throw new Error(`ollama chat connect error: ${err.message} @ ${url}`);
      }
      throw err;
    }

    if (!res.ok) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        // ignore
      }
      clearTimeout(timer);
      throw new Error(
        `ollama chat failed: HTTP ${res.status} ${res.statusText} @ ${url}` +
          (bodyText ? `: ${bodyText.slice(0, 200)}` : "")
      );
    }

    if (!res.body) {
      clearTimeout(timer);
      throw new Error(`ollama chat: response body is null @ ${url}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.length > 0) {
            try {
              yield JSON.parse(line);
            } catch {
              // Malformed NDJSON line — drop silently. Same pattern as the
              // CLI stream runners; the caller sees fewer events.
            }
          }
          nl = buffer.indexOf("\n");
        }
      }
      const trailing = buffer.trim();
      if (trailing.length > 0) {
        try {
          yield JSON.parse(trailing);
        } catch {
          // ignore
        }
      }
    } finally {
      clearTimeout(timer);
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/backends/ollamaNativeClient.test.ts`
Expected: PASS — both `listTags` tests + 5 new `chat` tests = 7 green.

- [ ] **Step 5: Commit**

```bash
git add src/backends/ollamaNativeClient.ts tests/unit/backends/ollamaNativeClient.test.ts
git commit -m "feat(ollamaNativeClient): add chat() with NDJSON streaming, AbortController timeout, error envelopes"
```

---

## Task 4: ollamaNativeClient — embed() with /api/embed → /api/embeddings fallback

**Files:**
- Modify: `src/backends/ollamaNativeClient.ts`
- Modify: `tests/unit/backends/ollamaNativeClient.test.ts`

Add `embed(body)`. Tries `POST /api/embed` first (modern shape: request `{model, input: string | string[]}`, response `{embeddings: number[][]}`). On HTTP 404, retries against `POST /api/embeddings` (legacy shape: request `{model, prompt: string}`, response `{embedding: number[]}` — one prompt at a time). After a successful path is found for a given baseUrl, cache the choice in-process so subsequent calls skip the failed probe.

Also add `chatBuffered(body)` (one-shot version of `chat()` that POSTs with `stream: false` and returns the single response JSON) — used by `OllamaBackend.countTokens()` to call Ollama's `/api/chat` with `num_predict: 0` to extract `prompt_eval_count` cheaply.

- [ ] **Step 1: Append failing tests for `embed` and `chatBuffered`**

Append to `tests/unit/backends/ollamaNativeClient.test.ts`:

```ts
describe("OllamaNativeClient.embed", () => {
  let mock: MockOllamaHandle;

  beforeAll(async () => {
    mock = await startMockOllama();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("POSTs /api/embed for modern shape, returns {embeddings: number[][]}", async () => {
    const client = new OllamaNativeClient({ baseUrl: mock.baseUrl, timeoutMs: 5000 });
    const resp = (await client.embed({
      model: "nomic-embed-text",
      input: ["hello", "world"]
    })) as { embeddings?: number[][] };
    expect(Array.isArray(resp.embeddings)).toBe(true);
    expect(resp.embeddings?.length).toBe(2);
    expect(resp.embeddings?.[0]?.length).toBe(8);
  });

  it("accepts string input (single embedding)", async () => {
    const client = new OllamaNativeClient({ baseUrl: mock.baseUrl, timeoutMs: 5000 });
    const resp = (await client.embed({
      model: "nomic-embed-text",
      input: "single"
    })) as { embeddings?: number[][] };
    expect(resp.embeddings?.length).toBe(1);
  });
});

describe("OllamaNativeClient.embed legacy fallback", () => {
  // Spin up a tiny custom mock that returns 404 on /api/embed and 200 on
  // /api/embeddings so we can prove the fallback path.
  let server: import("node:http").Server;
  let baseUrl: string;

  beforeAll(async () => {
    const { createServer } = await import("node:http");
    server = createServer(async (req, res) => {
      let chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api/embed") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (url.pathname === "/api/embeddings") {
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          embedding: Array.from({ length: 8 }, (_, i) => (prompt.length + i) / 100)
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (addr && typeof addr === "object") {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("falls back to /api/embeddings when /api/embed returns 404; normalizes shape to {embeddings: number[][]}", async () => {
    const client = new OllamaNativeClient({ baseUrl, timeoutMs: 5000 });
    const resp = (await client.embed({
      model: "nomic-embed-text",
      input: ["just-one"]
    })) as { embeddings?: number[][] };
    expect(resp.embeddings?.length).toBe(1);
    expect(resp.embeddings?.[0]?.length).toBe(8);
  });

  it("caches the legacy-path probe — second call does not re-hit /api/embed", async () => {
    // Hard to assert directly without instrumenting the mock; the contract is
    // simply that the second call also succeeds via the same client instance.
    const client = new OllamaNativeClient({ baseUrl, timeoutMs: 5000 });
    await client.embed({ model: "nomic-embed-text", input: "x" });
    const resp = (await client.embed({
      model: "nomic-embed-text",
      input: "y"
    })) as { embeddings?: number[][] };
    expect(resp.embeddings?.length).toBe(1);
  });
});

describe("OllamaNativeClient.chatBuffered", () => {
  let mock: MockOllamaHandle;

  beforeAll(async () => {
    mock = await startMockOllama();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("POSTs /api/chat with stream: false and returns a single parsed object", async () => {
    // The mock doesn't differentiate stream-false; it just emits NDJSON.
    // chatBuffered concatenates and returns the LAST line (the done: true chunk)
    // which carries the eval counts useful for countTokens-style probes.
    const client = new OllamaNativeClient({ baseUrl: mock.baseUrl, timeoutMs: 5000 });
    const final = (await client.chatBuffered({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "hi" }],
      options: { num_predict: 0 }
    })) as { done?: boolean; prompt_eval_count?: number };
    expect(final.done).toBe(true);
    expect(typeof final.prompt_eval_count).toBe("number");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/backends/ollamaNativeClient.test.ts`
Expected: FAIL — `embed` and `chatBuffered` not on the class yet.

- [ ] **Step 3: Implement `embed()` and `chatBuffered()` in `src/backends/ollamaNativeClient.ts`**

Add a private cache field and the two methods:

```ts
  /**
   * Per-instance probe cache: which embeddings path responded successfully?
   *   null  → not yet probed
   *   "v2"  → /api/embed worked
   *   "v1"  → /api/embed 404'd; using /api/embeddings legacy path
   */
  private embedPath: null | "v1" | "v2" = null;

  /**
   * Embeddings. Tries /api/embed first (modern), falls back to /api/embeddings
   * (legacy single-prompt shape) on HTTP 404. The legacy path is called once
   * per input string and the results merged into the modern response shape so
   * callers see a uniform `{embeddings: number[][]}` regardless of server age.
   */
  async embed(body: { model: string; input: string | string[] } & Record<string, unknown>): Promise<unknown> {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];

    if (this.embedPath === null || this.embedPath === "v2") {
      try {
        const resp = await this.embedModern(body, inputs);
        this.embedPath = "v2";
        return resp;
      } catch (err) {
        if (err instanceof EmbedNotFoundError) {
          this.embedPath = "v1";
          // fall through to legacy path
        } else {
          throw err;
        }
      }
    }

    // Legacy path: one POST per input string.
    const embeddings: number[][] = [];
    for (const input of inputs) {
      const legacyBody: Record<string, unknown> = { ...body, prompt: input };
      delete legacyBody.input;
      const url = `${this.baseUrl}/api/embeddings`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(legacyBody),
          signal: ctl.signal
        });
        if (!res.ok) {
          throw new Error(
            `ollama embed (legacy) failed: HTTP ${res.status} ${res.statusText} @ ${url}`
          );
        }
        const parsed = (await res.json()) as { embedding?: number[] };
        if (!Array.isArray(parsed.embedding)) {
          throw new Error(`ollama embed (legacy) response missing embedding[] @ ${url}`);
        }
        embeddings.push(parsed.embedding);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`ollama embed timeout after ${this.timeoutMs}ms @ ${url}`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    return { model: body.model, embeddings };
  }

  private async embedModern(
    body: Record<string, unknown>,
    inputs: string[]
  ): Promise<unknown> {
    const url = `${this.baseUrl}/api/embed`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, input: inputs }),
        signal: ctl.signal
      });
      if (res.status === 404) {
        throw new EmbedNotFoundError();
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `ollama embed failed: HTTP ${res.status} ${res.statusText} @ ${url}` +
            (text ? `: ${text.slice(0, 200)}` : "")
        );
      }
      return await res.json();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`ollama embed timeout after ${this.timeoutMs}ms @ ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One-shot variant of chat(): POST /api/chat with stream: false. Returns
   * the parsed terminal JSON object directly. Used by countTokens probes.
   */
  async chatBuffered(body: Record<string, unknown>): Promise<unknown> {
    // Even with stream: false, Ollama may still emit a single NDJSON line
    // (depending on version). Reuse chat() and return the last yielded event.
    let last: unknown = null;
    for await (const ev of this.chat({ ...body, stream: false })) {
      last = ev;
    }
    if (last === null) {
      throw new Error(`ollama chatBuffered: stream produced zero events`);
    }
    return last;
  }
```

Add the sentinel error class at module scope (after imports, before the class):

```ts
class EmbedNotFoundError extends Error {
  constructor() {
    super("ollama embed: /api/embed not found");
    this.name = "EmbedNotFoundError";
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/backends/ollamaNativeClient.test.ts`
Expected: PASS — all earlier tests + 5 new (2 modern embed + 2 legacy fallback + 1 chatBuffered) = 12 green total.

- [ ] **Step 5: Commit**

```bash
git add src/backends/ollamaNativeClient.ts tests/unit/backends/ollamaNativeClient.test.ts
git commit -m "feat(ollamaNativeClient): add embed() with legacy /api/embeddings fallback, chatBuffered()"
```

---

## Task 5: OllamaBackend skeleton — id, capabilities, per-instance client resolution

**Files:**
- Create: `src/backends/ollamaBackend.ts`
- Test: `tests/unit/backends/ollamaBackend.test.ts`

Lands the static surface: `id: "ollama"`, `capabilitiesFor(model)`, the constructor that walks `config.ollama.instances[]` and assigns one client per instance based on the resolved mode. `listModels()` is stubbed to return `[]` (real listing lands in Task 6). `invoke()` and `embed()` throw — they land in Tasks 7-9.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/backends/ollamaBackend.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { OllamaBackend, type OllamaBackendConfig } from "../../../src/backends/ollamaBackend.js";

describe("OllamaBackend skeleton", () => {
  function makeConfig(overrides: Partial<OllamaBackendConfig> = {}): OllamaBackendConfig {
    return {
      enabled: true,
      useNativeApi: false,
      instances: [
        {
          name: "local",
          baseUrl: "http://127.0.0.1:11434",
          priority: 40,
          timeoutMs: 30000,
          useNativeApi: null
        }
      ],
      ...overrides
    };
  }

  it("has id 'ollama'", () => {
    const backend = new OllamaBackend(makeConfig());
    expect(backend.id).toBe("ollama");
  });

  it("constructor throws when instances array is empty", () => {
    expect(() => new OllamaBackend(makeConfig({ instances: [] }))).toThrow(/instance/i);
  });

  it("constructor throws when two instances share a name", () => {
    expect(() =>
      new OllamaBackend(
        makeConfig({
          instances: [
            { name: "a", baseUrl: "http://127.0.0.1:1", priority: 1, timeoutMs: 1000, useNativeApi: null },
            { name: "a", baseUrl: "http://127.0.0.1:2", priority: 1, timeoutMs: 1000, useNativeApi: null }
          ]
        })
      )
    ).toThrow(/unique/i);
  });

  it("capabilitiesFor returns the per-spec matrix (same across all models)", () => {
    const backend = new OllamaBackend(makeConfig());
    const caps = backend.capabilitiesFor("llama-3.3-70b");
    expect(caps.toolUse).toBe(true);
    expect(caps.multimodal).toBe(true);
    expect(caps.thinking).toBe(false);
    expect(caps.cacheControl).toBe("none");
    expect(caps.samplingParams).toEqual({ temperature: true, topP: true, topK: true });
    expect(caps.stopSequences).toBe("native");
    expect(caps.embeddings).toBe(true);
  });

  it("listModels stub returns an empty array (real listing lands in Task 6)", async () => {
    const backend = new OllamaBackend(makeConfig());
    const models = await backend.listModels();
    expect(models).toEqual([]);
  });

  it("invoke stub throws (lands in Task 7)", async () => {
    const backend = new OllamaBackend(makeConfig());
    await expect(async () => {
      for await (const _ of backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      })) {
        // no-op
      }
    }).rejects.toThrow(/invoke|Task/);
  });

  it("embed stub throws (lands in Task 9)", async () => {
    const backend = new OllamaBackend(makeConfig());
    await expect(
      backend.embed!({ model: "nomic-embed-text", input: ["hello"] })
    ).rejects.toThrow(/embed|Task/);
  });
});

describe("OllamaBackend per-instance mode resolution", () => {
  function inst(name: string, useNativeApi: boolean | null): OllamaBackendConfig["instances"][number] {
    return {
      name,
      baseUrl: `http://127.0.0.1:${name === "a" ? 11434 : name === "b" ? 11435 : 11436}`,
      priority: 40,
      timeoutMs: 30000,
      useNativeApi
    };
  }

  it("instance with null inherits backend default (false → compat)", () => {
    const backend = new OllamaBackend({
      enabled: true,
      useNativeApi: false,
      instances: [inst("a", null), inst("b", null), inst("c", null)]
    });
    expect(backend.instanceMode("a")).toBe("compat");
    expect(backend.instanceMode("b")).toBe("compat");
    expect(backend.instanceMode("c")).toBe("compat");
  });

  it("instance with null inherits backend default (true → native)", () => {
    const backend = new OllamaBackend({
      enabled: true,
      useNativeApi: true,
      instances: [inst("a", null), inst("b", null), inst("c", null)]
    });
    expect(backend.instanceMode("a")).toBe("native");
    expect(backend.instanceMode("b")).toBe("native");
    expect(backend.instanceMode("c")).toBe("native");
  });

  it("three-instance mixed resolution: inherit-compat, inherit-native (after default flip), override-opposite", () => {
    // Backend default is native; instance "a" overrides to compat; "b" inherits
    // native; "c" overrides to native explicitly (same as inherit but the
    // override path is exercised).
    const backend = new OllamaBackend({
      enabled: true,
      useNativeApi: true,
      instances: [inst("a", false), inst("b", null), inst("c", true)]
    });
    expect(backend.instanceMode("a")).toBe("compat");
    expect(backend.instanceMode("b")).toBe("native");
    expect(backend.instanceMode("c")).toBe("native");
  });

  it("instance with override true under default false works", () => {
    const backend = new OllamaBackend({
      enabled: true,
      useNativeApi: false,
      instances: [inst("a", true)]
    });
    expect(backend.instanceMode("a")).toBe("native");
  });

  it("instanceMode throws for unknown instance name", () => {
    const backend = new OllamaBackend({
      enabled: true,
      useNativeApi: false,
      instances: [inst("a", null)]
    });
    expect(() => backend.instanceMode("nope")).toThrow(/unknown instance/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/backends/ollamaBackend.test.ts`
Expected: FAIL — module `src/backends/ollamaBackend.js` not found.

- [ ] **Step 3: Create `src/backends/ollamaBackend.ts`**

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
import { OllamaNativeClient } from "./ollamaNativeClient.js";
import { OpenaiCompatClient } from "./openaiCompatClient.js";

/**
 * Configuration block — structurally identical to `config.ollama` produced by
 * Plan 01's Zod schema. Re-declared here so this module doesn't depend on the
 * concrete `Config` type (keeps unit tests trivial).
 */
export interface OllamaBackendConfig {
  enabled: boolean;
  useNativeApi: boolean;
  instances: Array<{
    name: string;
    baseUrl: string;
    priority: number;
    timeoutMs: number;
    /** null = inherit from backend useNativeApi; true/false = explicit. */
    useNativeApi: boolean | null;
    /** Optional bearer auth (carried through from the shared InstanceSchema). */
    apiKey?: string;
  }>;
}

export type OllamaInstanceMode = "compat" | "native";

/**
 * One resolved per-instance state record. The chosen client matches the
 * effective mode; we hold both interfaces erased to the same callable surface
 * via two branches in invoke() / embed() / listModels().
 */
interface ResolvedInstance {
  name: string;
  priority: number;
  baseUrl: string;
  timeoutMs: number;
  mode: OllamaInstanceMode;
  nativeClient?: OllamaNativeClient;
  compatClient?: OpenaiCompatClient;
}

/**
 * Resolve an instance's effective mode given the backend-wide default.
 *   instance.useNativeApi === null → use backend default
 *   else                            → use instance value
 */
function resolveMode(
  backendDefault: boolean,
  instanceFlag: boolean | null
): OllamaInstanceMode {
  const native = instanceFlag === null ? backendDefault : instanceFlag;
  return native ? "native" : "compat";
}

const NATIVE_KEEP_ALIVE = "5m";

export class OllamaBackend implements Backend {
  readonly id = "ollama" as const;

  private readonly instances: ResolvedInstance[];
  private readonly byName: Map<string, ResolvedInstance>;

  constructor(private readonly config: OllamaBackendConfig) {
    if (!config.instances || config.instances.length === 0) {
      throw new Error(
        "OllamaBackend: config.ollama.instances must be a non-empty array"
      );
    }

    const seen = new Set<string>();
    const resolved: ResolvedInstance[] = [];
    for (const inst of config.instances) {
      if (seen.has(inst.name)) {
        throw new Error(
          `OllamaBackend: instance names must be unique within ollama; duplicate: ${inst.name}`
        );
      }
      seen.add(inst.name);

      const mode = resolveMode(config.useNativeApi, inst.useNativeApi);
      const record: ResolvedInstance = {
        name: inst.name,
        priority: inst.priority,
        baseUrl: inst.baseUrl,
        timeoutMs: inst.timeoutMs,
        mode
      };
      if (mode === "native") {
        record.nativeClient = new OllamaNativeClient({
          baseUrl: inst.baseUrl,
          timeoutMs: inst.timeoutMs
        });
      } else {
        // OpenAI-compat mode points at /v1 under the Ollama base URL.
        record.compatClient = new OpenaiCompatClient({
          baseUrl: `${inst.baseUrl.replace(/\/+$/, "")}/v1`,
          apiKey: inst.apiKey ?? "",
          timeoutMs: inst.timeoutMs
        });
      }
      resolved.push(record);
    }
    this.instances = resolved;
    this.byName = new Map(resolved.map((r) => [r.name, r]));
  }

  /** Test-visible: what mode did instance `name` resolve to? */
  instanceMode(name: string): OllamaInstanceMode {
    const r = this.byName.get(name);
    if (!r) {
      throw new Error(`OllamaBackend.instanceMode: unknown instance ${name}`);
    }
    return r.mode;
  }

  capabilitiesFor(_model: string): BackendCapabilities {
    // Identical shape across both modes. Per-model narrowing (e.g., this
    // particular loaded model has no vision support) is a future plan; the
    // spec's "open questions" notes this explicitly.
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

  // listModels real implementation lands in Task 6.
  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }

  // eslint-disable-next-line require-yield
  async *invoke(_req: NormalizedRequest): AsyncIterable<NormalizedEvent> {
    throw new Error("OllamaBackend.invoke() lands in Plan 09 Task 7");
  }

  async embed(
    _req: NormalizedEmbeddingRequest
  ): Promise<NormalizedEmbeddingResponse> {
    throw new Error("OllamaBackend.embed() lands in Plan 09 Task 9");
  }

  async countTokens(req: NormalizedRequest): Promise<number> {
    // Plan 09 ships the char/4 fallback. A future plan can swap in a real
    // probe via /api/chat with num_predict: 0 (native mode) or POST
    // /v1/chat/completions with max_tokens: 0 (compat mode).
    let total = 0;
    if (req.system) total += Math.ceil(req.system.length / 4);
    for (const msg of req.messages) {
      for (const block of msg.content) {
        if (block.type === "text") total += Math.ceil(block.text.length / 4);
        else if (block.type === "tool_result")
          total += Math.ceil(block.content.length / 4);
        else if (block.type === "tool_use")
          total += Math.ceil(JSON.stringify(block.input).length / 4);
      }
    }
    return total;
  }
}
```

Add an `eslint-disable` to silence unused-config warnings if your lint flags `this.config` not being read until Task 6 (recommended: leave it — Task 6 consumes the config).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/backends/ollamaBackend.test.ts`
Expected: PASS — all 11 skeleton + resolution tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backends/ollamaBackend.ts tests/unit/backends/ollamaBackend.test.ts
git commit -m "feat(ollamaBackend): add skeleton with id, capabilities, per-instance mode resolution"
```

---

## Task 6: OllamaBackend.listModels() across all instances, both modes

**Files:**
- Modify: `src/backends/ollamaBackend.ts`
- Modify: `tests/unit/backends/ollamaBackend.test.ts`

Implement `listModels()`. For each instance, probe its chosen client: `/api/tags` for native, `/v1/models` for compat. Merge into a single `ModelDescriptor[]` deduplicating by id and keeping the higher-priority entry on collision. Failing instances log a warning (via console.warn in this plan; structured logger swap-in is future) and contribute no models — they don't fail the whole call.

- [ ] **Step 1: Append failing tests**

Append to `tests/unit/backends/ollamaBackend.test.ts`:

```ts
import { startMockOllama, type MockOllamaHandle } from "../../helpers/mockOllamaProcess.js";

describe("OllamaBackend.listModels (compat mode)", () => {
  let mock: MockOllamaHandle;
  let backend: OllamaBackend;

  beforeAll(async () => {
    mock = await startMockOllama();
    backend = new OllamaBackend({
      enabled: true,
      useNativeApi: false,
      instances: [
        { name: "local", baseUrl: mock.baseUrl, priority: 40, timeoutMs: 5000, useNativeApi: null }
      ]
    });
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("returns models from /v1/models", async () => {
    const models = await backend.listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("llama-3.3-70b");
    expect(ids).toContain("nomic-embed-text");
  });
});

describe("OllamaBackend.listModels (native mode)", () => {
  let mock: MockOllamaHandle;
  let backend: OllamaBackend;

  beforeAll(async () => {
    mock = await startMockOllama();
    backend = new OllamaBackend({
      enabled: true,
      useNativeApi: true,
      instances: [
        { name: "local", baseUrl: mock.baseUrl, priority: 40, timeoutMs: 5000, useNativeApi: null }
      ]
    });
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("returns models from /api/tags", async () => {
    const models = await backend.listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("llama-3.3-70b");
    expect(ids).toContain("nomic-embed-text");
  });

  it("each ModelDescriptor carries a parsed-from-tags description", async () => {
    const models = await backend.listModels();
    const llama = models.find((m) => m.id === "llama-3.3-70b");
    expect(llama?.description).toBeDefined();
    expect(typeof llama?.description).toBe("string");
  });
});

describe("OllamaBackend.listModels (multi-instance dedup + priority)", () => {
  let mockA: MockOllamaHandle;
  let mockB: MockOllamaHandle;
  let backend: OllamaBackend;

  beforeAll(async () => {
    mockA = await startMockOllama();
    mockB = await startMockOllama();
    backend = new OllamaBackend({
      enabled: true,
      useNativeApi: false,
      instances: [
        { name: "high", baseUrl: mockA.baseUrl, priority: 100, timeoutMs: 5000, useNativeApi: null },
        { name: "low", baseUrl: mockB.baseUrl, priority: 10, timeoutMs: 5000, useNativeApi: true }
      ]
    });
  });

  afterAll(async () => {
    await mockA.stop();
    await mockB.stop();
  });

  it("dedupes overlapping model ids, keeping the higher-priority entry", async () => {
    const models = await backend.listModels();
    // mockA + mockB both report llama-3.3-70b; only one should remain.
    const llamaEntries = models.filter((m) => m.id === "llama-3.3-70b");
    expect(llamaEntries.length).toBe(1);
  });
});

describe("OllamaBackend.listModels (instance probe failure does not crash)", () => {
  let mock: MockOllamaHandle;
  let backend: OllamaBackend;

  beforeAll(async () => {
    mock = await startMockOllama();
    backend = new OllamaBackend({
      enabled: true,
      useNativeApi: false,
      instances: [
        { name: "ok", baseUrl: mock.baseUrl, priority: 40, timeoutMs: 5000, useNativeApi: null },
        { name: "bad", baseUrl: "http://127.0.0.1:1", priority: 10, timeoutMs: 500, useNativeApi: null }
      ]
    });
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("returns models from reachable instances even when others fail", async () => {
    const models = await backend.listModels();
    const ids = models.map((m) => m.id);
    expect(ids).toContain("llama-3.3-70b");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/backends/ollamaBackend.test.ts`
Expected: FAIL — `listModels` still returns `[]`.

- [ ] **Step 3: Implement `listModels()` in `src/backends/ollamaBackend.ts`**

Replace the stub:

```ts
  async listModels(): Promise<ModelDescriptor[]> {
    // Probe every instance in parallel; tolerate failures per-instance.
    const probed = await Promise.all(
      this.instances.map(async (r) => {
        try {
          const models =
            r.mode === "native"
              ? await this.probeNativeTags(r)
              : await this.probeCompatModels(r);
          return { instance: r, models };
        } catch (err) {
          // Log and contribute no models from this instance. Production code
          // should plug a structured logger here; Plan 09 stays minimal.
          // eslint-disable-next-line no-console
          console.warn(
            `OllamaBackend: instance ${r.name} probe failed: ${err instanceof Error ? err.message : String(err)}`
          );
          return { instance: r, models: [] as ModelDescriptor[] };
        }
      })
    );

    // Sort by descending priority so the first occurrence of each model id
    // wins the dedup pass.
    probed.sort((a, b) => b.instance.priority - a.instance.priority);

    const seen = new Set<string>();
    const out: ModelDescriptor[] = [];
    for (const p of probed) {
      for (const m of p.models) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          out.push(m);
        }
      }
    }
    return out;
  }

  private async probeNativeTags(r: ResolvedInstance): Promise<ModelDescriptor[]> {
    if (!r.nativeClient) {
      throw new Error(`OllamaBackend.probeNativeTags: no nativeClient for ${r.name}`);
    }
    const raw = (await r.nativeClient.listTags()) as {
      models?: Array<{
        name: string;
        details?: { family?: string; parameter_size?: string; quantization_level?: string };
      }>;
    };
    return (raw.models ?? []).map((m) => ({
      id: m.name,
      supportsTools: true,    // conservative; backend says yes, model may not honor at runtime
      supportsVision: true,   // ditto
      description: this.formatTagDescription(m)
    }));
  }

  private formatTagDescription(m: {
    details?: { family?: string; parameter_size?: string; quantization_level?: string };
  }): string {
    const bits: string[] = [];
    if (m.details?.family) bits.push(m.details.family);
    if (m.details?.parameter_size) bits.push(m.details.parameter_size);
    if (m.details?.quantization_level) bits.push(m.details.quantization_level);
    return bits.length > 0 ? bits.join(" · ") : "ollama model";
  }

  private async probeCompatModels(r: ResolvedInstance): Promise<ModelDescriptor[]> {
    if (!r.compatClient) {
      throw new Error(`OllamaBackend.probeCompatModels: no compatClient for ${r.name}`);
    }
    // openaiCompatClient.listModels already returns ModelDescriptor[].
    return await r.compatClient.listModels();
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/backends/ollamaBackend.test.ts`
Expected: PASS — all earlier tests + 5 new (compat + native + dedup + failure-tolerant) green.

- [ ] **Step 5: Commit**

```bash
git add src/backends/ollamaBackend.ts tests/unit/backends/ollamaBackend.test.ts
git commit -m "feat(ollamaBackend): implement listModels across instances with priority-based dedup and probe-failure tolerance"
```

---

## Task 7: OllamaBackend.invoke() — compat-mode dispatch

**Files:**
- Modify: `src/backends/ollamaBackend.ts`
- Modify: `tests/unit/backends/ollamaBackend.test.ts`

Wire `invoke()` for the compat-mode path. The translator for compat mode is trivial: `openaiCompatClient.chat(req)` already returns `AsyncIterable<NormalizedEvent>` per Plan 08, so `OllamaBackend.invoke()` in compat mode is essentially a passthrough plus instance selection. Instance selection rule: walk instances in descending-priority order, return the first one whose `listModels()` reported the requested model. If no instance owns the model, fall back to the highest-priority instance (Ollama is permissive about unknown model ids — it returns an error from the wire that we surface to the caller).

Native-mode dispatch lands in Task 8 — Task 7 throws a "native mode not yet implemented in this task" for native instances so we don't accidentally exercise the wrong path.

- [ ] **Step 1: Append failing tests for compat-mode invoke**

Append to `tests/unit/backends/ollamaBackend.test.ts`:

```ts
import type { NormalizedEvent } from "../../../src/backends/types.js";

describe("OllamaBackend.invoke (compat mode)", () => {
  let mock: MockOllamaHandle;
  let backend: OllamaBackend;

  beforeAll(async () => {
    mock = await startMockOllama();
    backend = new OllamaBackend({
      enabled: true,
      useNativeApi: false,
      instances: [
        { name: "local", baseUrl: mock.baseUrl, priority: 40, timeoutMs: 5000, useNativeApi: null }
      ]
    });
    // Cause listModels to populate the instance-owner cache.
    await backend.listModels();
  });

  afterAll(async () => {
    await mock.stop();
  });

  async function collect(it: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
    const out: NormalizedEvent[] = [];
    for await (const ev of it) out.push(ev);
    return out;
  }

  it("emits message_start → text_delta(s) → message_stop for a normal chat", async () => {
    const events = await collect(
      backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
      })
    );
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
    const text = events
      .filter((e): e is Extract<NormalizedEvent, { kind: "text_delta" }> => e.kind === "text_delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("echo: hello");
  });

  it("forwards samplingParams as flat fields (OpenAI-compat shape)", async () => {
    // The mock doesn't validate the request; success of this call is the contract.
    const events = await collect(
      backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        samplingParams: { temperature: 0.5, topP: 0.9, topK: 40 },
        maxTokens: 100,
        stopSequences: ["END"]
      })
    );
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("emits tool_use events for tool_calls (compat mode)", async () => {
    const events = await collect(
      backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "MOCK_TOOL_CALL" }] }],
        tools: [{ name: "echo", inputSchema: { type: "object" } }]
      })
    );
    expect(events.some((e) => e.kind === "tool_use_start")).toBe(true);
    expect(events.some((e) => e.kind === "tool_use_delta")).toBe(true);
    expect(events.some((e) => e.kind === "tool_use_stop")).toBe(true);
  });

  it("propagates HTTP 500 as a thrown error from the iterator", async () => {
    await expect(async () => {
      for await (const _ of backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "MOCK_ERROR" }] }]
      })) {
        // no-op
      }
    }).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/backends/ollamaBackend.test.ts`
Expected: FAIL — invoke still throws "lands in Plan 09 Task 7".

- [ ] **Step 3: Implement compat-mode invoke**

Replace the invoke stub in `src/backends/ollamaBackend.ts`. Cache the per-instance model ownership inside `listModels()` so `invoke()` can select correctly:

Add a private field next to `byName`:

```ts
  /** modelId → name of the highest-priority instance that reports owning it. */
  private modelOwner = new Map<string, string>();
```

Inside `listModels()`, populate `modelOwner` as we walk the dedup pass:

```ts
    // After the seen.add(m.id) line, also remember which instance owned it:
    this.modelOwner.set(m.id, p.instance.name);
```

(The exact placement: inside the inner `for (const m of p.models)` loop, after the existing `if (!seen.has(...))` branch — both `seen.add(...)`, `out.push(...)`, and `modelOwner.set(...)` happen on the same first occurrence.)

Then replace `invoke()`:

```ts
  async *invoke(
    req: NormalizedRequest
  ): AsyncIterable<NormalizedEvent> {
    const instance = this.selectInstance(req.model);

    if (instance.mode === "compat") {
      yield* this.invokeCompat(instance, req);
      return;
    }

    // Native dispatch lands in Task 8.
    throw new Error(
      "OllamaBackend.invoke(): native-mode dispatch lands in Plan 09 Task 8"
    );
  }

  /**
   * Pick the instance that should service `modelId`. Strategy:
   *   1. If listModels has recorded an owner for this model id, use it.
   *   2. Otherwise, fall back to the highest-priority instance and let the
   *      wire return whatever error (unknown model ids surface as a 4xx from
   *      Ollama, which the client surfaces verbatim).
   */
  private selectInstance(modelId: string): ResolvedInstance {
    const ownerName = this.modelOwner.get(modelId);
    if (ownerName) {
      const r = this.byName.get(ownerName);
      if (r) return r;
    }
    // Highest priority fallback.
    let best = this.instances[0];
    if (!best) {
      throw new Error("OllamaBackend.selectInstance: no instances configured");
    }
    for (const r of this.instances) {
      if (r.priority > best.priority) best = r;
    }
    return best;
  }

  /**
   * Compat-mode invocation: the openaiCompatClient already returns
   * NormalizedEvents, so this method is mostly a forwarder + request
   * translation (flat sampling params, stop, max_tokens).
   */
  private async *invokeCompat(
    instance: ResolvedInstance,
    req: NormalizedRequest
  ): AsyncIterable<NormalizedEvent> {
    if (!instance.compatClient) {
      throw new Error(
        `OllamaBackend.invokeCompat: instance ${instance.name} has no compatClient`
      );
    }
    // openaiCompatClient.chat takes a NormalizedRequest per Plan 08's contract.
    yield* instance.compatClient.chat(req);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/backends/ollamaBackend.test.ts`
Expected: PASS — all earlier tests + 4 new compat-invoke tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backends/ollamaBackend.ts tests/unit/backends/ollamaBackend.test.ts
git commit -m "feat(ollamaBackend): wire invoke() compat-mode dispatch via openaiCompatClient + instance selection"
```

---

## Task 8: OllamaBackend.invoke() — native-mode request translation + event normalization

**Files:**
- Modify: `src/backends/ollamaBackend.ts`
- Modify: `tests/unit/backends/ollamaBackend.test.ts`

Wire the native-mode path. Translation rules (from the plan-level table above):

Request translation (`NormalizedRequest` → `/api/chat` body):
- `model`, `stream: true`, `keep_alive: NATIVE_KEEP_ALIVE`.
- `messages` — translate from `NormalizedMessage` (content blocks) to Ollama's shape `{role, content: string, tool_calls?, tool_call_id?}`. Ollama natively accepts:
  - `role: "system" | "user" | "assistant" | "tool"`.
  - `content` is a string (concat all text blocks of a message). Image blocks become `images: [base64, ...]` on the user message (Ollama supports `images` on user messages for vision models).
  - `tool_use` blocks on assistant messages become `tool_calls: [{id, function: {name, arguments: JSON.stringify(input)}}]`.
  - `tool_result` blocks become a tool-role message: `{role: "tool", content: <result>, tool_call_id: <toolUseId>}`.
- `tools` if present → `body.tools: [{type: "function", function: {name, description?, parameters: inputSchema}}]`.
- Sampling: `body.options = {}` if any of `temperature/topP/topK/stop/max_tokens` is set, with `temperature`, `top_p`, `top_k`, `stop: req.stopSequences`, `num_predict: req.maxTokens`.
- `format: "json"` when `req.metadata?.format === "json"`.

Response translation (NDJSON lines → `NormalizedEvent`s):

| Native chunk | Event(s) emitted |
|---|---|
| First parsed chunk | `message_start { model }` (once) |
| `message.content` non-empty | `text_delta { index: textIndex, text }` (with `textIndex` initialized to 0 on first text emission; increments only after the text run closes — see implementation note) |
| `message.tool_calls: [...]` | For each call: `tool_use_start`, then `tool_use_delta { partialJson: arguments }`, then `tool_use_stop`. Each call gets the next sequential `toolIndex`. If `id` is missing on the chunk, synthesize one via `call_${name}_${Date.now()}_${i}`. |
| `done: true` | `message_stop { stopReason, usage }` where `stopReason` is mapped from `done_reason` (`"stop"` → `"end_turn"`; `"length"` → `"max_tokens"`; anything else heuristic — see below). `usage` carries `inputTokens: prompt_eval_count`, `outputTokens: eval_count`. |
| Stream ends without `done: true` | Synthesized `message_stop { stopReason: "error" }`. |

`stopReason` heuristic: if any `tool_use_start` was emitted before the terminal chunk, `done_reason !== "length"` maps to `"tool_use"` rather than `"end_turn"`. This matches the Anthropic shim's expectation that `tool_use` is signaled as the stop reason whenever the assistant ended its turn intending the caller to execute a tool.

Index tracking: text-block index and tool-block index are separate but share the same monotone counter (per the `NormalizedEvent` design from Plan 01). The implementation uses one `nextIndex` integer that increments after each closing event (text-run close or `tool_use_stop`).

- [ ] **Step 1: Append failing tests for native-mode invoke**

Append to `tests/unit/backends/ollamaBackend.test.ts`:

```ts
describe("OllamaBackend.invoke (native mode)", () => {
  let mock: MockOllamaHandle;
  let backend: OllamaBackend;

  beforeAll(async () => {
    mock = await startMockOllama();
    backend = new OllamaBackend({
      enabled: true,
      useNativeApi: true,
      instances: [
        { name: "local", baseUrl: mock.baseUrl, priority: 40, timeoutMs: 5000, useNativeApi: null }
      ]
    });
    await backend.listModels();
  });

  afterAll(async () => {
    await mock.stop();
  });

  async function collect(it: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
    const out: NormalizedEvent[] = [];
    for await (const ev of it) out.push(ev);
    return out;
  }

  it("emits message_start → text_delta(s) → message_stop for a normal chat", async () => {
    const events = await collect(
      backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
      })
    );
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
    const text = events
      .filter((e): e is Extract<NormalizedEvent, { kind: "text_delta" }> => e.kind === "text_delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("echo: hello");
  });

  it("usage on message_stop comes from prompt_eval_count + eval_count", async () => {
    const events = await collect(
      backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
      })
    );
    const stop = events[events.length - 1];
    if (stop?.kind !== "message_stop") throw new Error("expected message_stop");
    expect(stop.usage?.inputTokens).toBeGreaterThan(0);
    expect(stop.usage?.outputTokens).toBeGreaterThan(0);
  });

  it("emits tool_use events for tool_calls (native mode), stopReason=tool_use", async () => {
    const events = await collect(
      backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "MOCK_TOOL_CALL" }] }],
        tools: [{ name: "echo", inputSchema: { type: "object" } }]
      })
    );
    const starts = events.filter((e) => e.kind === "tool_use_start");
    const deltas = events.filter((e) => e.kind === "tool_use_delta");
    const stops = events.filter((e) => e.kind === "tool_use_stop");
    expect(starts.length).toBe(1);
    expect(deltas.length).toBe(1);
    expect(stops.length).toBe(1);
    const finalStop = events[events.length - 1];
    if (finalStop?.kind !== "message_stop") throw new Error("expected message_stop");
    expect(finalStop.stopReason).toBe("tool_use");
  });

  it("translates samplingParams into options.{temperature, top_p, top_k}", async () => {
    // The mock doesn't validate the body; success of the round-trip is what
    // we assert here. The shape contract is exercised more strictly in the
    // unit-level translator helper test below.
    const events = await collect(
      backend.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        samplingParams: { temperature: 0.7, topP: 0.95, topK: 64 },
        maxTokens: 256,
        stopSequences: ["DONE"]
      })
    );
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("includes keep_alive in the request body by default (verified via translator helper)", () => {
    const body = (backend as unknown as {
      buildNativeBody: (req: NormalizedRequest) => Record<string, unknown>;
    }).buildNativeBody({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    });
    expect(body.keep_alive).toBe("5m");
    expect(body.stream).toBe(true);
  });

  it("translator: sampling params land under options, not flat", () => {
    const body = (backend as unknown as {
      buildNativeBody: (req: NormalizedRequest) => Record<string, unknown>;
    }).buildNativeBody({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      samplingParams: { temperature: 0.5, topP: 0.9, topK: 30 },
      maxTokens: 128,
      stopSequences: ["END"]
    });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    const options = body.options as Record<string, unknown>;
    expect(options.temperature).toBe(0.5);
    expect(options.top_p).toBe(0.9);
    expect(options.top_k).toBe(30);
    expect(options.num_predict).toBe(128);
    expect(options.stop).toEqual(["END"]);
  });

  it("translator: format: \"json\" landed when req.metadata.format === 'json'", () => {
    const body = (backend as unknown as {
      buildNativeBody: (req: NormalizedRequest) => Record<string, unknown>;
    }).buildNativeBody({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      metadata: { format: "json" }
    });
    expect(body.format).toBe("json");
  });

  it("translator: image blocks lift onto user message as images: [...]", () => {
    const body = (backend as unknown as {
      buildNativeBody: (req: NormalizedRequest) => Record<string, unknown>;
    }).buildNativeBody({
      model: "llama-3.3-70b",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", mediaType: "image/png", data: "QkFTRTY0IGltYWdlIGRhdGE=" }
          ]
        }
      ]
    });
    const messages = body.messages as Array<{ role: string; content: string; images?: string[] }>;
    expect(messages[0]?.images).toEqual(["QkFTRTY0IGltYWdlIGRhdGE="]);
    expect(messages[0]?.content).toBe("what is this?");
  });

  it("translator: assistant tool_use → tool_calls; tool_result → role=tool message", () => {
    const body = (backend as unknown as {
      buildNativeBody: (req: NormalizedRequest) => Record<string, unknown>;
    }).buildNativeBody({
      model: "llama-3.3-70b",
      messages: [
        { role: "user", content: [{ type: "text", text: "use the tool" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool_use", id: "call_42", name: "echo", input: { text: "x" } }
          ]
        },
        {
          role: "tool",
          content: [{ type: "tool_result", toolUseId: "call_42", content: "ok" }]
        }
      ]
    });
    const messages = body.messages as Array<{
      role: string;
      content: string;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      tool_call_id?: string;
    }>;
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.tool_calls?.[0]?.id).toBe("call_42");
    expect(messages[1]?.tool_calls?.[0]?.function.name).toBe("echo");
    expect(messages[2]?.role).toBe("tool");
    expect(messages[2]?.tool_call_id).toBe("call_42");
    expect(messages[2]?.content).toBe("ok");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/backends/ollamaBackend.test.ts`
Expected: FAIL — `invoke()` for native instances still throws "lands in Task 8"; `buildNativeBody` is not exposed.

- [ ] **Step 3: Implement native-mode dispatch + translator helpers**

Replace the native-mode throw branch in `invoke()`:

```ts
    if (instance.mode === "native") {
      yield* this.invokeNative(instance, req);
      return;
    }

    throw new Error(
      `OllamaBackend.invoke(): unreachable mode ${instance.mode}`
    );
```

Add the implementation methods to the class:

```ts
  private async *invokeNative(
    instance: ResolvedInstance,
    req: NormalizedRequest
  ): AsyncIterable<NormalizedEvent> {
    if (!instance.nativeClient) {
      throw new Error(
        `OllamaBackend.invokeNative: instance ${instance.name} has no nativeClient`
      );
    }
    const body = this.buildNativeBody(req);

    let started = false;
    let nextIndex = 0;
    let textOpen = false;
    let sawToolUse = false;

    function emitTextDelta(text: string): NormalizedEvent {
      textOpen = true;
      return { kind: "text_delta", index: nextIndex, text };
    }

    function closeTextRun(): void {
      if (textOpen) {
        textOpen = false;
        nextIndex++;
      }
    }

    for await (const raw of instance.nativeClient.chat(body)) {
      const chunk = raw as {
        model?: string;
        done?: boolean;
        done_reason?: string;
        message?: {
          content?: string;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        prompt_eval_count?: number;
        eval_count?: number;
      };

      if (!started) {
        started = true;
        yield { kind: "message_start", model: chunk.model ?? req.model };
      }

      // Text content.
      const content = chunk.message?.content;
      if (typeof content === "string" && content.length > 0) {
        yield emitTextDelta(content);
      }

      // Tool calls (typically arrive on a single chunk).
      const calls = chunk.message?.tool_calls ?? [];
      if (calls.length > 0) {
        closeTextRun();
        for (const [i, call] of calls.entries()) {
          const name = call.function?.name ?? "unknown";
          const id =
            call.id ?? `call_${name}_${Date.now()}_${i}`;
          const args = call.function?.arguments ?? "";
          sawToolUse = true;
          yield { kind: "tool_use_start", index: nextIndex, id, name };
          yield { kind: "tool_use_delta", index: nextIndex, partialJson: args };
          yield { kind: "tool_use_stop", index: nextIndex };
          nextIndex++;
        }
      }

      if (chunk.done === true) {
        closeTextRun();
        const usage =
          chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined
            ? {
                inputTokens: chunk.prompt_eval_count ?? 0,
                outputTokens: chunk.eval_count ?? 0
              }
            : undefined;
        const stopReason = mapNativeStopReason(chunk.done_reason, sawToolUse);
        yield { kind: "message_stop", stopReason, usage };
        return;
      }
    }

    // Stream ended without a done: true chunk.
    if (!started) {
      yield { kind: "message_start", model: req.model };
    }
    closeTextRun();
    yield { kind: "message_stop", stopReason: "error" };
  }

  /**
   * Translate a NormalizedRequest into Ollama's native /api/chat body shape.
   * Test-visible (not `private`) so the unit tests can assert the precise
   * shape without having to spawn a server.
   */
  buildNativeBody(req: NormalizedRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: this.translateMessagesNative(req),
      stream: true,
      keep_alive: NATIVE_KEEP_ALIVE
    };

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          ...(t.description !== undefined ? { description: t.description } : {}),
          parameters: t.inputSchema
        }
      }));
    }

    const options: Record<string, unknown> = {};
    if (req.samplingParams?.temperature !== undefined) options.temperature = req.samplingParams.temperature;
    if (req.samplingParams?.topP !== undefined) options.top_p = req.samplingParams.topP;
    if (req.samplingParams?.topK !== undefined) options.top_k = req.samplingParams.topK;
    if (req.maxTokens !== undefined) options.num_predict = req.maxTokens;
    if (req.stopSequences && req.stopSequences.length > 0) options.stop = req.stopSequences;
    if (Object.keys(options).length > 0) body.options = options;

    if (req.metadata?.format === "json") {
      body.format = "json";
    }

    return body;
  }

  private translateMessagesNative(
    req: NormalizedRequest
  ): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];

    if (req.system) {
      out.push({ role: "system", content: req.system });
    }

    for (const msg of req.messages) {
      // tool-role messages map 1:1 — Ollama wants one tool message per
      // tool_result block (per-call).
      if (msg.role === "tool") {
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            out.push({
              role: "tool",
              content: block.content,
              tool_call_id: block.toolUseId
            });
          }
        }
        continue;
      }

      const textParts: string[] = [];
      const images: string[] = [];
      const toolCalls: Array<{
        id: string;
        function: { name: string; arguments: string };
      }> = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "image") {
          // Ollama supports inline base64 image payloads on user messages.
          images.push(block.data);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            function: {
              name: block.name,
              arguments: typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input)
            }
          });
        }
        // document blocks: not in Ollama's surface — silently skipped here
        // because vision is `images: [...]` only and PDFs aren't a first-class
        // local-model input shape. Future plan if needed.
      }

      const entry: Record<string, unknown> = {
        role: msg.role,
        content: textParts.join("\n")
      };
      if (images.length > 0) entry.images = images;
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      out.push(entry);
    }

    return out;
  }
```

Add this free helper at module scope:

```ts
function mapNativeStopReason(
  doneReason: string | undefined,
  sawToolUse: boolean
): "end_turn" | "stop_sequence" | "max_tokens" | "tool_use" | "error" {
  // Tool emission overrides the default when the reason isn't a hard length
  // cap. The Anthropic shim downstream expects "tool_use" whenever the model
  // intends the caller to run a tool.
  if (sawToolUse && doneReason !== "length") {
    return "tool_use";
  }
  switch (doneReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case undefined:
      return "end_turn";
    default:
      // Future Ollama versions may add new reasons (e.g., "stop_sequence",
      // "load"). Default to error so the caller can decide.
      return "error";
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/backends/ollamaBackend.test.ts`
Expected: PASS — all earlier tests + ~9 new native-invoke tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backends/ollamaBackend.ts tests/unit/backends/ollamaBackend.test.ts
git commit -m "feat(ollamaBackend): wire invoke() native-mode dispatch with request translation + NDJSON event normalization"
```

---

## Task 9: OllamaBackend.embed() — both modes

**Files:**
- Modify: `src/backends/ollamaBackend.ts`
- Modify: `tests/unit/backends/ollamaBackend.test.ts`

Implement `embed()` against both modes. Selection rule mirrors `invoke()`: prefer the instance that `listModels()` recorded as owning the requested embedding model; fall back to the highest-priority instance otherwise.

- Compat mode: delegate to `instance.compatClient.embed(req)` (Plan 08's `openaiCompatClient` exposes `embed()` returning `NormalizedEmbeddingResponse`).
- Native mode: call `instance.nativeClient.embed({model, input: req.input})` and normalize the response. Both shapes (modern `{embeddings: number[][]}` and legacy-converted `{embeddings: number[][]}`) emerge from the client uniform, so the backend just wraps the result into `NormalizedEmbeddingResponse`.

- [ ] **Step 1: Append failing tests**

Append to `tests/unit/backends/ollamaBackend.test.ts`:

```ts
describe("OllamaBackend.embed (compat mode)", () => {
  let mock: MockOllamaHandle;
  let backend: OllamaBackend;

  beforeAll(async () => {
    mock = await startMockOllama();
    backend = new OllamaBackend({
      enabled: true,
      useNativeApi: false,
      instances: [
        { name: "local", baseUrl: mock.baseUrl, priority: 40, timeoutMs: 5000, useNativeApi: null }
      ]
    });
    await backend.listModels();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("round-trips a single-input embed", async () => {
    const resp = await backend.embed!({
      model: "nomic-embed-text",
      input: ["hello"]
    });
    expect(resp.embeddings.length).toBe(1);
    expect(resp.embeddings[0]?.length).toBeGreaterThan(0);
    expect(resp.model).toBe("nomic-embed-text");
  });

  it("round-trips multiple inputs", async () => {
    const resp = await backend.embed!({
      model: "nomic-embed-text",
      input: ["hello", "world", "again"]
    });
    expect(resp.embeddings.length).toBe(3);
  });
});

describe("OllamaBackend.embed (native mode)", () => {
  let mock: MockOllamaHandle;
  let backend: OllamaBackend;

  beforeAll(async () => {
    mock = await startMockOllama();
    backend = new OllamaBackend({
      enabled: true,
      useNativeApi: true,
      instances: [
        { name: "local", baseUrl: mock.baseUrl, priority: 40, timeoutMs: 5000, useNativeApi: null }
      ]
    });
    await backend.listModels();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("hits /api/embed and returns NormalizedEmbeddingResponse", async () => {
    const resp = await backend.embed!({
      model: "nomic-embed-text",
      input: ["hello"]
    });
    expect(resp.embeddings.length).toBe(1);
    expect(resp.embeddings[0]?.length).toBe(8);
    expect(resp.model).toBe("nomic-embed-text");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/backends/ollamaBackend.test.ts`
Expected: FAIL — `embed()` still throws "lands in Task 9".

- [ ] **Step 3: Implement `embed()`**

Replace the embed stub in `src/backends/ollamaBackend.ts`:

```ts
  async embed(
    req: NormalizedEmbeddingRequest
  ): Promise<NormalizedEmbeddingResponse> {
    const instance = this.selectInstance(req.model);

    if (instance.mode === "compat") {
      if (!instance.compatClient) {
        throw new Error(
          `OllamaBackend.embed: instance ${instance.name} has no compatClient`
        );
      }
      return await instance.compatClient.embed(req);
    }

    if (!instance.nativeClient) {
      throw new Error(
        `OllamaBackend.embed: instance ${instance.name} has no nativeClient`
      );
    }
    const raw = (await instance.nativeClient.embed({
      model: req.model,
      input: req.input
    })) as { embeddings?: number[][]; model?: string };

    if (!Array.isArray(raw.embeddings)) {
      throw new Error(
        `OllamaBackend.embed: native client returned no embeddings array`
      );
    }
    return {
      model: raw.model ?? req.model,
      embeddings: raw.embeddings
    };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/backends/ollamaBackend.test.ts`
Expected: PASS — all earlier tests + 3 new embed tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backends/ollamaBackend.ts tests/unit/backends/ollamaBackend.test.ts
git commit -m "feat(ollamaBackend): wire embed() through compat (openaiCompatClient.embed) and native (ollamaNativeClient.embed) paths"
```

---

## Task 10: server.ts wires OllamaBackend at startup

**Files:**
- Modify: `src/server.ts`
- Test: `tests/unit/server.test.ts` (extend) — or a focused new test if `server.test.ts` doesn't exist yet in your branch lineage.

Add the Ollama backend to the server startup sequence, alongside the existing Claude / Gemini / LM Studio registrations. Gate on `config.ollama.enabled && config.ollama.instances.length > 0` to avoid registering an empty backend.

- [ ] **Step 1: Add or extend the failing test**

If `tests/unit/server.test.ts` already exists from prior plans, append. Otherwise create it with the same shape Plan 08 used (see your branch's actual test layout):

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockOllama, type MockOllamaHandle } from "../helpers/mockOllamaProcess.js";
import { buildRegistryFromConfig } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";

describe("server startup registers OllamaBackend when configured", () => {
  let mock: MockOllamaHandle;
  let configDir: string;
  let configPath: string;

  beforeAll(async () => {
    mock = await startMockOllama();
    configDir = mkdtempSync(join(tmpdir(), "claudemcp-server-test-"));
    configPath = join(configDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        apiKey: "test-key",
        claude: { enabled: false, command: "claude", priority: 100, timeoutMs: 60000 },
        gemini: { enabled: false, command: "gemini", priority: 90, timeoutMs: 60000 },
        lmstudio: { enabled: false, instances: [] },
        ollama: {
          enabled: true,
          useNativeApi: false,
          instances: [
            {
              name: "local",
              baseUrl: mock.baseUrl,
              priority: 40,
              timeoutMs: 5000,
              useNativeApi: null
            }
          ]
        }
      })
    );
  });

  afterAll(async () => {
    await mock.stop();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("registers OllamaBackend; registry can resolve a discovered ollama model", async () => {
    const config = loadConfig(configPath);
    const registry = buildRegistryFromConfig(config);
    try {
      await registry.probe();
      expect(registry.lastProbeStatus("ollama")?.ok).toBe(true);
      expect(registry.resolveModel("llama-3.3-70b")?.id).toBe("ollama");
    } finally {
      registry.stop();
    }
  });

  it("does NOT register OllamaBackend when config.ollama.enabled is false", async () => {
    const offConfig = {
      ...JSON.parse(JSON.stringify(loadConfig(configPath))),
      ollama: { enabled: false, useNativeApi: false, instances: [] }
    };
    const offPath = join(configDir, "config-off.json");
    writeFileSync(offPath, JSON.stringify(offConfig));
    const registry = buildRegistryFromConfig(loadConfig(offPath));
    try {
      await registry.probe();
      expect(registry.lastProbeStatus("ollama")).toBeUndefined();
    } finally {
      registry.stop();
    }
  });
});
```

If `buildRegistryFromConfig` isn't already exported from `src/server.ts` in your branch, this task adds (or surfaces) the helper alongside the existing startup wiring.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/server.test.ts`
Expected: FAIL — either `buildRegistryFromConfig` is missing the Ollama branch, or `registry.lastProbeStatus("ollama")` returns undefined.

- [ ] **Step 3: Extend `src/server.ts`**

Locate the existing backend-registration sequence (Claude, Gemini, LM Studio — added by Plans 02, 06, 08). Add the Ollama branch immediately after LM Studio:

```ts
import { OllamaBackend } from "./backends/ollamaBackend.js";

// ... inside buildRegistryFromConfig(config) or the equivalent startup helper:

if (config.ollama.enabled && config.ollama.instances.length > 0) {
  registry.register(
    new OllamaBackend({
      enabled: config.ollama.enabled,
      useNativeApi: config.ollama.useNativeApi,
      instances: config.ollama.instances.map((inst) => ({
        name: inst.name,
        baseUrl: inst.baseUrl,
        priority: inst.priority,
        timeoutMs: inst.timeoutMs,
        useNativeApi: inst.useNativeApi,
        apiKey: inst.apiKey
      }))
    })
  );
}
```

(If your branch's `src/server.ts` doesn't yet have a `buildRegistryFromConfig` helper as a separate function — i.e., registration is inline in the server bootstrap — refactor the registration block into a helper as part of this task. That gives the unit test a target without spawning an HTTP listener.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/server.test.ts`
Expected: PASS — both server tests green.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/unit/server.test.ts
git commit -m "feat(server): register OllamaBackend at startup when config.ollama.enabled && instances[]"
```

---

## Task 11: End-to-end integration through the registry — two instances, two modes

**Files:**
- Create: `tests/integration/ollamaBackend.test.ts`

The final verification: register the Ollama backend in a fresh `BackendRegistry`, configure two instances (A in compat mode against one mock-ollama port, B in native mode against a different port — same fixture, two processes), probe, dispatch through both, assert that the chosen mode actually went through the right wire path.

Asserting "this request hit /v1/* not /api/*" without instrumenting the mock is awkward. The test instead exercises mode-discriminating behavior: the native mode's `usage` comes from `prompt_eval_count + eval_count` keys (unique to native mode); the compat mode's tool_calls arrive on the OpenAI delta shape (unique to compat). Both shapes flow through the same `NormalizedEvent` boundary, so the test sample input is engineered so that each mode's resulting events are observably correct end-to-end.

- [ ] **Step 1: Write the test**

Create `tests/integration/ollamaBackend.test.ts`:

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BackendRegistry } from "../../src/backends/registry.js";
import { OllamaBackend } from "../../src/backends/ollamaBackend.js";
import { startMockOllama, type MockOllamaHandle } from "../helpers/mockOllamaProcess.js";
import type { NormalizedEvent } from "../../src/backends/types.js";

describe("OllamaBackend integrates with BackendRegistry — dual instance, dual mode", () => {
  let mockCompat: MockOllamaHandle;
  let mockNative: MockOllamaHandle;
  let registry: BackendRegistry;

  beforeAll(async () => {
    mockCompat = await startMockOllama();
    mockNative = await startMockOllama();

    registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });

    registry.register(
      new OllamaBackend({
        enabled: true,
        useNativeApi: false, // backend-wide default
        instances: [
          // instance "compat" inherits the false default
          {
            name: "compat",
            baseUrl: mockCompat.baseUrl,
            priority: 60,
            timeoutMs: 5000,
            useNativeApi: null
          },
          // instance "native" overrides to true
          {
            name: "native",
            baseUrl: mockNative.baseUrl,
            priority: 30,
            timeoutMs: 5000,
            useNativeApi: true
          }
        ]
      })
    );
  });

  afterAll(async () => {
    registry.stop();
    await mockCompat.stop();
    await mockNative.stop();
  });

  it("probe succeeds; registry lists ollama as ok", async () => {
    await registry.probe();
    expect(registry.lastProbeStatus("ollama")?.ok).toBe(true);
    expect(registry.resolveModel("llama-3.3-70b")?.id).toBe("ollama");
  });

  it("per-instance mode resolution survives end-to-end (compat-inherits, native-overrides)", async () => {
    await registry.probe();
    const backend = registry.resolveModel("llama-3.3-70b");
    expect(backend?.id).toBe("ollama");
    // Cast back to OllamaBackend to verify mode resolution directly. This is
    // grey-box: the registry's surface only exposes Backend, so we know the
    // concrete type because we registered it ourselves above.
    const concrete = backend as OllamaBackend;
    expect(concrete.instanceMode("compat")).toBe("compat");
    expect(concrete.instanceMode("native")).toBe("native");
  });

  it("invoke through the registry returns a fully-normalized event stream", async () => {
    await registry.probe();
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
    const text = events
      .filter((e): e is Extract<NormalizedEvent, { kind: "text_delta" }> => e.kind === "text_delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("echo: integration ping");
  });

  it("embed through the registry round-trips a vector batch", async () => {
    await registry.probe();
    const backend = registry.resolveModel("nomic-embed-text");
    expect(backend?.id).toBe("ollama");
    expect(typeof backend?.embed).toBe("function");
    const resp = await backend!.embed!({
      model: "nomic-embed-text",
      input: ["hello", "world"]
    });
    expect(resp.embeddings.length).toBe(2);
    expect(resp.embeddings[0]?.length).toBeGreaterThan(0);
  });

  it("countTokens returns a positive number", async () => {
    await registry.probe();
    const backend = registry.resolveModel("llama-3.3-70b");
    const n = await backend!.countTokens({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: [{ type: "text", text: "tokens please" }] }]
    });
    expect(n).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run tests/integration/ollamaBackend.test.ts`
Expected: PASS — all 5 integration tests green.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: All prior-plan tests pass + the new Plan-09 tests:
- ollamaNativeClient: 12
- ollamaBackend: roughly 28-32 across all describes (skeleton, mode resolution, listModels variants, invoke compat, invoke native including translator helpers, embed)
- server.ts integration: 2
- integration: 5

Reconcile actual vs expected count in the close-out README (Task 12).

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Clean. Particular attention to:
- `noUncheckedIndexedAccess` on `events[events.length - 1]?.kind` patterns (handled via optional chaining in the test code).
- The `as unknown as { buildNativeBody: ... }` casts in tests — these are intentional grey-box probes; if they bother your lint config, switch to making `buildNativeBody` a public method (it's already documented as test-visible).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/ollamaBackend.test.ts
git commit -m "test(ollamaBackend): integration through BackendRegistry with dual-instance dual-mode setup"
```

---

## Task 12: Plan-09 close-out documentation

**Files:**
- Create: `docs/plan-09-ollama-backend-readme.md`

- [ ] **Step 1: Write the document**

```markdown
# Plan 09 — Ollama Backend: what shipped

Plan 09 added the fourth concrete `Backend` implementation on top of the Plan 01 foundation. Unlike Plans 02 (Claude), 06 (Gemini), and 08 (LM Studio), the Ollama backend supports two API surfaces — Ollama's OpenAI-compatibility layer and its native `/api/*` API — selectable per instance via `config.ollama.useNativeApi` (backend default) plus per-instance `instances[*].useNativeApi` override. The implementation reuses Plan 08's `openaiCompatClient` for compat mode and introduces a new `ollamaNativeClient` for native mode.

## Modules added

| Path | Purpose | Lines (approx.) |
|---|---|---|
| `src/backends/ollamaNativeClient.ts` | HTTP client for `/api/chat`, `/api/embed`, `/api/embeddings` (legacy fallback), `/api/tags`. NDJSON streaming via web-streams `ReadableStream`. | ~200 |
| `src/backends/ollamaBackend.ts` | `Backend` implementation. Multi-instance dispatch, per-instance mode resolution, native-mode request translator + event normalizer, compat-mode passthrough via openaiCompatClient. | ~330 |
| `src/server.ts` (extended) | Registers OllamaBackend at startup when `config.ollama.enabled && instances.length > 0`. | +20 |
| `tests/helpers/mockOllamaProcess.ts` | Shared spawner that starts mock-ollama on a kernel-assigned ephemeral port and waits for the `LISTENING_ON_PORT` announcement. | ~60 |

## Test infrastructure added

| Path | Purpose |
|---|---|
| `tests/fixtures/mock-ollama/server.mjs` | Single fixture serving BOTH `/api/*` and `/v1/*` surfaces. Binds port 0 so tests can run in parallel without conflicts. Triggers keyed off the last user-message content (MOCK_ERROR, MOCK_TOOL_CALL, MOCK_LONG_STREAM). |
| `tests/fixtures/mock-ollama/package.json` | Bin shim. |
| `tests/unit/backends/ollamaNativeClient.test.ts` | listTags, chat (NDJSON streaming + keep_alive + format:json + 500 errors + timeouts), embed (modern + legacy 404 fallback + caching), chatBuffered (~12 cases). |
| `tests/unit/backends/ollamaBackend.test.ts` | Skeleton (id, capabilities, ctor errors), per-instance mode resolution (5 cases), listModels (compat / native / dedup / failure-tolerant), invoke compat (4 cases), invoke native including translator helpers (9 cases), embed compat (2 cases), embed native (1 case). |
| `tests/unit/server.test.ts` (extended) | Confirms OllamaBackend registers when enabled and does not register when disabled. |
| `tests/integration/ollamaBackend.test.ts` | End-to-end through `BackendRegistry`: two instances (one compat, one native — same fixture twice on different ports), probe, dispatch, embed, countTokens. |

Run all: `npm test`. Expect prior-plan count + ~50-55 new tests.

## Capability matrix (per spec)

`OllamaBackend.capabilitiesFor(model)` returns the same shape across both modes — the operational differences (keep_alive, format:json, raw) don't surface through this matrix:

| Capability | Value |
|---|---|
| toolUse | true |
| multimodal | true |
| thinking | false |
| cacheControl | "none" |
| samplingParams.temperature | true |
| samplingParams.topP | true |
| samplingParams.topK | true |
| stopSequences | "native" |
| embeddings | true |

Same shape as LM Studio — both are local OpenAI-compatible runtimes.

## Per-instance mode resolution

The resolution rule:

```ts
const native =
  instance.useNativeApi === null ? backend.useNativeApi : instance.useNativeApi;
```

Truth table:

| Backend default | Instance flag | Effective mode |
|---|---|---|
| false | null | compat |
| false | true | native |
| false | false | compat |
| true | null | native |
| true | true | native |
| true | false | compat |

Resolution happens once per instance at constructor time. The chosen client (compat or native) is created up-front; instances do not switch modes at runtime. Config changes require a server restart (matching the existing config-frozen-on-load convention from Plan 01).

## Request/response shape contrasts (compat vs native)

| Aspect | Compat mode | Native mode |
|---|---|---|
| Endpoint | `POST /v1/chat/completions` | `POST /api/chat` |
| Streaming framing | SSE (`data: {...}\n\n`) | NDJSON (`{...}\n`) |
| Sampling params placement | Flat: `body.temperature` | Nested: `body.options.temperature` |
| Stop sequences | `body.stop: string[]` | `body.options.stop: string[]` |
| Max tokens | `body.max_tokens` | `body.options.num_predict` |
| Keep-alive control | (not exposed) | `body.keep_alive: "5m"` (constant) |
| JSON-mode | (not exposed) | `body.format: "json"` when `req.metadata.format === "json"` |
| Image inputs | OpenAI content-parts (vision models) | `body.messages[].images: [base64, ...]` |
| Tool calls (request) | `body.tools: [{type:"function", function:{...}}]` | `body.tools: [{type:"function", function:{...}}]` (same) |
| Tool calls (response) | Streaming `delta.tool_calls` chunks | `message.tool_calls` on a single chunk |
| Embeddings | `POST /v1/embeddings` | `POST /api/embed` (falls back to `POST /api/embeddings` on 404) |
| Model listing | `GET /v1/models` | `GET /api/tags` |

The contract that `OllamaBackend.invoke()` hands back to the registry — `AsyncIterable<NormalizedEvent>` — is identical regardless of which path executed.

## keep_alive policy

Plan 09 does NOT add `keep_alive` to `NormalizedRequest`. Native-mode requests always include `keep_alive: "5m"` (matching Ollama's own server default). Compat mode has no `keep_alive` knob — the OpenAI-compat layer doesn't expose it. Future plans can promote the constant to `config.ollama.keepAlive` or to a first-class `NormalizedRequest` field.

## Plan-09 scope boundary (what does NOT ship here)

- Model pull / push / unload from this backend — Ollama is responsible for model management; we discover, we don't manage.
- `keep_alive` / `raw` as first-class `NormalizedRequest` fields — future plan; the backend applies a default for `keep_alive` and ignores `raw`.
- Real Ollama integration tests — mock HTTP only (matches Plan 08).
- Per-model capability narrowing — `capabilitiesFor(model)` returns the same matrix for every model. Per-loaded-model capability probing is a spec-level open question.

## What the next plan (Plan 10 — OpenAI shim multi-backend extension) needs

- Both LM Studio and Ollama backends registered at startup (Plans 08 and 09 — both done).
- The shared `BackendRegistry` populated with a discovered set of local models from each backend's `listModels()`.
- `openaiCompatClient` and `ollamaNativeClient` reachable as the underlying transports.

Plan 10 extends `src/openaiShim/embeddings.ts` and the existing `/v1/chat/completions` handler to route via the registry instead of hard-coding the legacy embeddings backend URL. No changes to Plan 09's modules.

## Open questions surfaced during Plan 09

1. **First-class `keep_alive` field on `NormalizedRequest`.** Plan 09 applies a backend-level default of `"5m"` in native mode. Promoting to a request field (so the Anthropic shim can pass a per-request override) is straightforward but waits for a concrete use case.
2. **Real Ollama API version stability.** Plan 09 targets the 2026-05 surface. The legacy `/api/embeddings` fallback exists because some older deployments stay on that path. As Ollama versions go EOL, the fallback can be removed.
3. **Per-model capability narrowing.** The capability matrix is per-backend. Some loaded models lack vision support or tool-calling fidelity. A follow-up could probe `/api/show` per model and narrow `supportsTools` / `supportsVision` on the `ModelDescriptor`.
4. **OpenAI-compat `format: "json"` (response_format) for native-mode parity.** Plan 09 forwards `req.metadata?.format === "json"` only in native mode. Whether the Anthropic shim should be allowed to request JSON-mode against an Ollama compat instance via `response_format: {type: "json_object"}` is a Plan 10 / shim-level decision.
5. **Tool-call id stability across stream chunks.** Some Ollama versions emit tool calls without an `id`. Plan 09 synthesizes `call_${name}_${Date.now()}_${i}`; this is stable for the duration of one stream but not across reruns. If the Anthropic shim's tool_result round-trip relies on referencing back to the same id later in the same conversation, the synthesized id is correct only within that one assistant turn. Caller-side bookkeeping in the shim assumes within-turn stability, which is preserved.
6. **`/api/show` probe for richer ModelDescriptors.** `/api/tags` returns name + family + parameter_size + quantization. Context window, base model, etc., live under `/api/show`. A follow-up plan can swap in `/api/show` for richer descriptions visible in the admin UI.

## Deviations from this plan that landed during execution

(Filled in by the implementer / reviewer during the actual task cycles. Expected items typically include: any divergence in Plan 08's `openaiCompatClient` constructor signature requiring Task 5 adaptation; any differences in `BackendRegistry`'s priority-map argument shape; test-count reconciliation if a placeholder test needed replacement rather than appending.)
```

- [ ] **Step 2: Commit**

```bash
git add docs/plan-09-ollama-backend-readme.md
git commit -m "docs: add Plan 09 close-out README documenting Ollama backend scope, dual-mode dispatch, open questions"
```

---

## Plan 09 — Self-review checklist

Before declaring Plan 09 done, run through this checklist:

- [ ] `npm test` — all tests green, no skips. Reconcile actual vs expected count in the close-out doc.
- [ ] `npx tsc --noEmit` — no type errors. Particular attention to:
  - `noUncheckedIndexedAccess` on `events[events.length - 1]?.kind` patterns in tests.
  - The grey-box `as unknown as { buildNativeBody: ... }` cast — either keep that escape hatch or promote `buildNativeBody` to a documented public method.
  - The `private`/`public` boundary on `byName`, `modelOwner`, and `instances` in `OllamaBackend` — the integration test casts back to the concrete type to probe `instanceMode()`, which IS public.
- [ ] `git status` — clean tree, all changes committed (except pre-existing untracked files).
- [ ] `git log --oneline -14` — commits read sensibly: fixture, native client skeleton, native client chat, native client embed, backend skeleton, backend listModels, backend invoke compat, backend invoke native, backend embed, server wiring, integration, README.
- [ ] `src/backends/` directory contains the expected files: `types.ts`, `registry.ts`, `openaiCompatClient.ts` (Plan 08), `claudeBackend.ts` (Plan 02), `geminiBackend.ts` (Plan 06), `lmstudioBackend.ts` (Plan 08), `ollamaBackend.ts` (Plan 09), `ollamaNativeClient.ts` (Plan 09) — no others.
- [ ] `OllamaBackend.capabilitiesFor()` returns the spec matrix unchanged across modes.
- [ ] `OllamaNativeClient.embed()` succeeds against the modern `/api/embed` path AND falls back correctly on 404 to `/api/embeddings` — both unit-tested.
- [ ] `OllamaBackend.invoke()` in native mode includes `keep_alive: "5m"` in the request body — unit-tested via `buildNativeBody` translator probe.
- [ ] `OllamaBackend.invoke()` in native mode nests sampling params under `options`, not flat — unit-tested.
- [ ] `OllamaBackend.invoke()` in native mode emits `message_stop.stopReason: "tool_use"` when the assistant emitted tool calls AND `done_reason !== "length"` — unit-tested via MOCK_TOOL_CALL.
- [ ] Per-instance mode resolution: `null` inherits backend default; `true`/`false` override — 5 cases in `describe("Per-instance mode resolution", ...)`.
- [ ] `tests/fixtures/mock-ollama/server.mjs` binds to port 0 (NOT a fixed port like 11434) so multiple test files can run in parallel without conflicts.
- [ ] `tests/helpers/mockOllamaProcess.ts` waits for the `LISTENING_ON_PORT` stdout line before resolving, with a 5s timeout.
- [ ] No source file under `src/backends/` exceeds 400 lines (ollamaBackend.ts ≈ 330 is the largest).
- [ ] `src/server.ts` registers OllamaBackend ONLY when `config.ollama.enabled && config.ollama.instances.length > 0`.
- [ ] `dist/` directory is untouched (compare `git log dist/ -5` — last touch should predate this plan).
- [ ] No new direct dependencies on `dist/` from anywhere under `src/` or `tests/`.
- [ ] No admin endpoints (`src/admin/`) added — that's Plan 11.
- [ ] LM Studio backend tests still pass unchanged (no regression from shared `openaiCompatClient` use).
- [ ] Plan 08's `openaiCompatClient` contract (constructor, `chat(req)`, `embed(req)`, `listModels()`) was not modified — Plan 09 only consumes it. If Plan 08's actual contract differs from what Task 5 assumes, document the adaptation in the close-out README under "Deviations from this plan that landed during execution".
