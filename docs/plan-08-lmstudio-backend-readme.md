# Plan 08 — LM Studio Backend: what shipped

Plan 08 added the first HTTP-client `Backend` implementation on top of the Plan 01 foundation, plus the shared `openaiCompatClient` module that Plan 09 (Ollama in OpenAI-compat mode) will reuse without modification. Multi-instance dispatch lands here; embeddings land here (first backend to flip `capabilities.embeddings` to `true`). Server bootstrap registers `LMStudioBackend` automatically when `config.lmstudio.enabled && config.lmstudio.instances.length > 0`.

## Modules added

| Path | Purpose | Lines (approx.) |
|---|---|---|
| `src/backends/openaiCompatClient.ts` | Shared HTTP client for any OpenAI-shape server (LM Studio + future Ollama compat-mode). Methods: `listModels`, `chatCompletions` (streaming SSE), `chatCompletionsBuffered`, `embeddings`. Error classes: `OpenAICompatHTTPError`, `OpenAICompatTimeoutError`. | ~200 |
| `src/backends/lmstudioBackend.ts` | `Backend` implementation. One `OpenAICompatClient` per configured instance, keyed by name. Multi-instance dispatch with explicit-prefix override (`lmstudio:<instance>/<model>`). `invoke()` translates `NormalizedRequest` <-> OpenAI chat-completions body and normalizes SSE chunks into `NormalizedEvent`s including tool-use round-trip. `embed()` round-trips `POST /v1/embeddings`. | ~340 |
| `src/server.ts` (extended) | `buildRegistry(config)` now registers `LMStudioBackend` when configured. | +12 |

## Test infrastructure added

| Path | Purpose |
|---|---|
| `tests/fixtures/mock-lmstudio/inProcess.ts` | In-process Express server factory. `startMockLmStudio({models, latencyMs, requiredBearer, failChat, failEmbeddings})` returns `{port, url, app, close}`. Behavioral triggers via request-body substring (`MOCK_ERROR`, `MOCK_HANG`, `MOCK_TOOL_USE`). |
| `tests/fixtures/mock-lmstudio/server.mjs` | Standalone runner over the same factory, for manual smoke testing. Not exercised by Vitest. |
| `tests/fixtures/mock-lmstudio/package.json` | Tiny `bin` shim. |
| `tests/unit/backends/openaiCompatClient.test.ts` | HTTP client in isolation. SSE parsing, 4xx/5xx error envelopes, timeouts, bearer propagation, listModels / chatCompletions{,Buffered} / embeddings round-trips. (16 tests) |
| `tests/unit/backends/lmstudioBackend.test.ts` | Capability matrix, model listing, request translation, event normalization, embed round-trip, scope-boundary throws, multi-instance dispatch with explicit-prefix override and failover. (28 tests) |
| `tests/integration/lmstudioBackend.test.ts` | End-to-end through `BackendRegistry`: register, probe two instances, route by model id, embed round-trip, coexistence with `ClaudeBackend`. (4 tests) |

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
| embeddings | false | false | **true** <- first |

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

Within the `BackendRegistry`, `lmstudio` carries a single backend-level priority (`50` by default). Cross-backend model-id collisions (e.g., both LM Studio and Ollama report `llama-3.3-70b`) are resolved by the registry's `BackendId -> number` priority map. Within-`lmstudio` collisions (two instances reporting the same model) are resolved by the per-instance priority field.

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
