# ClaudeMCP — API Fidelity and Multi-Provider Design

**Date:** 2026-05-16
**Status:** Approved for implementation planning
**Owner:** Prince Rehman Manjee
**Supersedes scope of:** `2026-04-18-claude-mcp-design.md` (extends, does not replace)

## Problem

The shipped ClaudeMCP server exposes one OpenAI-shaped HTTP endpoint (`POST /v1/chat/completions`) plus an MCP transport. It is not a drop-in replacement for the Anthropic Messages API, and even the OpenAI surface is narrow: no `/v1/embeddings`, cosmetic `model` field, prompt-engineered tool calling, no multimodal, no honor for sampling params or `cache_control`. Clients that depend on the official `anthropic` SDK cannot use the server at all; OpenAI-SDK clients can only do basic chat completions. There is also no path to Google Gemini, no path to locally-hosted models running in LM Studio or Ollama, and embeddings are a hand-rolled passthrough proxy with no unifying abstraction.

This design closes those gaps to the extent feasible while preserving the original premise: **no separate cloud API keys** — Claude calls ride the Claude Max subscription via the `claude` CLI, Gemini calls ride the user's Google account (Gemini Pro / Google One AI Premium subscription) via the `gemini` CLI, and any locally-hosted open-source model is reachable via the user's LM Studio or Ollama daemon over HTTP. The server becomes a unified multi-backend local gateway with a single archive of all LLM traffic.

## Goals

- Add a full Anthropic-shaped HTTP surface (`/v1/messages`, files, models, token counting) so `@anthropic-ai/sdk` clients work against the server.
- Add a Google Gemini-shaped HTTP surface (`/v1beta/models/{model}:generateContent` and friends, `/v1beta/files`, `/v1beta/models`) so `@google/generative-ai` SDK clients work against the server.
- Extend the OpenAI shim with `/v1/embeddings` (proxied to a local backend such as LM Studio) so OpenAI-SDK clients have a single base URL.
- Add four backends behind a shared `Backend` interface:
  - **Claude** (existing concept, refactored): spawns `claude` CLI, rides Claude Max subscription.
  - **Gemini** (new): spawns `gemini` CLI, rides Google account auth (`gemini auth login`).
  - **LM Studio** (new): HTTP client to LM Studio's OpenAI-compatible server. Supports multiple instances (local default `:1234`, plus any number of remote LM Studio nodes — e.g., "LM Link"-style cross-machine setups).
  - **Ollama** (new): HTTP client to Ollama's native API (default `:11434`). Defaults to the OpenAI-compatibility layer for code reuse; switches to native API via `config.ollama.useNativeApi: true` when features like `keep_alive`, `format: "json"`, or `raw` mode are needed. Supports multiple instances same as LM Studio.
- The model router selects the backend per request based on requested model ID, with prefix-override syntax (`lmstudio/qwen3-coder-30b`, `ollama/llama-3.3-70b`, plus optional `lmstudio:<instance>/<model>` for disambiguating across instances) and a startup probe that discovers loaded local models on every configured instance.
- Allow any shim to target any backend: an Anthropic-SDK client requesting `model: "qwen3-coder-30b"` runs through LM Studio and gets translated back to Anthropic SSE shape; a Gemini-SDK client requesting `model: "claude-opus-4-7"` runs through the Claude CLI. This falls out of a normalized internal backend contract.
- Make the `model` field functional with passthrough + curated aliases across all backends, plus an opt-in heuristic router and a `reasoning_effort` override that maps to per-backend tiers.
- Honor backend-native features per a documented capability matrix: native `tool_use` round-trip (Anthropic, Gemini, LM Studio, Ollama), multimodal image/document blocks (all four when the underlying model supports vision), `stop_sequences` (native on LM Studio/Ollama, server-side cut on Claude/Gemini), `tool_choice`, `metadata` passthrough, stateless conversation model. Sampling params (`temperature`/`top_p`/`top_k`) are honored on LM Studio/Ollama (where the runtime supports them) and silently ignored on Claude/Gemini CLI backends.
- Unify embeddings under the backend system: route `/v1/embeddings` through whichever backend serves the requested embedding model (typically LM Studio or Ollama). The standalone embeddings-proxy concept is retired.
- Implement local equivalents for features without a backend path: persistent Files API (disk-backed content cache, shared across all backends via content addressing), token counting (backend-aware estimator), response cache (reinterpreted `cache_control`).
- Add a durable request/response archive (SQLite) capturing every call across all backends, for retrospective review and opt-in exact-match reuse.
- Add a localhost-only web admin UI for live backend status, model discovery, and config editing. Uses vanilla HTML + Alpine.js served from the same Node process — no build step.
- Preserve the existing OpenAI chat-completions pipeline behavior — no regressions for current Agent Zero usage.

## Non-goals

- Native API parity for features no backend can honor: Anthropic citations (501), `/v1/messages/batches` (501, backlog), Gemini grounding metadata when targeting Anthropic/OpenAI shims (silently dropped per the hybrid policy).
- Per-backend feature uniformity. The capability matrix is intentionally non-uniform: `temperature`/`top_p`/`top_k` are honored on local backends (LM Studio, Ollama) and silently ignored on cloud CLI backends (Claude, Gemini); `cache_control` reinterpretation is local-only; vision support depends on the chosen model. Shims inspect `backend.capabilities` to decide what to silently drop vs honor per request.
- Fallback to a real cloud API key for unsupported features. The no-API-key premise is preserved even at the cost of fidelity gaps.
- Full internal-pipeline unification across shims. The three shims (Anthropic, OpenAI, Gemini) remain **parallel** at the HTTP-fidelity layer — each shim owns its own request/response translators — because the wire formats differ enough that sharing translation code would create more friction than it removes. **Backends, however, share a normalized internal contract** (see Architecture); this is the necessary departure from full duplication for the 3×4 shim-by-backend matrix.
- Native multimodal / native `tool_use` / `cache_control` in the OpenAI shim. Those features land on the Anthropic and Gemini shims only.
- Reverse-engineering Claude.ai's or Gemini's web APIs, or driving the Claude Desktop / Gemini app programmatically. All considered and rejected as brittle / out-of-scope.
- Auto-loading models in LM Studio or Ollama. The server probes loaded models at startup and rebuilds the map on a configurable interval, but it does not push models into either backend — the user is responsible for loading what they want available. (The admin UI surfaces what is currently loaded; it does not initiate downloads or unloads.)
- Production-grade admin UI. The shipped UI is for personal-use local administration: minimal styling, no role-based auth beyond the shared API key, no audit log of config edits. Hardening for multi-user or public exposure is out of scope.
- Standalone embeddings proxy. Retired in favor of backend-routed embeddings (route by model name).
- Log rotation, multi-user auth, quotas, or public-internet exposure (carried over from the original spec).

## Constraints and assumptions

