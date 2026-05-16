# ClaudeMCP — API Fidelity and Multi-Provider Design

**Date:** 2026-05-16
**Status:** Approved for implementation planning
**Owner:** Prince Rehman Manjee
**Supersedes scope of:** `2026-04-18-claude-mcp-design.md` (extends, does not replace)

## Problem

The shipped ClaudeMCP server exposes one OpenAI-shaped HTTP endpoint (`POST /v1/chat/completions`) plus an MCP transport. It is not a drop-in replacement for the Anthropic Messages API, and even the OpenAI surface is narrow: no `/v1/embeddings`, cosmetic `model` field, prompt-engineered tool calling, no multimodal, no honor for sampling params or `cache_control`. Clients that depend on the official `anthropic` SDK cannot use the server at all; OpenAI-SDK clients can only do basic chat completions. There is also no path to Google Gemini, which the user has a Pro subscription to and would like to access through the same unified local gateway.

This design closes those gaps to the extent feasible while preserving the original premise: **no separate Anthropic or Google AI API keys** — Claude calls ride the Claude Max subscription via the `claude` CLI, Gemini calls ride the user's Google account via the `gemini` CLI. The server becomes a unified multi-provider local gateway with a single archive of all LLM traffic.

## Goals

- Add a full Anthropic-shaped HTTP surface (`/v1/messages`, files, models, token counting) so `@anthropic-ai/sdk` clients work against the server.
- Add a Google Gemini-shaped HTTP surface (`/v1beta/models/{model}:generateContent` and friends, `/v1beta/files`, `/v1beta/models`) so `@google/generative-ai` SDK clients work against the server.
- Extend the OpenAI shim with `/v1/embeddings` (proxied to a local backend such as LM Studio) so OpenAI-SDK clients have a single base URL.
- Add a second backend: `geminiRunner.ts` invokes the `gemini` CLI, riding the user's Google account auth (`gemini auth login`). The model router selects the backend per request based on the requested model ID.
- Allow any shim to target either backend: an Anthropic-SDK client requesting `model: "gemini-pro"` runs through the Gemini backend and gets translated back to Anthropic SSE shape; a Gemini-SDK client requesting `model: "claude-opus-4-7"` runs through the Claude backend. This falls out of a normalized internal backend contract.
- Make the `model` field functional with passthrough + curated aliases across both providers, plus an opt-in heuristic router and a `reasoning_effort` override that maps to per-provider tiers.
- Honor provider-native features that have a CLI path on each side: native `tool_use` round-trip (Anthropic) and function-calling (Gemini), multimodal image/document blocks, `stop_sequences` (server-side cut), `tool_choice` (via system-prompt directive), `metadata` passthrough, stateless conversation model.
- Implement local equivalents for features without a CLI path: persistent Files API (disk-backed content cache, shared across providers via content addressing), token counting (estimator), response cache (reinterpreted `cache_control`).
- Add a durable request/response archive (SQLite) capturing every call across both providers, for retrospective review and opt-in exact-match reuse.
- Preserve the existing OpenAI chat-completions pipeline behavior — no regressions for current Agent Zero usage.

## Non-goals

- Native API parity for features the CLIs fundamentally do not expose: `temperature`/`top_p`/`top_k` (silently ignored), Anthropic citations (501), `/v1/messages/batches` (501, backlog), Gemini grounding metadata when targeting Anthropic/OpenAI shims (silently dropped per the hybrid policy).
- Fallback to a real Anthropic or Google AI API key for unsupported features. The no-API-key premise is preserved even at the cost of fidelity gaps.
- Full internal-pipeline unification across shims. The three shims (Anthropic, OpenAI, Gemini) remain **parallel** at the HTTP-fidelity layer — each shim owns its own request/response translators — because the wire formats differ enough that sharing translation code would create more friction than it removes. **Backends, however, share a normalized internal contract** (see Architecture); this is the necessary departure from full duplication once we move from 2×1 to 3×2 shim-by-backend coverage.
- Native multimodal / native `tool_use` / `cache_control` in the OpenAI shim. Those features land on the Anthropic and Gemini shims only.
- Reverse-engineering Claude.ai's or Gemini's web APIs, or driving the Claude Desktop / Gemini app programmatically. All considered and rejected as brittle / out-of-scope.
- Embedding model selection logic, embedding caching, or embedding model auto-routing. The `/v1/embeddings` endpoint is a pure passthrough proxy.
- Log rotation, multi-user auth, quotas, or public-internet exposure (carried over from the original spec).

