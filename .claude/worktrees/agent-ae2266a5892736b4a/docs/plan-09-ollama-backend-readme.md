# Plan 09 — Ollama Backend: what shipped

Plan 09 added the fourth concrete `Backend` implementation on top of the Plan 01 foundation. Unlike Plans 02 (Claude), 06 (Gemini), and 08 (LM Studio), the Ollama backend supports two API surfaces — Ollama's OpenAI-compatibility layer and its native `/api/*` API — selectable per instance via `config.ollama.useNativeApi` (backend default) plus per-instance `instances[*].useNativeApi` override. The implementation reuses Plan 08's `OpenAICompatClient` for compat mode and introduces a new `OllamaNativeClient` for native mode.

## Modules added

| Path | Purpose | Lines (approx.) |
|---|---|---|
| `src/backends/ollamaNativeClient.ts` | HTTP client for `/api/chat`, `/api/embed`, `/api/embeddings` (legacy fallback), `/api/tags`. NDJSON streaming via web-streams `ReadableStream`. | ~260 |
| `src/backends/ollamaBackend.ts` | `Backend` implementation. Multi-instance dispatch, per-instance mode resolution, native-mode request translator + event normalizer, compat-mode dispatch + OpenAI SSE → NormalizedEvent translator (separate from LMStudioBackend's, but shape-identical). | ~580 |
| `src/server.ts` (extended) | Registers `OllamaBackend` at startup when `config.ollama.enabled && instances.length > 0`. | +18 |
| `tests/helpers/mockOllamaProcess.ts` | Shared spawner that starts mock-ollama on a kernel-assigned ephemeral port and waits for the `LISTENING_ON_PORT` announcement. | ~70 |

## Test infrastructure added

| Path | Purpose |
|---|---|
| `tests/fixtures/mock-ollama/server.mjs` | Single `node:http`-based fixture serving BOTH `/api/*` and `/v1/*` surfaces. Binds port 0 so tests can run in parallel without conflicts. Triggers keyed off the last user-message content (`MOCK_ERROR`, `MOCK_TOOL_CALL`, `MOCK_LONG_STREAM`). |
| `tests/fixtures/mock-ollama/package.json` | Bin shim. |
| `tests/unit/backends/ollamaNativeClient.test.ts` | listTags, chat (NDJSON streaming + keep_alive + format:json + 500 errors + timeouts), embed (modern + legacy 404 fallback + caching), chatBuffered — 12 cases. |
| `tests/unit/backends/ollamaBackend.test.ts` | Skeleton (id, capabilities, ctor errors, unreachable surface), per-instance mode resolution (5 cases), listModels (compat / native / dedup / failure-tolerant), invoke compat (4 cases), invoke native including translator helpers (9 cases), embed compat (2 cases), embed native (1 case) — 33 cases. |
| `tests/unit/server.test.ts` (new) | Confirms `OllamaBackend` registers when enabled and does not register when disabled — 2 cases. |
| `tests/integration/ollamaBackend.test.ts` | End-to-end through `BackendRegistry`: two instances (one compat, one native — same fixture twice on different ports), probe, dispatch, embed, countTokens — 5 cases. |

Total Plan 09 additions: **52 new tests**. Baseline 539 → 591 after Plan 09.

Run all: `npx vitest run`.

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
| Image inputs | OpenAI content-parts (vision models) — *currently skipped, see deviations* | `body.messages[].images: [base64, ...]` |
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

## What the next plan (Plan 10 — OpenAI multi-backend extension) needs

- Both LM Studio and Ollama backends registered at startup (Plans 08 and 09 — both done).
- The shared `BackendRegistry` populated with a discovered set of local models from each backend's `listModels()`.
- `OpenAICompatClient` and `OllamaNativeClient` reachable as the underlying transports.

Plan 10 extends `src/openaiShim/embeddings.ts` and the existing `/v1/chat/completions` handler to route via the registry instead of hard-coding the legacy embeddings backend URL. No changes to Plan 09's modules.

## Open questions surfaced during Plan 09

1. **First-class `keep_alive` field on `NormalizedRequest`.** Plan 09 applies a backend-level default of `"5m"` in native mode. Promoting to a request field (so the Anthropic shim can pass a per-request override) is straightforward but waits for a concrete use case.
2. **Real Ollama API version stability.** Plan 09 targets the 2026-05 surface. The legacy `/api/embeddings` fallback exists because some older deployments stay on that path. As Ollama versions go EOL, the fallback can be removed.
3. **Per-model capability narrowing.** The capability matrix is per-backend. Some loaded models lack vision support or tool-calling fidelity. A follow-up could probe `/api/show` per model and narrow `supportsTools` / `supportsVision` on the `ModelDescriptor`.
4. **OpenAI-compat `format: "json"` (response_format) for native-mode parity.** Plan 09 forwards `req.metadata?.format === "json"` only in native mode. Whether the Anthropic shim should be allowed to request JSON-mode against an Ollama compat instance via `response_format: {type: "json_object"}` is a Plan 10 / shim-level decision.
5. **Tool-call id stability across stream chunks.** Some Ollama versions emit tool calls without an `id`. Plan 09 synthesizes `call_${name}_${Date.now()}_${i}`; this is stable for the duration of one stream but not across reruns.
6. **`/api/show` probe for richer ModelDescriptors.** `/api/tags` returns name + family + parameter_size + quantization. Context window, base model, etc., live under `/api/show`. A follow-up plan can swap in `/api/show` for richer descriptions visible in the admin UI.

## Deviations from this plan that landed during execution

> **Summary for the controller:** the principal divergence is the shape of Plan 08's shipped `OpenAICompatClient`. Plan 09's docs assumed a high-level, pre-translated surface; the shipped class is a thin HTTP wrapper. All adaptations were absorbed inside `OllamaBackend.ts` — Plan 08's source was not touched. See the eight numbered items below.

Plan 09's docs assumed an `OpenaiCompatClient` (lowercase-`ai`) with high-level methods `chat(req)`, `embed(req)`, `listModels()` that returned pre-translated `AsyncIterable<NormalizedEvent>` / `NormalizedEmbeddingResponse` / `ModelDescriptor[]`. The shipped Plan 08 `OpenAICompatClient` (uppercase `AI`) is a deliberately thin HTTP wrapper with `chatCompletions(body)`, `chatCompletionsBuffered(body)`, `embeddings(body)`, `listModels()` returning raw OpenAI shapes. The differences and their consequences for Plan 09:

1. **Class name** — Plan 09 was written against `OpenaiCompatClient`; the shipped class is `OpenAICompatClient` (uppercase `AI`). All Plan 09 imports use the actual exported name.
2. **`OpenAICompatClient.chatCompletions(body)`** returns `AsyncIterable<unknown>` (raw OpenAI SSE chunks), NOT `AsyncIterable<NormalizedEvent>`. Plan 09's `OllamaBackend.invokeCompat()` therefore performs its own OpenAI SSE → `NormalizedEvent` translation, structurally identical to `LMStudioBackend.invoke()`'s translator (which also lives at the backend level, not in the shared client). The translator and `buildCompatBody()` helper live in `ollamaBackend.ts` at module scope. This is **a shape change to Plan 09's invokeCompat helper but does not change the public Backend contract.**
3. **`OpenAICompatClient.embeddings(body)`** returns the raw OpenAI `{model, data: [{index, embedding}]}` shape. Plan 09's `OllamaBackend.embed()` in compat mode sorts by `index` and flattens to `NormalizedEmbeddingResponse.embeddings[]` — same pattern LM Studio uses.
4. **`OpenAICompatClient.listModels()`** returns `unknown[]` of raw OpenAI model objects (`{id, object, owned_by, ...}`), NOT pre-built `ModelDescriptor[]`. Plan 09's `probeCompatModels()` maps each entry's `.id` into a minimal `ModelDescriptor` (with conservative `supportsTools: true, supportsVision: true` flags, matching LM Studio's approach).
5. **`buildRegistry` helper name** — Plan 09's docs referred to `buildRegistryFromConfig`; the actual exported helper in `src/server.ts` is `buildRegistry(config)`. Plan 09's server-wiring task and the new `tests/unit/server.test.ts` both use the actual `buildRegistry` name without introducing an alias.
6. **`OpenAICompatClient` was NOT modified** by Plan 09 — Plan 08's shipped surface stayed untouched per the controller's stop-condition. All shape divergence was absorbed at the OllamaBackend layer.
7. **Skeleton "stub throws" tests in `ollamaBackend.test.ts`** were rewritten in Task 7 from the literal `/invoke|Task/` regex to a generic `rejects.toThrow()` because after invoke()/embed() ship, an unreachable-host call surfaces a fetch error message, not the placeholder text. The replacement tests still exercise the same "calling on an unreachable backend doesn't hang" contract.
8. **`tests/fixtures/mock-ollama/server.mjs` uses `node:http`** as documented in Plan 09, even though Plan 08's mock-lmstudio settled on in-process Express via `inProcess.ts`. Plan 09's helper spawns the standalone `server.mjs` and parses `LISTENING_ON_PORT` from stdout — different transport mechanism than Plan 08, but no shared dependency between the two patterns.

No other deviations from the plan's literal task structure, ordering, or commit messages.