- Host OS is Windows 11 or macOS on Apple Silicon (arm64). Node.js 20+, TypeScript, Express, `@modelcontextprotocol/sdk`. Same toolchain as the existing implementation. All native dependencies (`better-sqlite3`, `tree-kill`, zstd) ship prebuilt binaries for both platforms — no per-OS code paths required.
- The `claude` CLI is the only authenticated path to Anthropic. Its capability surface is the upper bound on what the server can honor end-to-end for Claude models.
- The `gemini` CLI is the only authenticated path to Google Gemini. Pre-authenticated via `gemini auth login` against the user's personal Google account (which has a Gemini Pro / Google One AI Premium subscription, providing generous quota). Same upper-bound rule applies for Gemini models.
- LM Studio runs on one or more reachable hosts with its OpenAI-compatible server enabled (default local `http://127.0.0.1:1234/v1`). User is responsible for loading the models they want available on each instance; the server discovers loaded models on every instance via `GET /v1/models`.
- Ollama runs on one or more reachable hosts (default local `http://127.0.0.1:11434`). The backend defaults to Ollama's OpenAI-compatibility layer (`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`) for code reuse with the LM Studio backend; instances with `useNativeApi: true` switch to native (`/api/chat`, `/api/embed`, `/api/tags`) to unlock `keep_alive`, `format: "json"`, `raw`, and historically more reliable native tool calling.
- All four backends emit some form of streamable output that can be normalized into a common event format:
  - Claude CLI: `stream-json` (`message_start`, `content_block_delta`, etc.).
  - Gemini CLI: Gemini-shaped `candidates[].content.parts[]` deltas.
  - LM Studio: OpenAI SSE chunks (`data: {...}\n\n`).
  - Ollama (OpenAI-compat mode): OpenAI SSE chunks — adapter shared with LM Studio.
  - Ollama (native mode): NDJSON lines (`{"message": {...}}\n`).
  A small adapter per backend (or per mode for Ollama) produces a unified internal event stream (`NormalizedEvent`).
- All four backends select model via their native mechanism (CLI `--model` flag for Claude/Gemini; `model` request field for LM Studio/Ollama). Unknown model IDs surface as 400 from the backend; the server forwards the error verbatim.
- `better-sqlite3` is acceptable as a native dependency on Windows and macOS. Falls within personal-use scope.
- Existing Windows-specific runtime behavior (50 ms drain on shutdown to release cwd handles) is harmless on macOS and stays as-is rather than being gated behind `process.platform` checks.

## Architecture

Three parallel shims share a normalized backend interface. Four backends implement that interface — two wrap CLI subprocesses (Claude, Gemini), two are HTTP clients to local daemons (LM Studio, Ollama). Shims target the backend interface, never the underlying CLI or HTTP.

```
ClaudeMCP/
├── src/
│   ├── server.ts                    # routes, auth, lifecycle
│   ├── config.ts                    # extended Zod schema (multi-backend)
│   ├── logger.ts                    # JSONL logger (extended fields incl. backend)
│   ├── sessionStore.ts              # unchanged
│   ├── modelRouter.ts               # NEW — backend + model resolution, startup probe
│   ├── fileStore.ts                 # NEW — shared across all backends
│   ├── responseCache.ts             # NEW
│   ├── archive.ts                   # NEW — backend column
│   ├── tokenEstimator.ts            # NEW — backend-aware
│   ├── auth.ts                      # NEW — x-api-key / Bearer / x-goog-api-key
│   ├── backends/                    # NEW — normalized backend contract + impls
│   │   ├── types.ts                 #   Backend interface, capabilities, normalized types
│   │   ├── registry.ts              #   build backend set from config; startup + periodic probe; multi-instance aware
│   │   ├── openaiCompatClient.ts    #   shared HTTP client for any OpenAI-shape server
│   │   ├── claudeBackend.ts         #   wraps claudeRunner; CLI ↔ normalized
│   │   ├── geminiBackend.ts         #   wraps geminiRunner; CLI ↔ normalized
│   │   ├── lmstudioBackend.ts       #   uses openaiCompatClient; per-instance dispatch
│   │   ├── ollamaBackend.ts         #   uses openaiCompatClient (OpenAI-compat mode) OR ollamaNativeClient (native mode); per-instance dispatch
│   │   └── ollamaNativeClient.ts    #   NDJSON streaming + /api/* request shaping
│   ├── runners/                     # NEW — only modules that spawn CLIs
│   │   ├── claudeRunner.ts          #   moved from src/; existing one-shot invoker
│   │   ├── claudeStreamRunner.ts    #   moved from src/; existing streaming invoker
│   │   ├── geminiRunner.ts          #   NEW one-shot invoker for `gemini`
│   │   └── geminiStreamRunner.ts    #   NEW streaming invoker for `gemini`
│   ├── anthropicShim/               # NEW
│   │   ├── messages.ts
│   │   ├── countTokens.ts
│   │   ├── files.ts
│   │   ├── models.ts
│   │   ├── requestTranslator.ts     #   Anthropic request ↔ NormalizedRequest
│   │   ├── responseTranslator.ts    #   NormalizedEvent → Anthropic SSE / final
│   │   └── types.ts
│   ├── openaiShim/                  # existing + new
│   │   ├── handler.ts               # existing
│   │   ├── promptBuilder.ts         # existing
│   │   ├── responseParser.ts        # existing
│   │   ├── streamTranslator.ts      # existing
│   │   ├── embeddings.ts            # NEW — routes to backend by model name
│   │   └── types.ts                 # existing
│   ├── geminiShim/                  # NEW
│   │   ├── generateContent.ts
│   │   ├── countTokens.ts
│   │   ├── files.ts
│   │   ├── models.ts
│   │   ├── requestTranslator.ts
│   │   ├── responseTranslator.ts
│   │   └── types.ts
│   ├── admin/                       # NEW
│   │   ├── archive.ts               # /admin/archive* handlers
│   │   ├── backends.ts              # /admin/backends — discovered models, capability matrix
│   │   ├── config.ts                # /admin/config — read/write config.json with Zod validation
│   │   └── ui.ts                    # /admin/ui — serves static index.html + Alpine.js app
│   ├── admin-ui/                    # NEW — vanilla static assets, no build step
│   │   ├── index.html               # single-page app entry
│   │   ├── app.js                   # Alpine.js components
│   │   ├── styles.css               # minimal CSS (Pico.css starter)
│   │   └── icons/                   # backend logos, status indicators
│   └── tools/                       # existing MCP tools, unchanged
├── configs/
│   ├── default.json                 # extended
│   └── example.json                 # regenerated with _comments
├── data/
│   ├── sessions.json                # existing
│   ├── files/                       # NEW — content-addressed; shared across all backends
│   ├── response-cache.json          # NEW
│   └── archive.sqlite               # NEW
├── scripts/
│   └── archive-prune.ts             # NEW
└── tests/
    ├── unit/                        # extended
    ├── integration/                 # extended — mock CLIs + mock HTTP backends
    └── compat/                      # NEW — real SDK round-trips (3 SDKs × 4 backends)
```

**Backend interface (`src/backends/types.ts`):**

```ts
type BackendId = "claude" | "gemini" | "lmstudio" | "ollama";

interface BackendCapabilities {
  toolUse: boolean;
  multimodal: boolean;             // depends on currently-loaded model; backend reports per-model
  thinking: boolean;
  cacheControl: "native" | "local-emulation" | "none";
  samplingParams: { temperature: boolean; topP: boolean; topK: boolean };
  stopSequences: "native" | "server-side-cut";
  embeddings: boolean;
}

interface Backend {
  readonly id: BackendId;
  capabilitiesFor(model: string): BackendCapabilities;
  listModels(): Promise<ModelDescriptor[]>;
  invoke(req: NormalizedRequest): AsyncIterable<NormalizedEvent>;
  countTokens(req: NormalizedRequest): Promise<number>;
  embed?(req: NormalizedEmbeddingRequest): Promise<NormalizedEmbeddingResponse>;
}
```