## Constraints and assumptions

- Host OS is Windows 11 or macOS on Apple Silicon (arm64). Node.js 20+, TypeScript, Express, `@modelcontextprotocol/sdk`. Same toolchain as the existing implementation. All native dependencies (`better-sqlite3`, `tree-kill`, zstd) ship prebuilt binaries for both platforms — no per-OS code paths required.
- The `claude` CLI is the only authenticated path to Anthropic. Its capability surface is the upper bound on what the server can honor end-to-end for Claude models.
- The `gemini` CLI is the only authenticated path to Google Gemini. Pre-authenticated via `gemini auth login` against the user's personal Google account (which has a Gemini Pro / Google One AI Premium subscription, providing generous quota). Same upper-bound rule applies for Gemini models.
- Both CLIs emit JSON stream output that can be normalized into a common event format. Claude's `stream-json` is Anthropic-shaped (`message_start`, `content_block_delta`, etc.); Gemini CLI's stream output is Gemini-shaped (`candidates[].content.parts[]` deltas). A small adapter per backend produces a unified internal event stream.
- Both CLIs accept `--model <id>` flags with their native model IDs and short aliases (Claude: `opus`/`sonnet`/`haiku`; Gemini: `pro`/`flash`/`flash-lite`). Unknown IDs surface as CLI errors, translated to 400.
- A local OpenAI-compatible embeddings backend (LM Studio, Ollama, llama-server) is reachable from the host. URL configurable; default targets LM Studio's default port.
- `better-sqlite3` is acceptable as a native dependency on Windows and macOS. Falls within personal-use scope.
- Existing Windows-specific runtime behavior (50 ms drain on shutdown to release cwd handles) is harmless on macOS and stays as-is rather than being gated behind `process.platform` checks.

## Architecture

Three parallel shims share a normalized backend interface. Each backend wraps one CLI. Shims target the backend interface, not the CLIs directly.

```
ClaudeMCP/
├── src/
│   ├── server.ts                    # routes, auth, lifecycle
│   ├── config.ts                    # extended Zod schema (multi-provider)
│   ├── logger.ts                    # JSONL logger (extended fields incl. provider)
│   ├── sessionStore.ts              # unchanged
│   ├── modelRouter.ts               # NEW — provider + model resolution
│   ├── fileStore.ts                 # NEW — shared across providers
│   ├── responseCache.ts             # NEW
│   ├── archive.ts                   # NEW — provider column
│   ├── tokenEstimator.ts            # NEW
│   ├── auth.ts                      # NEW — x-api-key / Bearer / x-goog-api-key
│   ├── backends/                    # NEW — normalized backend contract
│   │   ├── types.ts                 #   Backend interface, NormalizedRequest, NormalizedEvent
│   │   ├── claudeBackend.ts         #   wraps claudeRunner + claudeStreamRunner; CLI ↔ normalized
│   │   └── geminiBackend.ts         #   wraps geminiRunner + geminiStreamRunner; CLI ↔ normalized
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
│   │   ├── embeddings.ts            # NEW — proxy to LM Studio
│   │   └── types.ts                 # existing
│   ├── geminiShim/                  # NEW
│   │   ├── generateContent.ts       #   :generateContent + :streamGenerateContent
│   │   ├── countTokens.ts           #   :countTokens
│   │   ├── files.ts                 #   /v1beta/files/*
│   │   ├── models.ts                #   /v1beta/models
│   │   ├── requestTranslator.ts     #   Gemini request ↔ NormalizedRequest
│   │   ├── responseTranslator.ts    #   NormalizedEvent → Gemini SSE / final
│   │   └── types.ts
│   ├── admin/                       # NEW
│   │   └── archive.ts               # /admin/archive* handlers
│   └── tools/                       # existing MCP tools, unchanged
├── configs/
│   ├── default.json                 # extended
│   └── example.json                 # regenerated with _comments
├── data/
│   ├── sessions.json                # existing
│   ├── files/                       # NEW — content-addressed; shared across providers
│   ├── response-cache.json          # NEW
│   └── archive.sqlite               # NEW
├── scripts/
│   └── archive-prune.ts             # NEW
└── tests/
    ├── unit/                        # extended
    ├── integration/                 # extended — both mock CLIs
    └── compat/                      # NEW — real SDK round-trips (3 SDKs × 2 backends)
```