`NormalizedRequest` is roughly Anthropic-shaped (chosen because Claude/Gemini CLIs emit close-to-Anthropic content blocks): `{ model, system, messages, tools, toolChoice, stopSequences, maxTokens, samplingParams, multimodalBlocks, ... }`. `NormalizedEvent` is a small union: `{ kind: "message_start" | "text_delta" | "tool_use_start" | "tool_use_delta" | "tool_use_stop" | "message_stop", ... }`. Shims translate to and from these types; backends translate between them and their native protocol (CLI argv/stdout or HTTP JSON).

**Backend registry (`src/backends/registry.ts`):**

- Built at server startup from enabled config blocks. For multi-instance backends (LM Studio, Ollama), each configured instance becomes its own entry in the registry, keyed as `<backend>:<instance-name>` internally and surfaced as a single logical backend ID externally.
- For each instance, calls `listModels()` and merges into a `modelMap: Map<modelId, BackendInstance>`. Collision resolution: instance with higher `priority` wins (config-supplied). Losers remain reachable via fully-qualified prefix syntax (`lmstudio:work-server/qwen3-coder-30b`).
- Re-probes local backends (LM Studio + Ollama, every configured instance) every `config.router.localProbeIntervalMs` (default 60s) to pick up models the user loads/unloads at runtime. Cloud backends are probed once at startup.
- A failing probe logs a warning but does not block startup; instances whose probe failed return 503 at request time until the next successful probe.
- The registry exposes its current state to `/admin/backends` for the UI: per-instance reachability, last successful probe time, loaded models, capability matrix.

**Isolation rules:**

- `src/runners/*` are the only modules that spawn `claude` or `gemini`.
- `src/backends/*` are the only modules that touch external systems — CLI subprocesses or HTTP endpoints — and the only modules that know each backend's native event schema. Shims never see raw CLI output or HTTP responses.
- Shims never know which backend they're targeting beyond the `model` string they pass through the router. The capability matrix is the only backend-specific information that flows back to shims, and it's accessed via `backend.capabilitiesFor(model)`.

**Parallel-shim cost (revised again):** the three shims independently implement request shaping, response shaping, and streaming wire format. Backend-side translators are shared across all shims. This is the explicit trade-off: shim wire formats differ enough (Anthropic SSE event-typed, OpenAI SSE chunked, Gemini SSE JSON-array-style) that sharing translation code would create more friction than it saves, but the 3×4 matrix of (shim × backend) is impractical to fully duplicate, so the backend boundary is normalized.

## Endpoint surface

### Anthropic shim (new)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/messages` | Messages API, streaming + non-streaming |
| POST | `/v1/messages/count_tokens` | Token counting (local estimator) |
| POST | `/v1/files` | Upload (multipart), returns `file_<hash>` |
| GET  | `/v1/files` | List with pagination |
| GET  | `/v1/files/{id}` | Metadata |
| GET  | `/v1/files/{id}/content` | Download bytes |
| DELETE | `/v1/files/{id}` | Delete |
| GET  | `/v1/models` | List Claude models |
| GET  | `/v1/models/{id}` | Model metadata |

### OpenAI shim (existing + new)

| Method | Path | Status |
|---|---|---|
| POST | `/v1/chat/completions` | Existing logic extended to dispatch any backend by resolved model |
| POST | `/v1/embeddings` | NEW — routes through backend registry; backend selected by embedding model name |

`GET /v1/models` is served by the Anthropic shim. The OpenAI SDK's `models.list()` will receive a unified list across all enabled backends (Anthropic-shaped envelope); clients that strictly require OpenAI-shaped model entries can be addressed in a follow-up if it surfaces.

### Gemini shim (new)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1beta/models/{model}:generateContent` | Non-streaming generation |
| POST | `/v1beta/models/{model}:streamGenerateContent` | Streaming generation (SSE) |
| POST | `/v1beta/models/{model}:countTokens` | Token counting |
| GET  | `/v1beta/models` | List models (across all enabled backends, Gemini-shaped entries) |
| GET  | `/v1beta/models/{model}` | Model metadata |
| POST | `/v1beta/files` | Upload (multipart/resumable subset) |
| GET  | `/v1beta/files` | List with pagination |
| GET  | `/v1beta/files/{id}` | Metadata (returns `uri` pointing to the download endpoint below) |
| GET  | `/v1beta/files/{id}:download` | Download bytes |
| DELETE | `/v1beta/files/{id}` | Delete |

The Gemini shim reuses the same underlying `fileStore.ts`; uploads are dedup'd across all shims by SHA-256 content hash. **File ID surface per shim:** Anthropic shim presents IDs as `file_<24hex>`; Gemini shim presents the same underlying hash as `files/<24hex>` (matching Google's convention). `fileStore.resolve()` accepts either form and returns the same content. A file uploaded via the Anthropic API can be referenced from a Gemini request and vice versa, and inlined into a request executed by any backend whose model supports the file type.

### Admin (new)

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/archive` | Paginated list with filters (`backend`, `session`, `model`, `since`, `until`, `status`, `limit`, `offset`) |
| GET | `/admin/archive/{id}` | Full entry with decompressed bodies |
| GET | `/admin/archive/search?q=` | Substring search in request prompts |
| GET | `/admin/backends` | All enabled backend instances with their discovered models, capability matrices, last probe time, last probe status, current reachability |
| POST | `/admin/backends/reprobe` | Force an immediate reprobe of all local backend instances (or a specific instance via `?instance=lmstudio:work-server`) |
| POST | `/admin/backends/test` | Test connectivity to a candidate URL without saving — used by the UI's "Test connection" button when adding an instance |
| GET | `/admin/config` | Full current config JSON (api key redacted to `***`) |
| PUT | `/admin/config` | Replace config; Zod-validated; atomic write to `configs/default.json`; takes effect for new requests immediately, in-flight requests keep their old snapshot |
| PATCH | `/admin/config` | JSON-merge-patch update (preferred from UI for granular edits) |
| GET | `/admin/ui` | Serves the admin SPA static assets (HTML, JS, CSS, icons) |
| GET | `/admin/ui/*` | SPA asset routes |

### MCP transport (existing)

`/sse`, `/message`, `/health` — unchanged.

### Deferred / unsupported

| Path | Disposition |
|---|---|
| `/v1/messages/batches/*` | 501 — backlog |
| Anthropic citations response blocks | 501 when `citations` field present in request |

## Data flow — `POST /v1/messages` (streaming)

1. `auth.ts` validates `x-api-key` / `Authorization: Bearer` / `x-goog-api-key` against `config.apiKey` (constant-time compare).
2. `modelRouter.ts` resolves model and **backend** from the request body, prefix syntax, model map, and optional `reasoning_effort`. Returns `{ resolvedModel, backend, reason }`.
3. `anthropicShim/messages.ts` checks `backend.capabilitiesFor(resolvedModel)` and decides which request fields to honor, which to silently drop, and which to surface as 501.
4. If the request includes `cache_control` blocks, `responseCache.ts` constructs the cache key (backend id is part of the key). On hit, replay as synthetic Anthropic SSE and skip the backend.
5. If `X-Archive-Reuse: exact-match` header is present, `archive.ts` computes the canonical hash and looks for an exact match. On hit, replay as synthetic SSE and skip the backend.
6. `anthropicShim/requestTranslator.ts` resolves any `file_<hash>` references via `fileStore.ts`, inlines image/document content, applies `tool_choice` directive, and produces a `NormalizedRequest`. Sampling params are included in the normalized request but the backend may ignore them per its capability flags.
7. The router-selected backend takes the `NormalizedRequest`, invokes its native transport (`claude` CLI, `gemini` CLI, HTTP POST to LM Studio, HTTP POST to Ollama), and yields `NormalizedEvent`s.
8. `anthropicShim/responseTranslator.ts` converts each `NormalizedEvent` into Anthropic SSE events: `message_start`, `content_block_start`, `content_block_delta` (text or `input_json_delta` for tool args), `content_block_stop`, `message_delta`, `message_stop`. Per-event flush.
9. If `stop_sequences` was set:
   - On backends with `capabilities.stopSequences === "native"` (LM Studio, Ollama), pass the list through; backend honors it.
   - On backends with `capabilities.stopSequences === "server-side-cut"` (Claude, Gemini), the backend's stream runner watches accumulated text content, terminates the child via `tree-kill`, truncates at the match boundary, and yields `message_stop` with `stop_reason: "stop_sequence"`.
10. On completion: `responseCache.ts` stores the assembled response if cacheable; `archive.ts` writes the entry (with backend column); `logger.ts` writes the JSONL line; session store updated if applicable.

Non-streaming follows the same path with the translator buffering all events before responding.

## Data flow — `POST /v1beta/models/{model}:streamGenerateContent`

Mirror of the above but with Gemini-shaped translators. The `{model}` path parameter is the requested model; the router resolves backend from it (`gemini-pro` → gemini backend, `claude-opus-4-7` → claude backend, `qwen3-coder-30b` → lmstudio or ollama via the model map, `ollama/llama-3.3-70b` → forced ollama backend). The response shape uses Gemini's SSE convention. `content_block_delta` normalized events become `candidates[0].content.parts[0]` deltas. `tool_use` events become Gemini `functionCall` parts.

## Data flow — `POST /v1/chat/completions`

Behavior preserved bit-for-bit from existing implementation **for Claude-backed requests**. For other backends (Gemini, LM Studio, Ollama), the existing OpenAI shim invokes the selected backend via the same path it currently uses for Claude. Multimodal/tool_use/cache_control enhancements still do not land in this shim.

## Data flow — `POST /v1/embeddings`

`openaiShim/embeddings.ts` validates auth, resolves the embedding model to a backend via the registry (prefix syntax accepted), and calls `backend.embed(...)`. If the backend does not implement `embed()` (e.g., model resolves to Claude), responds 400 with "model does not support embeddings." Backend errors → 502 with `api_error`. Backend timeout → 504. The legacy passthrough proxy is gone.

If `config.embeddings.legacyBackendUrl` is set (back-compat for installations migrating from the old proxy), all `/v1/embeddings` requests bypass the registry and route to that URL verbatim. Logs a deprecation warning at startup.

## Feature mechanics

### Model router (`modelRouter.ts`)

**Inputs:** `model` (optional), `reasoning_effort` (optional), prompt-token estimate, tool-definition count, multimodal-block presence, `thinking` flag, `config.router.defaultBackend`, the `modelMap` from the backend registry.

**Resolution order:**

1. **Backend identification:**
   - **Prefix override** wins first. If `model` starts with `<backendId>/` (`lmstudio/`, `ollama/`, `claude/`, `gemini/`), that backend is forced. The rest of the string is the model id to forward.
   - **Cloud-CLI alias rules** (kept for ergonomics):
     - `opus`, `sonnet`, `haiku`, or any `claude-*` → claude.
     - `pro`, `flash`, `flash-lite`, or any `gemini-*` → gemini.
   - **Sentinel values:** `auto`, `claude-code-cli`, `gemini-cli`, or absent → `config.router.defaultBackend` (default `"claude"`). The two `*-cli` sentinels force their respective backend regardless of `defaultBackend`.
   - **Otherwise:** look up `model` in `modelMap` (built from local backend probes). On match, that backend wins. On no match → 400 with a helpful error listing all currently-known model ids per backend.
2. **Model resolution within the chosen backend:**
   - If `model` is a literal id or alias known to the backend → passthrough.
   - Else if `reasoning_effort` is set → map per `config.router.reasoningEffortMap[backend]`:
     - Claude: low → haiku, medium → sonnet, high → opus
     - Gemini: low → flash-lite, medium → flash, high → pro
     - LM Studio / Ollama: low / medium / high mapped to entries in `config.router.reasoningEffortMap[backend]` (user-configured, since local model lineup varies; defaults left empty and the heuristic below is used if no map entry).
   - Else → heuristic. For cloud backends (Claude, Gemini) the heuristic uses the existing token/tool/multimodal thresholds. For local backends, the heuristic returns the backend's *currently-loaded* model with the largest declared context window that satisfies the request size; if none qualifies, returns the largest available and lets the underlying runtime decide.
3. Thresholds, alias maps, `defaultBackend`, and prefix-override syntax are configurable.

**Output:** `{ resolvedModel: string, backend: Backend, reason: string }`. Both `backend.id` and `reason` are persisted to logs and the archive entry for observability.

### File store (`fileStore.ts`)

- **Storage:** `config.files.dir` (default `data/files/`). One file per upload, named by `sha256(bytes)`.
- **Metadata sidecar:** `<hash>.json` adjacent to the content file: `{ id, filename, mime, size, createdAt, lastAccessedAt }`.
- **ID format:** `file_<first-24-hex-of-sha256>`. Shape mirrors Anthropic's `file_xxx` IDs; opaque to clients.
- **Dedup:** identical content uploaded twice returns the same ID (the existing entry's `filename` is not overwritten).
- **Eviction:** background sweep every 5 minutes (shared timer with session sweep). TTL from `lastAccessedAt` (`config.files.ttlMs`, default 7 days). After TTL pass, if total size > `config.files.maxTotalBytes` (default 5 GB), evict LRU by `lastAccessedAt` until under cap.
- **Resolution:** when `requestTranslator` encounters a content block referencing `file_<hash>`, it loads bytes from the store and inlines them as base64 image/document content for the CLI. `lastAccessedAt` is bumped.
- **Missing file:** 400 `invalid_request_error` (Anthropic-shaped).

### Response cache (`responseCache.ts`)

- **Trigger:** request includes at least one content block with `cache_control: { type: "ephemeral" }`.
- **Key:** SHA-256 of canonicalized `(backend.id, resolvedModel, system, cacheable-prefix, tail, tools, tool_choice)`. Canonicalization: JSON stringification with sorted object keys and Unicode-normalized strings. The cacheable prefix ends at the last `ephemeral` block; everything after is the tail. `backend.id` is part of the key so the same logical request to different backends produces different cache entries.
- **Value:** the full non-streaming response body.
- **Storage:** in-memory `Map` mirrored to `config.cache.file` (default `data/response-cache.json`) with the same atomic-write discipline as the session store.
- **Eviction:** TTL (`config.cache.ttlMs`, default 1 hour) and max-entries LRU (`config.cache.maxEntries`, default 500).
- **Streaming replay:** synthetic SSE events synthesized from the cached final response so clients see identical event shape.
- **Reported tokens:** `cache_creation_input_tokens` and `cache_read_input_tokens` populated from the local estimator. Doc'd as estimates in README — not byte-identical to Anthropic's accounting.

### Archive (`archive.ts`)

- **Storage:** SQLite via `better-sqlite3` at `config.archive.dbPath` (default `data/archive.sqlite`).
- **Schema:**
  ```sql
  CREATE TABLE entries (
    id              INTEGER PRIMARY KEY,
    request_hash    TEXT NOT NULL,
    log_id          TEXT NOT NULL,
    endpoint        TEXT NOT NULL,
    backend         TEXT NOT NULL,   -- 'claude' | 'gemini' | 'lmstudio' | 'ollama'
    model_resolved  TEXT,
    session_id      TEXT,
    timestamp       TEXT NOT NULL,
    status          TEXT NOT NULL,
    duration_ms     INTEGER,
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    request_body    BLOB NOT NULL,   -- zstd-compressed JSON
    response_body   BLOB NOT NULL    -- zstd-compressed JSON
  );
  CREATE INDEX idx_hash     ON entries(request_hash);
  CREATE INDEX idx_time     ON entries(timestamp);
  CREATE INDEX idx_session  ON entries(session_id);
  CREATE INDEX idx_backend  ON entries(backend);
  ```
- **What gets archived:** every request/response on `/v1/messages`, `/v1/chat/completions`, `/v1/messages/count_tokens`, `/v1/embeddings`, `/v1beta/models/*:generateContent`, `/v1beta/models/*:streamGenerateContent`, `/v1beta/models/*:countTokens`. Errors and timeouts archived. File operations and model listings excluded.
- **Compression:** zstd at `config.archive.compressionLevel` (default 3). Decompressed lazily by admin endpoints.
- **Reuse trigger:** opt-in header `X-Archive-Reuse: exact-match`. Default `never`. Header is transport-level so it works identically across both shims without polluting request bodies.
- **Hash key:** canonical SHA-256 of `(backend.id, resolvedModel, system, messages, tools, tool_choice, max_tokens)`. Canonicalization: same scheme as the response cache (sorted-key JSON, Unicode-normalized). Sampling params (`temperature`, `top_p`, `top_k`), `metadata`, and stream flag are **excluded** so they don't fragment hits. `backend.id` is part of the key so requests routed to different backends are not conflated.
- **Stream replay on hit:** the calling shim's `responseTranslator` synthesizes an SSE event stream in *its own* wire format (Anthropic SSE for `/v1/messages`, Gemini SSE for `/v1beta/.../:streamGenerateContent`, OpenAI SSE for `/v1/chat/completions`) from the archived final response. The archive stores the final response in its original shim format; if a Gemini-archived response is replayed for an Anthropic-shim request that hit the same hash key, the response is first parsed back into a `NormalizedRequest`-shaped intermediate and then re-rendered. This cross-shim replay case only occurs when the hash key collides (same backend, same model, same canonical content) — orthogonal to the archive's per-shim storage of the original response shape.
- **Retention:** forever by default. Manual prune via `scripts/archive-prune.ts --before YYYY-MM-DD` or `--session <id>`.
- **Independence from response cache:** archive hits never promote into the L1 cache. The two paths are orthogonal opt-ins.

### Token estimator (`tokenEstimator.ts`)

- Implements `/v1/messages/count_tokens` (Anthropic shape) and `/v1beta/models/{model}:countTokens` (Gemini shape). Returns shim-shaped response: `{ input_tokens }` for Anthropic, `{ totalTokens }` for Gemini.
- Backend-aware tokenizer dispatch:
  - Claude backend → `@anthropic-ai/tokenizer` if available, else `Math.ceil(charCount / 4)` fallback.
  - Gemini backend → `@google/generative-ai`'s tokenizer if available, else char/4 fallback.
  - LM Studio / Ollama backends → call the backend's own `countTokens` (`backend.countTokens(req)`), which proxies to LM Studio's `/v1/chat/completions` with `max_tokens: 0` or Ollama's `/api/show` for tokenizer metadata. If the backend can't count, fall back to char/4.
- Same estimator powers the response-cache token-accounting fields.
- README documents the accuracy caveat — these are estimates unless the backend's native tokenizer is reachable.

### Stop sequences

Handled per backend, based on `capabilities.stopSequences`:

- **Native** (LM Studio, Ollama): pass the `stop_sequences` list into the request body (`stop: [...]`). The backend's runtime handles termination; the resulting `NormalizedEvent` `message_stop` already carries `stop_reason: "stop_sequence"`.
- **Server-side-cut** (Claude, Gemini): the backend's stream runner maintains a rolling tail buffer of `max(stop_seq.length) - 1` bytes across stream chunks. On each new text-content chunk, it searches `(tail + chunk)` for any stop sequence. On match: terminate the CLI subtree via `tree-kill`, truncate accumulated text at the match start, emit `message_stop` with `stop_reason: "stop_sequence"`.

In both paths, the shim's `responseTranslator` renders the stop event in its wire format.

### Tool calling — native round-trip

All four backends support native tool calling via the normalized `NormalizedEvent` `tool_use_*` events. Capability gating (`capabilities.toolUse`) lets shims fall back gracefully when the currently-loaded local model doesn't support function calling.

- **Claude backend**: client `tools` array passed to CLI's tool-definition format. `stream-json` emits `tool_use` content blocks natively. Follow-up `tool_result` blocks re-inlined.
- **Gemini backend**: client `tools` array passed to `gemini` CLI's function-declaration format. CLI stream emits `functionCall` parts. Follow-up `functionResponse` parts re-inlined.
- **LM Studio backend**: client `tools` array passed as OpenAI `tools` in `/v1/chat/completions`. Response contains `tool_calls` on the choice; backend normalizes. Follow-up `tool` role messages re-inlined.
- **Ollama backend**: client `tools` array passed as `tools` in `/api/chat`. Response contains `message.tool_calls`; backend normalizes. Follow-up `tool` role messages re-inlined.
- **Anthropic shim**: outputs `tool_use` content blocks regardless of which backend executed.
- **Gemini shim**: outputs `functionCall` parts regardless of which backend executed.
- **OpenAI shim**: retains today's prompt-engineered emulation. Not backfilled per the parallel-shim decision.

### `tool_choice` enforcement

System-prompt directives appended based on `tool_choice`:

| Value | Directive appended |
|---|---|
| `auto` (default) | (none) |
| `any` | "You must call exactly one tool this turn." |
| `none` | "Do not call any tools this turn." |
| `{ type: "tool", name: "X" }` | "If you call a tool, only call `X`." |

Best-effort enforcement — the model usually honors but is not guaranteed.

## Admin UI (`src/admin/ui.ts` + `src/admin-ui/`)

A single-page web admin served from the same Node process. Vanilla HTML + Alpine.js + Pico.css — no build step, no React, no bundler. Adds one runtime dep (Alpine via CDN-pinned ESM import) and ships ~500 LOC of frontend.

**Pages / sections** (single SPA, tab-switched):

1. **Dashboard** — backend instances at a glance: reachability dot (green/yellow/red), last probe time, currently-loaded models, request counts in last hour.
2. **Backends** — per-instance config editor. For each backend block:
   - Enable/disable toggle.
   - Add/remove instances (HTTP backends only).
   - Edit `baseUrl`, `apiKey`, `priority`, `timeoutMs`, `useNativeApi` per instance.
   - "Test connection" button (calls `POST /admin/backends/test`).
   - Live-discovered model list per instance, with refresh button.
3. **Router** — `defaultBackend` dropdown (populated from currently-enabled backends), threshold fields, per-backend `reasoningEffortMap` editor (dropdowns populated from discovered models so the user can't typo a model name).
4. **General** — `apiKey` (write-only, masked display), archive/cache/files paths and limits, admin-UI binding toggle.
5. **Archive viewer** — paginated table backed by `/admin/archive`, with filters and detail modal.

**Auth flow:**

- UI is served at `GET /admin/ui` regardless of auth — but the page is just a login prompt until the user supplies the API key.
- Login posts the API key once; server validates and sets an HttpOnly session cookie with `config.adminUi.sessionTtlMs` lifetime.
- Subsequent `/admin/*` calls (config, backends, archive) accept either the session cookie or the standard `x-api-key` header.
- `config.adminUi.bindLocalhost: true` (default) rejects any UI request whose remote address is not `127.0.0.1` / `::1` with a 403. Disabling this is opt-in and surfaces a startup warning.

**Discovery & live state:**

- UI polls `/admin/backends` every 5 seconds for reachability + model lists.
- Backends section only offers a backend as "selectable" in dropdowns (router, embeddings model selection) if at least one of its instances has a successful recent probe.
- Adding a new instance + clicking "Save" triggers an immediate reprobe of just that instance (via `?instance=<id>`) so the model list populates without waiting for the periodic sweep.

**Config edits:**

- Each form section has explicit Save / Discard buttons. No autosave.
- Save sends `PATCH /admin/config` with the changed subtree only.
- Server applies Zod validation. On failure, UI renders the error inline against the offending field.
- On success, the UI re-fetches `/admin/config` and rerenders.

**No build step rationale:** Alpine.js (~13 KB minified) is loaded via a pinned CDN URL with SRI. Vanilla HTML/CSS/JS files live in `src/admin-ui/` and are served as static assets. Zero npm-side frontend toolchain (no Vite, Webpack, TypeScript-for-frontend, JSX). This keeps the project deployable as a single `node dist/server.js` invocation with no preceding `npm run build` of a UI.

## Auth (`auth.ts`)

- Single shared `config.apiKey`. Accept via any of:
  - `x-api-key: <key>` (Anthropic SDK)
  - `Authorization: Bearer <key>` (OpenAI SDK)
  - `x-goog-api-key: <key>` (Google GenerativeAI SDK)
  - `?key=<key>` query string (Google GenerativeAI SDK fallback for `GET` operations)
- Constant-time comparison.
- 401 error body shape matches the called endpoint family:
  - Anthropic-shaped on `/v1/messages*`, `/v1/files*`, `/v1/models*`, `/admin/*`.
  - OpenAI-shaped on `/v1/chat/completions`, `/v1/embeddings`.
  - Gemini-shaped on `/v1beta/*`.
- Migration: existing `config.openai.requireAuthHeader` is honored if `config.apiKey` is unset; deprecation warning logged on startup. To be removed in a future cleanup spec.

## Config schema additions

```jsonc
{
  // ... existing fields preserved ...
  "apiKey": "<required-string>",   // no default shipped; startup fails if missing

  // Backend blocks. CLI backends (claude, gemini) have a single config.
  // HTTP backends (lmstudio, ollama) support multiple instances.
  "claude": {
    "enabled":   true,
    "command":   "claude",
    "priority":  100,
    "timeoutMs": 600000
  },
  "gemini": {
    "enabled":   true,
    "command":   "gemini",
    "priority":  90,
    "timeoutMs": 600000
  },
  "lmstudio": {
    "enabled":   true,
    "instances": [
      {
        "name":      "local",                       // unique within backend
        "baseUrl":   "http://127.0.0.1:1234/v1",
        "apiKey":    "",                            // optional bearer
        "priority":  50,
        "timeoutMs": 300000
      }
      // additional remote instances appended here for "LM Link"-style multi-host setups
    ]
  },
  "ollama": {
    "enabled":      true,
    "useNativeApi": false,                          // false → /v1/*, true → /api/*
    "instances": [
      {
        "name":         "local",
        "baseUrl":      "http://127.0.0.1:11434",   // root URL; useNativeApi decides path suffix
        "priority":     40,
        "timeoutMs":    300000,
        "useNativeApi": null                        // null → inherit from backend block; true/false overrides per-instance
      }
    ]
  },

  "router": {
    "defaultBackend":         "claude",   // claude | gemini | lmstudio | ollama
    "localProbeIntervalMs":   60000,
    "thresholds": {
      "opusPromptTokens":   50000,
      "opusToolCount":      5,
      "sonnetPromptTokens": 5000
    },
    "reasoningEffortMap": {
      "claude": { "low": "claude-haiku-4-5", "medium": "claude-sonnet-4-6", "high": "claude-opus-4-7" },
      "gemini": { "low": "gemini-flash-lite", "medium": "gemini-flash",     "high": "gemini-pro" },
      "lmstudio": {},   // empty → heuristic; user can populate with e.g. {"high": "qwen3-coder-30b"}
      "ollama":   {}
    }
  },

  "files": {
    "dir":           "data/files",
    "ttlMs":         604800000,
    "maxTotalBytes": 5368709120
  },

  "cache": {
    "file":       "data/response-cache.json",
    "ttlMs":      3600000,
    "maxEntries": 500
  },

  "archive": {
    "dbPath":           "data/archive.sqlite",
    "compressionLevel": 3
  },

  "embeddings": {
    "legacyBackendUrl": "",         // back-compat only; if set, /v1/embeddings bypasses registry
    "legacyApiKey":     "",
    "legacyTimeoutMs":  30000
  },

  "adminUi": {
    "enabled":        true,
    "bindLocalhost":  true,         // refuse non-127.0.0.1 / non-::1 requests when true
    "sessionTtlMs":   3600000       // browser cookie TTL after UI login
  }
}
```

- Validated via Zod on startup and on every UI-driven update; fail-fast with clear errors.
- If a backend block has `enabled: false`, requests routed to it return 503 with a clear "backend disabled" message; the router does not auto-fall-back to a different backend.
- For multi-instance backends, `instances` must be a non-empty array when the backend block is enabled. Each instance must have a unique `name` within its backend.
- `priority` resolves model-id collisions in the registry (e.g., if both LM Studio and Ollama report `llama-3.3-70b` loaded, or two LM Studio instances both report it). Higher number wins; the loser is reachable via fully-qualified prefix syntax (`lmstudio:work-server/llama-3.3-70b`).
- Env-var overrides: `CLAUDE_MCP_API_KEY`, `CLAUDE_MCP_ARCHIVE_DB_PATH`, `CLAUDE_MCP_ADMIN_UI_ENABLED`, plus per-CLI-backend `CLAUDE_MCP_CLAUDE_COMMAND`, `CLAUDE_MCP_GEMINI_COMMAND`. Multi-instance HTTP backends are env-configured via JSON-encoded arrays (`CLAUDE_MCP_LMSTUDIO_INSTANCES='[{"name":"local","baseUrl":"..."}]'`) when CLI-style overrides would be too clumsy.
- `configs/example.json` regenerated with a sibling `_comments` block per knob.
- Config writes from the admin UI use atomic write-and-rename to `configs/default.json` (same discipline as the session store). In-flight requests retain their config snapshot; new requests see the updated values.

## Error policy

| Condition | HTTP | Body shape | Notes |
|---|---|---|---|
| Missing/invalid auth | 401 | Per-shim | Constant-time compare |
| Invalid request body | 400 | Per-shim | Zod validation surfaced |
| `model` not in any backend's catalog | 400 | `invalid_request_error` | Error lists known model ids per backend |
| Sampling params on cloud-CLI backend | 200, ignored | Field absent from echo | Per `capabilities.samplingParams` |
| Sampling params on LM Studio / Ollama | 200, honored | — | Passed through to runtime |
| Anthropic `citations` requested | 501 | `not_implemented_error` | Hybrid policy |
| Gemini `groundingMetadata` requested on non-Gemini backend | 200, dropped | Field absent | Per capability |
| Gemini `safetyRatings` on non-Gemini backend | 200, synthesized | Default safe values | Real ratings only when Gemini executes |
| `tool_use` requested but backend doesn't support | 200, falls back to prompt-engineered | Marker in `_meta` | Per `capabilities.toolUse` |
| `/v1/messages/batches*` | 501 | `not_implemented_error` | Backlog |
| Embedding model resolves to non-embedding backend | 400 | `invalid_request_error` | "model does not support embeddings" |
| CLI spawn failure | 502 | `api_error` | Existing behavior preserved |
| CLI non-zero exit | 502 | `api_error` | stderr forwarded |
| CLI timeout | 504 | `api_error` | `status: "timeout"` in log/archive |
| HTTP backend connection refused | 502 | `api_error` | "backend unreachable: <name> at <url>" |
| HTTP backend non-2xx | 502 | `api_error` | Forwarded body |
| HTTP backend timeout | 504 | `api_error` | `config.<backend>.timeoutMs` |
| Backend disabled in config | 503 | `api_error` | "backend disabled: <name>" |
| Backend probe failed at startup, still probing | 503 | `api_error` | "backend not yet ready: <name>" |
| Stop sequence matched | 200 | `stop_reason: "stop_sequence"` | Partial output returned |
| File `file_<hash>` not found | 400 | `invalid_request_error` | Per-shim |
| Archive reuse miss | proceed normally | — | Header ignored when no match |

## Logging additions

New JSONL fields (existing fields preserved for back-compat):

- `endpoint` — full URL path
- `backend` — `"claude"` | `"gemini"` | `"lmstudio"` | `"ollama"`
- `modelRequested` — what the client asked for
- `modelResolved` — what the router picked
- `routerReason` — heuristic / prefix / map-hit explanation
- `archiveHit` — `"exact-match"` | `false`
- `cacheHit` — `"hit"` | `"miss"` | `"n/a"`
- `capabilitiesDropped` — array of feature names silently dropped due to backend capability gap (e.g., `["temperature", "topP"]` when Claude is the backend)

`tool` field gains values: `messages`, `count_tokens`, `embeddings`, `files`, `models`, `generate_content`, `gemini_count_tokens`, `gemini_files`, `gemini_models` (alongside existing `claude_ask`, `claude_task`, `openai_completion`).

## Testing

**Unit (`tests/unit/`):**

- `modelRouter.test.ts` — every resolution branch for all four backends, prefix-override syntax, collision resolution via priority, alias maps, defaultBackend override, heuristic boundaries per backend, config-override.
- `backends/registry.test.ts` — startup probe success/failure paths, periodic reprobe, model-map rebuild on backend toggle, priority-based collision resolution.
- `fileStore.test.ts` — upload returns stable ID, dedup, metadata round-trip, TTL/LRU eviction, missing-file 400, file uploaded via one shim resolvable from any other shim.
- `responseCache.test.ts` — backend.id in key, cacheable-prefix boundary at last `ephemeral` block, streaming replay synthesizes SSE correctly, TTL + max-entries eviction.
- `archive.test.ts` — every endpoint archived with correct backend tag, hash canonicalization excludes sampling params, exact-match reuse respects backend boundary, prune script.
- `tokenEstimator.test.ts` — per-backend dispatch, fallbacks when tokenizer unavailable, count agrees with backend's own count within tolerance.
- `auth.test.ts` — `x-api-key`, Bearer, `x-goog-api-key`, `?key=` query — all three shim error shapes.
- `backends/claudeBackend.test.ts` — mock CLI events → `NormalizedEvent`s; `NormalizedRequest` → CLI argv. Capabilities reflect Claude.
- `backends/geminiBackend.test.ts` — same, for Gemini CLI.
- `backends/lmstudioBackend.test.ts` — mock HTTP server emits OpenAI SSE → `NormalizedEvent`s; `NormalizedRequest` → OpenAI request body. Honors sampling params. Multi-instance routing. `embed()` round-trip.
- `backends/ollamaBackend.test.ts` — exercises both modes:
  - OpenAI-compat mode: mock server emits OpenAI SSE.
  - Native mode: mock server emits NDJSON; `NormalizedRequest` → `/api/chat` body with `options.*` nested sampling params, `keep_alive` honored, `format: "json"` when caller sets JSON mode.
- `backends/openaiCompatClient.test.ts` — shared HTTP client behavior used by both LM Studio and Ollama (OpenAI-compat mode): SSE parsing, header forwarding, error mapping.
- `backends/ollamaNativeClient.test.ts` — NDJSON streaming, `/api/tags` model discovery, `/api/embed` embeddings.
- `admin/config.test.ts` — GET redacts apiKey, PUT replaces with Zod validation, PATCH merge-patches, atomic write, in-flight requests retain snapshot.
- `admin/ui.test.ts` — localhost-bind enforcement, login → cookie issuance, cookie → subsequent auth, expired cookie → 401.
- `anthropicShim/{requestTranslator,responseTranslator}.test.ts` — as before.
- `geminiShim/{requestTranslator,responseTranslator}.test.ts` — as before.
- `openaiShim/embeddings.test.ts` — backend-routing logic, prefix syntax, "model does not support embeddings" 400, legacyBackendUrl override path.
- `capabilityGating.test.ts` — shim drops fields per backend capability; `capabilitiesDropped` field populated in log entry.

**Integration (`tests/integration/`):** uses mock CLIs (`mock-claude`, `mock-gemini`) on PATH plus mock HTTP servers for LM Studio and Ollama (configured via single-instance `config.lmstudio.instances[0].baseUrl` / `config.ollama.instances[0].baseUrl`; multi-instance scenarios spin up additional mock servers). Real SQLite, disk file store, real cache.

- `messages.integration.test.ts` — streaming + non-streaming on `/v1/messages`, with/without tools, with/without images, parameterized over all four backends.
- `generateContent.integration.test.ts` — same matrix for Gemini shim endpoints.
- `chatCompletions.integration.test.ts` — same matrix for OpenAI shim endpoint.
- `crossBackend.integration.test.ts` — every (shim × backend) pair: 3 × 4 = 12 combos. Spot-check that request/response wire formats remain correct regardless of which backend executes.
- `routerProbe.integration.test.ts` — `/admin/backends/reprobe` updates the model map; collision resolution honors priority; prefix override bypasses the map.
- `files.integration.test.ts` — upload via Anthropic shim → reference from Gemini shim → both succeed against the same content-addressed cache. Then reference from a LM Studio-backed Anthropic-shim call (where the model supports vision).
- `archive.integration.test.ts` — request → archived with backend tag → reuse via header replays without invoking the backend; backend-filter admin queries work.
- `cache.integration.test.ts` — `cache_control` round-trip; same logical request against different backends does not collide.
- `embeddings.integration.test.ts` — route to LM Studio for one model id, Ollama for another, 400 for a Claude-mapped model. Legacy override path covered separately.
- `auth.integration.test.ts` — all three header schemes, all three shim error shapes.
- `backendDisabled.integration.test.ts` — disable each backend in turn; requests routed there return 503; others still succeed.
- `multiInstance.integration.test.ts` — two LM Studio mock servers + two Ollama mock servers with overlapping model ids; priority-based collision resolution; fully-qualified prefix routes to the loser; periodic reprobe picks up a model added to a previously-empty instance.
- `ollamaNative.integration.test.ts` — same scenario set as `ollamaBackend.test.ts` but end-to-end through the server; verifies `useNativeApi: true` flag flips client correctly.
- `adminUi.integration.test.ts` — localhost-bind enforcement, login flow, config GET/PUT/PATCH lifecycle, in-flight request snapshot semantics. Headless browser optional; HTTP-level test is sufficient.

**Compatibility (`tests/compat/`) — new:**

Real SDK clients pointed at the running server with mock backends. Highest-signal "1:1 replacement" verification. Each SDK is parameterized over the backends it can plausibly reach.

- `anthropic-sdk.test.ts` — `messages.create` (stream + non-stream), `messages.countTokens`, full `files.*` lifecycle, `models.list`. Matrix: × {claude, gemini, lmstudio, ollama}.
- `openai-sdk.test.ts` — `chat.completions.create` regression, `embeddings.create` (LM Studio + Ollama only). Matrix: × {claude, gemini, lmstudio, ollama} for chat; × {lmstudio, ollama} for embeddings.
- `google-generative-ai-sdk.test.ts` — `generateContent`, `generateContentStream`, `countTokens`, `getModel`, full `files.*` lifecycle. Matrix: × {claude, gemini, lmstudio, ollama}.

**Manual smoke (`docs/smoke-test.md`):** extended with curl examples per shim (Anthropic, OpenAI, Gemini) and per backend (Claude CLI, Gemini CLI, LM Studio HTTP, Ollama HTTP).

**Coverage target:** ~80% line coverage in CI. Streaming edges and Windows process-tree teardown stay below the bar.

## Migration / back-compat notes

- Existing `POST /v1/chat/completions` behavior is preserved bit-for-bit for Claude-backed requests. Current Agent Zero deployments require no client changes.
- `config.claudeCommand` migrates to `config.claude.command`. Old field honored as fallback; deprecation warning logged. Removed in a future cleanup spec.
- `config.openai.requireAuthHeader` honored as fallback for `config.apiKey`; deprecation warning logged.
- `config.embeddings.backendUrl` / `apiKey` / `timeoutMs` migrate to `config.embeddings.legacyBackendUrl` / `legacyApiKey` / `legacyTimeoutMs` with identical semantics (proxy bypass). Setting the legacy fields logs a deprecation warning urging migration to backend-routed embeddings (`config.lmstudio.enabled: true`).
- Each backend's `enabled` flag defaults to `true`. If the associated CLI is not installed or the HTTP daemon is unreachable, startup proceeds with a warning; requests routed there return 503 at runtime until the backend becomes available. To pre-empt at startup, set `enabled: false` for any backend you don't intend to use.
- Existing JSONL log fields preserved; analysis scripts continue to work. New `backend` field defaults to `"claude"` when absent (back-compat with pre-multi-backend entries).
- Existing session-store file format unchanged.

## Implementation phasing note

The scope is large enough that the implementation plan will likely break into phases — a plausible sequencing:

1. **Foundation**: auth, backend interface types, capability matrix, archive schema, model router (backend-aware), registry skeleton.
2. **Claude backend refactor**: move existing `claudeRunner.ts` / `claudeStreamRunner.ts` behind the `Backend` interface; no behavior change.
3. **Anthropic shim core**: `/v1/messages` (streaming + non-streaming), `/v1/models`, `/v1/messages/count_tokens`.
4. **Native tool_use + multimodal**: Anthropic shim, Claude backend.
5. **Files + response cache + archive**: cross-cutting features.
6. **Gemini backend**: `geminiRunner.ts`, `geminiStreamRunner.ts`, `geminiBackend.ts`.
7. **Gemini shim**: `/v1beta/models/*` endpoints, native function-calling.
8. **LM Studio backend**: `lmstudioBackend.ts` HTTP client; `/v1/models` probe; chat completions and embeddings paths.
9. **Ollama backend**: `ollamaBackend.ts` HTTP client; `/api/tags` probe; chat and embeddings paths via native API.
10. **OpenAI shim multi-backend extension**: `chat/completions` dispatches any backend; `embeddings` routes via registry.
11. **Admin endpoints**: `/admin/archive*`, `/admin/backends*`, `/admin/config*`.
12. **Admin UI**: vanilla HTML + Alpine.js SPA, login flow, dashboard, backend editor, router editor, archive viewer.
13. **Compat tests**: all three SDKs × all four backends (full matrix).

Phasing belongs in the implementation plan, not this spec.

## Open questions / future work

- **Real tokenizer dependencies.** Anthropic, Gemini, LM Studio, and Ollama all have different tokenizers. We dispatch per backend, but the libraries (e.g., `@anthropic-ai/tokenizer`, `@google/generative-ai`) may not exist at implementation time. Char/4 fallback ships with a documented caveat; follow-up spec swaps in real tokenizers as they become available.
- **CLI output-format stability.** Native `tool_use` round-trip on Claude/Gemini backends depends on each CLI's stream output continuing to emit recognizable tool blocks. The relevant backend is the single point of repair.
- **LM Studio / Ollama API stability.** Both projects evolve quickly. Backend integrations target current API as of 2026-05; breakage from future versions handled in the per-backend module.
- **`/v1/messages/batches`.** Backlog. Implement when a concrete use case appears.
- **Anthropic citations.** No path through any current backend. Reserved.
- **Gemini grounding / safety ratings on non-Gemini backends.** Synthesized defaults. Documented in README.
- **OpenAI shim feature parity.** Multimodal, native `tool_use`, and `cache_control` on the OpenAI side are not in this spec.
- **Cross-vendor model aliases.** `gpt-4` → sonnet etc. not implemented. Add if a client requires it.
- **Additional backends.** The `Backend` interface makes adding a fifth backend (xAI Grok via API key, vLLM, Together AI, etc.) a matter of writing one module. Out of scope here.
- **Embeddings via Gemini.** Gemini does have `text-embedding-004`. Currently embedding is supported only on LM Studio and Ollama. Could be extended when the Gemini CLI exposes an embeddings subcommand.
- **Per-model capability overrides.** Vision support and tool-calling support vary by *loaded model*, not just by backend. The current capability matrix is per-backend with a coarse "depends on model" caveat. A follow-up could probe each loaded local model's metadata for true per-model capability.
- **Admin UI feature creep.** This spec ships a deliberately minimal UI: dashboard, backend editor, router editor, archive viewer. Out of scope but plausible future additions: log streaming over WebSocket, in-UI request replay, in-UI prompt playground, multi-user audit log, dark mode toggle. Layer on as needed.
- **Admin UI frontend toolchain.** Decision to skip a build step ships a working UI fastest. If features grow past the comfort of vanilla Alpine.js, a future spec can introduce Vite + Svelte or similar — the JSON admin endpoints stay stable, so the frontend can be rewritten without touching the server.
- **Archive search ergonomics.** Substring search via `LIKE`; FTS5 indexing if usage grows.
- **Admin auth separation.** Admin endpoints currently share the single API key. A separate admin key may be warranted if exposed beyond localhost.