**Backend interface (`src/backends/types.ts`):**

```ts
interface Backend {
  readonly id: "claude" | "gemini";
  invoke(req: NormalizedRequest): AsyncIterable<NormalizedEvent>;
  countTokens(req: NormalizedRequest): Promise<number>;
}
```

`NormalizedRequest` is roughly Anthropic-shaped (chosen because both CLIs emit close-to-Anthropic content blocks): `{ model, system, messages, tools, toolChoice, stopSequences, maxTokens, multimodalBlocks, ... }`. `NormalizedEvent` is a small union: `{ kind: "message_start" | "text_delta" | "tool_use_start" | "tool_use_delta" | "tool_use_stop" | "message_stop", ... }`. Shims translate to and from these types; backends translate between them and their CLI's native format.

**Isolation rules:**

- `src/runners/*` are the only modules that spawn `claude` or `gemini`. CLI flag or output-format changes touch nowhere else.
- `src/backends/*` are the only modules that know each CLI's stream-event schema. Shims never see raw CLI events.
- Shims never know which backend they're targeting beyond the `model` string they pass through the router.

**Parallel-shim cost (revised):** the three shims independently implement request shaping, response shaping, and streaming wire format. Shim-side translators must be maintained per surface; backend-side translators are shared. This is the explicit trade-off: shim wire formats differ enough (Anthropic SSE event-typed, OpenAI SSE chunked, Gemini SSE JSON-array-style) that sharing translation code would create more friction than it saves, but the 3×2 matrix of (shim × backend) is impractical to fully duplicate, so the backend boundary is normalized.

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
| POST | `/v1/chat/completions` | Existing, no changes |
| POST | `/v1/embeddings` | NEW — proxied |

`GET /v1/models` is served by the Anthropic shim. The OpenAI SDK's `models.list()` will receive the same Anthropic-shaped list (extended with Gemini models); clients that strictly require OpenAI-shaped model entries can be addressed in a follow-up if it surfaces.

### Gemini shim (new)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1beta/models/{model}:generateContent` | Non-streaming generation |
| POST | `/v1beta/models/{model}:streamGenerateContent` | Streaming generation (SSE) |
| POST | `/v1beta/models/{model}:countTokens` | Token counting |
| GET  | `/v1beta/models` | List models (both providers, Gemini-shaped entries) |
| GET  | `/v1beta/models/{model}` | Model metadata |
| POST | `/v1beta/files` | Upload (multipart/resumable subset) |
| GET  | `/v1beta/files` | List with pagination |
| GET  | `/v1beta/files/{id}` | Metadata (returns `uri` pointing to the download endpoint below) |
| GET  | `/v1beta/files/{id}:download` | Download bytes |
| DELETE | `/v1beta/files/{id}` | Delete |

The Gemini shim reuses the same underlying `fileStore.ts`; uploads are dedup'd across providers by SHA-256 content hash. **File ID surface per shim:** Anthropic shim presents IDs as `file_<24hex>`; Gemini shim presents the same underlying hash as `files/<24hex>` (matching Google's convention). `fileStore.resolve()` accepts either form and returns the same content. A file uploaded via the Anthropic API can be referenced from a Gemini request and vice versa.

### Admin (new)

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/archive` | Paginated list with filters (`provider`, `session`, `model`, `since`, `until`, `status`, `limit`, `offset`) |
| GET | `/admin/archive/{id}` | Full entry with decompressed bodies |
| GET | `/admin/archive/search?q=` | Substring search in request prompts |

### MCP transport (existing)

`/sse`, `/message`, `/health` — unchanged.

### Deferred / unsupported

| Path | Disposition |
|---|---|
| `/v1/messages/batches/*` | 501 — backlog |
| Anthropic citations response blocks | 501 when `citations` field present in request |

## Data flow — `POST /v1/messages` (streaming)

1. `auth.ts` validates `x-api-key` / `Authorization: Bearer` / `x-goog-api-key` against `config.apiKey` (constant-time compare).
2. `modelRouter.ts` resolves the model and the **provider** (`claude` or `gemini`) from the request body and optional `reasoning_effort`. Returns `{ resolvedModel, provider, reason }`.
3. If the request includes `cache_control` blocks, `responseCache.ts` constructs the cache key (provider is part of the key). On hit, replay as synthetic Anthropic SSE and skip the CLI.
4. If `X-Archive-Reuse: exact-match` header is present, `archive.ts` computes the canonical hash and looks for an exact match. On hit, replay as synthetic SSE and skip the CLI.
5. `anthropicShim/requestTranslator.ts` resolves any `file_<hash>` references via `fileStore.ts`, inlines image/document content, applies `tool_choice` directive, and produces a `NormalizedRequest`.
6. The router-selected backend (`claudeBackend` or `geminiBackend`) takes the `NormalizedRequest`, invokes its CLI (`claude` or `gemini`) with the appropriate flags, and yields `NormalizedEvent`s.
7. `anthropicShim/responseTranslator.ts` converts each `NormalizedEvent` into Anthropic SSE events: `message_start`, `content_block_start`, `content_block_delta` (text or `input_json_delta` for tool args), `content_block_stop`, `message_delta`, `message_stop`. Per-event flush.
8. If `stop_sequences` was set, the backend's stream runner watches accumulated text content, terminates the child via `tree-kill`, truncates at the match boundary, and yields `message_stop` with `stop_reason: "stop_sequence"`.
9. On completion: `responseCache.ts` stores the assembled response if cacheable; `archive.ts` writes the entry (with provider column); `logger.ts` writes the JSONL line; session store updated if applicable.

Non-streaming follows the same path with the translator buffering all events before responding.

## Data flow — `POST /v1beta/models/{model}:streamGenerateContent`

Mirror of the above but with Gemini-shaped translators. The `{model}` path parameter is the requested model; the router still resolves provider from it (`gemini-pro` → gemini backend, `claude-opus-4-7` → claude backend). The response shape uses Gemini's SSE convention (line-delimited JSON arrays of `GenerateContentResponse` chunks). `content_block_delta` normalized events become `candidates[0].content.parts[0]` deltas. `tool_use` events become Gemini `functionCall` parts.

## Data flow — `POST /v1/chat/completions`

Behavior preserved bit-for-bit from existing implementation **for Claude-backed requests** (the only backend the current shim has known). Behavior extended for Gemini-backed requests: if the resolved model is `gemini-*`, the existing OpenAI shim invokes `geminiBackend` via the same path it currently uses for the Claude backend. Multimodal/tool_use/cache_control enhancements still do not land in this shim.

## Data flow — `POST /v1/embeddings`

`openaiShim/embeddings.ts` validates auth, forwards the request body verbatim to `config.embeddings.backendUrl` (optional Bearer of `config.embeddings.backendApiKey`), forwards the response untouched. Backend errors → 502 with `api_error`. Timeout (`config.embeddings.timeoutMs`) → 504. Neither CLI is invoked.

## Feature mechanics

### Model router (`modelRouter.ts`)

**Inputs:** `model` (optional), `reasoning_effort` (optional), prompt-token estimate, tool-definition count, multimodal-block presence, `thinking` flag, `config.router.defaultProvider`.

**Resolution order:**

1. **Provider identification.** If `model` matches an explicit ID or alias for a provider, that provider wins:
   - Claude: any of `opus`, `sonnet`, `haiku`, or any string starting with `claude-`.
   - Gemini: any of `pro`, `flash`, `flash-lite`, or any string starting with `gemini-`.
   - If `model` is `auto`, `claude-code-cli`, `gemini-cli`, or absent → use `config.router.defaultProvider` (default `"claude"`; `claude-code-cli` forces claude regardless, `gemini-cli` forces gemini regardless).
2. **Model resolution within the chosen provider:**
   - If `model` is a literal ID or alias → passthrough as that provider CLI's `--model`. Unknown IDs go through; CLI surfaces error as 400.
   - Else if `reasoning_effort` is set → map per `config.router.reasoningEffortMap[provider]`:
     - Claude: low → haiku, medium → sonnet, high → opus
     - Gemini: low → flash-lite, medium → flash, high → pro
   - Else → heuristic (per provider):
     - `thinking` requested, OR prompt-tokens > `opusPromptTokens`, OR tools > `opusToolCount` → top-tier model (opus / gemini-pro)
     - Else prompt-tokens > `sonnetPromptTokens`, OR any multimodal block, OR any tools → mid-tier (sonnet / gemini-flash)
     - Else → low-tier (haiku / gemini-flash-lite)
3. Thresholds, alias maps, and `defaultProvider` are configurable.

**Output:** `{ resolvedModel: string, provider: "claude" | "gemini", reason: string }`. Both `provider` and `reason` are persisted to logs and the archive entry for observability.

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
- **Key:** SHA-256 of canonicalized `(provider, resolvedModel, system, cacheable-prefix, tail, tools, tool_choice)`. Canonicalization: JSON stringification with sorted object keys and Unicode-normalized strings. The cacheable prefix ends at the last `ephemeral` block; everything after is the tail. `provider` is part of the key so the same logical request to different backends produces different cache entries.
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
    provider        TEXT NOT NULL,   -- 'claude' | 'gemini' | 'embeddings'
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
  CREATE INDEX idx_provider ON entries(provider);
  ```
- **What gets archived:** every request/response on `/v1/messages`, `/v1/chat/completions`, `/v1/messages/count_tokens`, `/v1/embeddings`, `/v1beta/models/*:generateContent`, `/v1beta/models/*:streamGenerateContent`, `/v1beta/models/*:countTokens`. Errors and timeouts archived. File operations and model listings excluded.
- **Compression:** zstd at `config.archive.compressionLevel` (default 3). Decompressed lazily by admin endpoints.
- **Reuse trigger:** opt-in header `X-Archive-Reuse: exact-match`. Default `never`. Header is transport-level so it works identically across both shims without polluting request bodies.
- **Hash key:** canonical SHA-256 of `(provider, resolvedModel, system, messages, tools, tool_choice, max_tokens)`. Canonicalization: same scheme as the response cache (sorted-key JSON, Unicode-normalized). Sampling params (`temperature`, `top_p`, `top_k`), `metadata`, and stream flag are **excluded** so they don't fragment hits. `provider` is part of the key so requests routed to different backends are not conflated.
- **Stream replay on hit:** the calling shim's `responseTranslator` synthesizes an SSE event stream in *its own* wire format (Anthropic SSE for `/v1/messages`, Gemini SSE for `/v1beta/.../:streamGenerateContent`, OpenAI SSE for `/v1/chat/completions`) from the archived final response. The archive stores the final response in its original shim format; if a Gemini-archived response is replayed for an Anthropic-shim request that hit the same hash key, the response is first parsed back into a `NormalizedRequest`-shaped intermediate and then re-rendered. This cross-shim replay case only occurs when the hash key collides (same provider, same model, same canonical content) — orthogonal to the archive's per-shim storage of the original response shape.
- **Retention:** forever by default. Manual prune via `scripts/archive-prune.ts --before YYYY-MM-DD` or `--session <id>`.
- **Independence from response cache:** archive hits never promote into the L1 cache. The two paths are orthogonal opt-ins.

### Token estimator (`tokenEstimator.ts`)

- Implements `/v1/messages/count_tokens` (Anthropic shape) and `/v1beta/models/{model}:countTokens` (Gemini shape). Returns provider-shaped response: `{ input_tokens }` for Anthropic, `{ totalTokens }` for Gemini.
- Provider-aware tokenizer dispatch:
  - Claude models → `@anthropic-ai/tokenizer` if available, else `Math.ceil(charCount / 4)` fallback.
  - Gemini models → `@google/generative-ai`'s tokenizer if available, else same char/4 fallback.
- Same estimator powers the response-cache token-accounting fields.
- README documents the accuracy caveat — these are estimates unless the provider-specific tokenizer is installed.

### Stop sequences

Implemented in **each backend's stream runner** (`claudeStreamRunner.ts`, `geminiStreamRunner.ts`) since the cut happens at the CLI-process layer:

- `NormalizedRequest.stopSequences: string[]` is forwarded to whichever runner the resolved backend uses.
- The runner maintains a rolling tail buffer of `max(stop_seq.length) - 1` bytes across stream chunks to catch sequences split across CLI output frames.
- On each new text-content chunk, it searches `(tail + chunk)` for any stop sequence.
- On match: terminate the CLI subtree via `tree-kill`, truncate accumulated text at the match start, emit a `NormalizedEvent` `message_stop` with `stop_reason: "stop_sequence"`. The shim's `responseTranslator` renders that into the right wire-format stop event.

### Tool calling — native round-trip

Anthropic and Gemini shims both support native tool calling, normalized through the backend interface:

- **Claude backend**: client `tools` array passed to CLI's tool-definition format. CLI's `stream-json` emits `tool_use` content blocks natively; backend translates to `NormalizedEvent` `tool_use_*` events. Follow-up requests with `tool_result` blocks get re-inlined.
- **Gemini backend**: client `tools` array passed to `gemini` CLI's function-declaration format. CLI stream emits `functionCall` parts; backend normalizes to the same `tool_use_*` events. Follow-up `functionResponse` parts get re-inlined.
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

  // Provider blocks
  "claude": {
    "enabled":   true,
    "command":   "claude",          // existing claudeCommand migrates here
    "timeoutMs": 600000
  },
  "gemini": {
    "enabled":   true,
    "command":   "gemini",
    "timeoutMs": 600000
  },

  "router": {
    "defaultProvider": "claude",    // claude | gemini
    "thresholds": {
      "opusPromptTokens":   50000,
      "opusToolCount":      5,
      "sonnetPromptTokens": 5000
    },
    "reasoningEffortMap": {
      "claude": {
        "low":    "claude-haiku-4-5",
        "medium": "claude-sonnet-4-6",
        "high":   "claude-opus-4-7"
      },
      "gemini": {
        "low":    "gemini-flash-lite",
        "medium": "gemini-flash",
        "high":   "gemini-pro"
      }
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
    "enabled":       true,
    "backendUrl":    "http://127.0.0.1:1234/v1/embeddings",
    "backendApiKey": "",
    "timeoutMs":     30000
  }
}
```

- Validated via Zod on startup; fail-fast with clear errors.
- If a provider block has `enabled: false`, requests routed to it return 503 with a clear "provider disabled" message; the router does not auto-fall-back to the other provider.
- Env-var overrides: `CLAUDE_MCP_API_KEY`, `CLAUDE_MCP_EMBEDDINGS_BACKEND_URL`, `CLAUDE_MCP_ARCHIVE_DB_PATH`, `CLAUDE_MCP_GEMINI_ENABLED`, `CLAUDE_MCP_CLAUDE_COMMAND`, `CLAUDE_MCP_GEMINI_COMMAND`.
- `configs/example.json` regenerated with a sibling `_comments` block per knob.

## Error policy

| Condition | HTTP | Body shape | Notes |
|---|---|---|---|
| Missing/invalid auth | 401 | Per-shim | Constant-time compare |
| Invalid request body | 400 | Per-shim | Zod validation surfaced |
| `model` unknown to selected CLI | 400 | `invalid_request_error` | After router resolution |
| `temperature` / `top_p` / `top_k` present | 200, ignored | Field absent from echo | Documented in README |
| Anthropic `citations` requested | 501 | `not_implemented_error` | Hybrid policy |
| Gemini `groundingMetadata` requested | 200, dropped | Field absent from response | Only honored on Gemini shim → Gemini backend (passthrough) |
| Gemini `safetyRatings` requested | 200, synthesized | Best-effort defaults on Gemini shim | Real ratings only when Gemini backend executes |
| `/v1/messages/batches*` | 501 | `not_implemented_error` | Backlog |
| `/v1/embeddings` backend unreachable | 502 | `api_error` | Forwarded message |
| `/v1/embeddings` timeout | 504 | `api_error` | `config.embeddings.timeoutMs` |
| CLI spawn failure | 502 | `api_error` | Existing behavior preserved |
| CLI non-zero exit | 502 | `api_error` | stderr forwarded |
| CLI timeout | 504 | `api_error` | `status: "timeout"` in log/archive |
| Provider disabled in config | 503 | `api_error` | "provider disabled: <name>" |
| Stop sequence matched | 200 | `stop_reason: "stop_sequence"` | Partial output returned |
| File `file_<hash>` not found | 400 | `invalid_request_error` | Per-shim |
| Archive reuse miss | proceed normally | — | Header ignored when no match |

## Logging additions

New JSONL fields (existing fields preserved for back-compat):

- `endpoint` — full URL path
- `provider` — `"claude"` | `"gemini"` | `"embeddings"`
- `modelRequested` — what the client asked for
- `modelResolved` — what the router picked
- `routerReason` — heuristic explanation
- `archiveHit` — `"exact-match"` | `false`
- `cacheHit` — `"hit"` | `"miss"` | `"n/a"`

`tool` field gains values: `messages`, `count_tokens`, `embeddings`, `files`, `models`, `generate_content`, `gemini_count_tokens`, `gemini_files`, `gemini_models` (alongside existing `claude_ask`, `claude_task`, `openai_completion`).

## Testing

**Unit (`tests/unit/`):**

- `modelRouter.test.ts` — every resolution branch for both providers, alias maps, defaultProvider override, all heuristic boundaries per provider, config-override.
- `fileStore.test.ts` — upload returns stable ID, dedup, metadata round-trip, TTL eviction, max-size LRU eviction, missing-file 400, file uploaded via Anthropic ID resolvable from Gemini shim and vice versa.
- `responseCache.test.ts` — provider in key, cacheable-prefix boundary at last `ephemeral` block, streaming replay synthesizes SSE correctly, TTL + max-entries eviction.
- `archive.test.ts` — every endpoint archived with correct provider tag, hash canonicalization excludes sampling params, exact-match reuse respects provider boundary, prune script removes correctly.
- `tokenEstimator.test.ts` — known-text counts within tolerance; multimodal and tool defs.
- `auth.test.ts` — `x-api-key`, Bearer, `x-goog-api-key`, `?key=` query — all three shim error shapes.
- `backends/claudeBackend.test.ts` — mock CLI events → correct `NormalizedEvent` stream; `NormalizedRequest` → correct CLI argv.
- `backends/geminiBackend.test.ts` — mock CLI events → correct `NormalizedEvent` stream; `NormalizedRequest` → correct CLI argv.
- `anthropicShim/requestTranslator.test.ts` — every content block type, system prompt placement, `tool_choice` directives, stop-sequence list.
- `anthropicShim/responseTranslator.test.ts` — full Anthropic SSE event sequence, non-streaming aggregation, stop-sequence cut.
- `geminiShim/requestTranslator.test.ts` — every `parts[]` type, system instruction placement, `toolConfig` mapping, multimodal blocks.
- `geminiShim/responseTranslator.test.ts` — Gemini SSE chunked-JSON format, `candidates[].content.parts[]` deltas, `functionCall` emission.
- `openaiShim/embeddings.test.ts` — passthrough, auth forwarding, backend error → 502, timeout → 504.

**Integration (`tests/integration/`):** uses both mock CLIs (`mock-claude`, `mock-gemini`) on PATH. Real SQLite, disk file store, real cache.

- `messages.integration.test.ts` — streaming + non-streaming on `/v1/messages`, with/without tools, with/without images, against both backends (model selection drives which mock CLI spawns).
- `generateContent.integration.test.ts` — same matrix for Gemini shim endpoints.
- `crossBackend.integration.test.ts` — Anthropic-SDK request with `model: "gemini-pro"` → gemini mock CLI spawns → Anthropic SSE returned. Gemini-SDK request with `model: "claude-opus-4-7"` → claude mock CLI spawns → Gemini SSE returned.
- `files.integration.test.ts` — upload via Anthropic shim → reference from Gemini shim → both succeed against the same content-addressed cache.
- `archive.integration.test.ts` — request → archived with provider tag → reuse via header replays without CLI spawn; provider-filter admin queries work.
- `cache.integration.test.ts` — `cache_control` round-trip; same logical request against different providers does not collide.
- `embeddings.integration.test.ts` — proxied against a stub HTTP backend.
- `auth.integration.test.ts` — all three header schemes, all three shim error shapes.
- `providerDisabled.integration.test.ts` — `gemini.enabled: false` → Gemini-routed requests return 503; Claude requests still succeed.

**Compatibility (`tests/compat/`) — new:**

Real SDK clients pointed at the running server with both mock CLIs. Highest-signal "1:1 replacement" verification.

- `anthropic-sdk.test.ts` — `messages.create` (stream + non-stream), `messages.countTokens`, full `files.*` lifecycle, `models.list`. Runs the matrix against both backends (model parameterized).
- `openai-sdk.test.ts` — `chat.completions.create` regression, `embeddings.create` via proxy. Tested against both Claude- and Gemini-backed model selections.
- `google-generative-ai-sdk.test.ts` — `generateContent`, `generateContentStream`, `countTokens`, `getModel`, full `files.*` lifecycle. Runs against both backends.

**Manual smoke (`docs/smoke-test.md`):** extended with Anthropic-side curl, Gemini-side curl, and an LM Studio embeddings round-trip.

**Coverage target:** ~80% line coverage in CI. Streaming edges and Windows process-tree teardown stay below the bar.

## Migration / back-compat notes

- Existing `POST /v1/chat/completions` behavior is preserved bit-for-bit for Claude-backed requests. Current Agent Zero deployments require no client changes.
- `config.claudeCommand` migrates to `config.claude.command`. Old field honored as fallback; deprecation warning logged. Removed in a future cleanup spec.
- `config.openai.requireAuthHeader` honored as fallback for `config.apiKey`; deprecation warning logged. Removed in a future cleanup spec.
- `config.gemini.enabled` defaults to `true`. If the `gemini` CLI is not installed, startup proceeds with a warning; Gemini-routed requests then return 503 at runtime. To pre-empt: set `config.gemini.enabled: false` in installations without the Gemini CLI.
- Existing JSONL log fields preserved; analysis scripts continue to work. New `provider` field defaults to `"claude"` when absent (back-compat with pre-multi-provider entries).
- Existing session-store file format unchanged.

## Implementation phasing note

The scope is large enough that the implementation plan will likely break into phases — a plausible sequencing:

1. **Foundation**: auth, model router (provider-aware), backend interface types, archive schema.
2. **Claude backend refactor**: move existing `claudeRunner.ts` / `claudeStreamRunner.ts` behind the `Backend` interface; no behavior change.
3. **Anthropic shim core**: `/v1/messages` (streaming + non-streaming), `/v1/models`, `/v1/messages/count_tokens`.
4. **Native tool_use + multimodal**: Anthropic shim, Claude backend.
5. **Files + response cache + archive**: cross-cutting features.
6. **Gemini backend**: `geminiRunner.ts`, `geminiStreamRunner.ts`, `geminiBackend.ts`.
7. **Gemini shim**: `/v1beta/models/*` endpoints, native function-calling.
8. **OpenAI shim Gemini-target extension**: minimal — let `model: "gemini-*"` route through Gemini backend.
9. **Embeddings proxy**: `/v1/embeddings`.
10. **Admin endpoints**: `/admin/archive*`.
11. **Compat tests**: all three SDKs × both backends.

Phasing belongs in the implementation plan, not this spec.

## Open questions / future work

- **Real tokenizer dependencies.** `@anthropic-ai/tokenizer` and a Gemini tokenizer (`@google/generative-ai-tokenizer` or equivalent) may or may not exist at implementation time. If absent, the char/4 fallback ships with a documented caveat; a follow-up spec can swap in proper BPE/SentencePiece implementations per provider.
- **CLI output-format stability.** Native `tool_use` round-trip depends on each CLI's stream output continuing to emit recognizable tool blocks. If a future CLI update changes the format, the relevant backend (`claudeBackend` or `geminiBackend`) is the single point of repair.
- **`/v1/messages/batches`.** Backlog. Implement when a concrete use case appears.
- **Anthropic citations.** No path through the CLI. Reserved for a future spec if Anthropic exposes attention spans in CLI output.
- **Gemini grounding / safety ratings on cross-shim calls.** When a Gemini-SDK client routes to the Claude backend, grounding metadata and real safety ratings cannot be produced. The Gemini shim returns synthesized defaults; documented in README.
- **OpenAI shim feature parity.** Multimodal, native `tool_use`, and `cache_control` on the OpenAI side are not in this spec. If Agent Zero or another OpenAI-SDK client needs them, a follow-up spec can extend or refactor.
- **Unified internal pipeline above the backend layer.** Shims are parallel; if shim-side maintenance pain emerges (e.g., adding a fourth shim like OpenAI Responses API or xAI Grok), a future spec can lift a shared shim base class.
- **Cross-vendor model aliases.** `gpt-4` → sonnet etc. not implemented. Add if a client requires it.
- **Additional providers.** The backend-interface abstraction makes adding a third provider (e.g., xAI Grok via `grok` CLI, OpenAI via API key) a matter of writing one new backend module. Out of scope here.
- **Embeddings via Gemini.** Gemini does have a text-embedding model (`text-embedding-004`). Currently we proxy `/v1/embeddings` to LM Studio only. Could be extended to route by model name (e.g., `gemini-embedding-*` → Gemini CLI if it gains an embedding subcommand). Not implemented.
- **Archive search ergonomics.** Substring search is a simple `LIKE` query; if usage grows beyond personal-scale, add FTS5 indexing.
- **Admin auth separation.** Admin endpoints currently share the single API key. A separate admin key may be warranted if the server is ever exposed beyond localhost.
