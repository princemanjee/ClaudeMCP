# ClaudeMCP — Claude API Fidelity Design

**Date:** 2026-05-16
**Status:** Approved for implementation planning
**Owner:** Prince Rehman Manjee
**Supersedes scope of:** `2026-04-18-claude-mcp-design.md` (extends, does not replace)

## Problem

The shipped ClaudeMCP server exposes one OpenAI-shaped HTTP endpoint (`POST /v1/chat/completions`) plus an MCP transport. It is not a drop-in replacement for the Anthropic Messages API, and even the OpenAI surface is narrow: no `/v1/embeddings`, cosmetic `model` field, prompt-engineered tool calling, no multimodal, no honor for sampling params or `cache_control`. Clients that depend on the official `anthropic` SDK cannot use the server at all; OpenAI-SDK clients can only do basic chat completions.

This design closes those gaps to the extent feasible while preserving the original premise: **no separate Anthropic API key** — all model calls still ride the Claude Max subscription via the `claude` CLI.

## Goals

- Add a full Anthropic-shaped HTTP surface (`/v1/messages`, files, models, token counting) so `@anthropic-ai/sdk` clients work against the server.
- Extend the OpenAI shim with `/v1/embeddings` (proxied to a local backend such as LM Studio) so OpenAI-SDK clients have a single base URL.
- Make the `model` field functional with passthrough + curated aliases, plus an opt-in heuristic router and a `reasoning_effort` override.
- Honor Anthropic features that have a CLI path: native `tool_use` round-trip, multimodal image/document blocks, `stop_sequences` (server-side cut), `tool_choice` (via system-prompt directive), `metadata` passthrough, stateless conversation model.
- Implement local equivalents for features without a CLI path: persistent Files API (disk-backed content cache), token counting (estimator), response cache (reinterpreted `cache_control`).
- Add a durable request/response archive (SQLite) for retrospective review and opt-in exact-match reuse.
- Preserve the existing OpenAI chat-completions pipeline behavior — no regressions for current Agent Zero usage.

## Non-goals

- Native API parity for features the CLI fundamentally does not expose: `temperature`/`top_p`/`top_k` (silently ignored), citations (501), `/v1/messages/batches` (501, backlog).
- Fallback to a real Anthropic API key for unsupported features. The no-API-key premise is preserved even at the cost of fidelity gaps.
- A unified internal pipeline. Per explicit user decision, the Anthropic and OpenAI surfaces are **parallel shims** with intentional code duplication. Maintenance cost is accepted in exchange for ship velocity and the freedom to evolve the two surfaces independently.
- Native multimodal / native `tool_use` / `cache_control` in the OpenAI shim. Those features land on the Anthropic side only.
- Reverse-engineering Claude.ai's web API or driving Claude Desktop programmatically. Both were considered and rejected as brittle / out-of-scope.
- Embedding model selection logic, embedding caching, or embedding model auto-routing. The `/v1/embeddings` endpoint is a pure passthrough proxy.
- Log rotation, multi-user auth, quotas, or public-internet exposure (carried over from the original spec).

## Constraints and assumptions

- Host OS is Windows 11. Node.js 20+, TypeScript, Express, `@modelcontextprotocol/sdk`. Same toolchain as the existing implementation.
- The `claude` CLI is the only authenticated path to Anthropic. Its capability surface is the upper bound on what the server can honor end-to-end.
- The CLI's `stream-json` output emits Anthropic-shaped content blocks including native `tool_use`. Verified empirically in current CLI versions; behavior change is an upgrade-time risk.
- The CLI accepts `--model <id>` with Anthropic model IDs and short aliases. Unknown IDs surface as CLI errors, which the server translates to 400.
- A local OpenAI-compatible embeddings backend (LM Studio, Ollama, llama-server) is reachable from the host. URL configurable; default targets LM Studio's default port.
- `better-sqlite3` is acceptable as a native dependency on Windows. Falls within personal-use scope.

## Architecture

Parallel shims sharing the CLI invoker, logger, session store, file store, response cache, archive, model router, and auth utility.

```
ClaudeMCP/
├── src/
│   ├── server.ts                    # routes, auth, lifecycle
│   ├── config.ts                    # extended Zod schema
│   ├── logger.ts                    # JSONL logger (extended fields)
│   ├── claudeRunner.ts              # CLI invoker (+ --model, image flags)
│   ├── claudeStreamRunner.ts        # streaming invoker (+ stop-sequence cutter)
│   ├── sessionStore.ts              # unchanged
│   ├── modelRouter.ts               # NEW
│   ├── fileStore.ts                 # NEW
│   ├── responseCache.ts             # NEW
│   ├── archive.ts                   # NEW
│   ├── tokenEstimator.ts            # NEW
│   ├── auth.ts                      # NEW
│   ├── anthropicShim/               # NEW
│   │   ├── messages.ts
│   │   ├── countTokens.ts
│   │   ├── files.ts
│   │   ├── models.ts
│   │   ├── requestTranslator.ts
│   │   ├── responseTranslator.ts
│   │   └── types.ts
│   ├── openaiShim/                  # existing + new
│   │   ├── handler.ts               # existing
│   │   ├── promptBuilder.ts         # existing
│   │   ├── responseParser.ts        # existing
│   │   ├── streamTranslator.ts      # existing
│   │   ├── embeddings.ts            # NEW
│   │   └── types.ts                 # existing
│   ├── admin/                       # NEW
│   │   └── archive.ts               # /admin/archive* handlers
│   └── tools/                       # existing MCP tools, unchanged
├── configs/
│   ├── default.json                 # extended
│   └── example.json                 # regenerated with _comments
├── data/
│   ├── sessions.json                # existing
│   ├── files/                       # NEW — content-addressed file cache
│   ├── response-cache.json          # NEW
│   └── archive.sqlite               # NEW
├── scripts/
│   └── archive-prune.ts             # NEW
└── tests/
    ├── unit/                        # extended
    ├── integration/                 # extended
    └── compat/                      # NEW — real SDK round-trips
```

**Isolation rule (carried over):** `claudeRunner.ts` and `claudeStreamRunner.ts` remain the only modules that spawn `claude`. CLI flag or output-format changes touch nowhere else.

**Parallel-shim cost:** the Anthropic and OpenAI shims will independently implement request shaping, response shaping, and streaming. CLI quirks must be fixed in both places. This is an explicit trade for shipping velocity; if maintenance pain materializes, a future spec may refactor to a unified internal core.

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

`GET /v1/models` is served by the Anthropic shim. The OpenAI SDK's `models.list()` will receive the same Anthropic-shaped list; clients that strictly require OpenAI-shaped model entries can be addressed in a follow-up if it surfaces.

### Admin (new)

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/archive` | Paginated list with filters (`session`, `model`, `since`, `until`, `status`, `limit`, `offset`) |
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

1. `auth.ts` validates `x-api-key` or `Authorization: Bearer` against `config.apiKey` (constant-time compare).
2. `modelRouter.ts` resolves the model from the request body and optional `reasoning_effort`.
3. If the request includes `cache_control` blocks, `responseCache.ts` constructs the cache key. On hit, replay as synthetic SSE and skip the CLI entirely.
4. If `X-Archive-Reuse: exact-match` header is present, `archive.ts` computes the canonical hash and looks for an exact match. On hit, replay as synthetic SSE and skip the CLI.
5. `requestTranslator.ts` resolves any `file_<hash>` references via `fileStore.ts`, inlines image/document content, applies `tool_choice` directive to the system prompt, and constructs the CLI argv plus prompt body.
6. `claudeStreamRunner.ts` spawns `claude -p ... --output-format stream-json` (with `--model`, system prompt, etc.) and yields events.
7. `responseTranslator.ts` converts each CLI event into Anthropic SSE events: `message_start`, `content_block_start`, `content_block_delta` (text or `input_json_delta` for tool args), `content_block_stop`, `message_delta`, `message_stop`. Per-event flush.
8. If `stop_sequences` was set, the translator watches accumulated text-block content, terminates the child via `tree-kill`, truncates at the match boundary, and emits `message_stop` with `stop_reason: "stop_sequence"`.
9. On completion: `responseCache.ts` stores the assembled response if cacheable; `archive.ts` writes the entry; `logger.ts` writes the JSONL line; session store updated if applicable.

Non-streaming follows the same path with the translator buffering all events before responding.

## Data flow — `POST /v1/chat/completions`

Unchanged from the existing implementation. Future enhancements to multimodal/tool_use/cache_control land on the Anthropic side only.

## Data flow — `POST /v1/embeddings`

`openaiShim/embeddings.ts` validates auth, forwards the request body verbatim to `config.embeddings.backendUrl` (optional Bearer of `config.embeddings.backendApiKey`), forwards the response untouched. Backend errors → 502 with `api_error`. Timeout (`config.embeddings.timeoutMs`) → 504.

## Feature mechanics

### Model router (`modelRouter.ts`)

**Inputs:** `model` (optional), `reasoning_effort` (optional), prompt-token estimate, tool-definition count, multimodal-block presence, `thinking` flag.

**Resolution order:**

1. If `model` matches the curated alias map (short forms `opus`/`sonnet`/`haiku`) or starts with `claude-` (any literal Anthropic ID) → passthrough as `--model`. Unknown `claude-*` IDs go through; CLI surfaces the error as 400.
2. Else if `reasoning_effort` is set → map per `config.router.reasoningEffortMap`:
   - `low` → haiku
   - `medium` → sonnet
   - `high` → opus
3. Else (`model` is `auto`, `claude-code-cli`, or absent) → heuristic:
   - `thinking` requested, OR prompt-tokens > `opusPromptTokens`, OR tools > `opusToolCount` → opus
   - Else prompt-tokens > `sonnetPromptTokens`, OR any multimodal block, OR any tools → sonnet
   - Else → haiku
4. Thresholds and alias map are configurable.

**Output:** `{ resolvedModel: string, reason: string }`. The `reason` is persisted to logs and the archive entry for observability.

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
- **Key:** SHA-256 of canonicalized `(resolvedModel, system, cacheable-prefix, tail, tools, tool_choice)`. Canonicalization: JSON stringification with sorted object keys and Unicode-normalized strings. The cacheable prefix ends at the last `ephemeral` block; everything after is the tail.
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
  CREATE INDEX idx_hash    ON entries(request_hash);
  CREATE INDEX idx_time    ON entries(timestamp);
  CREATE INDEX idx_session ON entries(session_id);
  ```
- **What gets archived:** every request/response on `/v1/messages`, `/v1/chat/completions`, `/v1/messages/count_tokens`, `/v1/embeddings`. Errors and timeouts archived. File operations and model listings excluded.
- **Compression:** zstd at `config.archive.compressionLevel` (default 3). Decompressed lazily by admin endpoints.
- **Reuse trigger:** opt-in header `X-Archive-Reuse: exact-match`. Default `never`. Header is transport-level so it works identically across both shims without polluting request bodies.
- **Hash key:** canonical SHA-256 of `(resolvedModel, system, messages, tools, tool_choice, max_tokens)`. Canonicalization: same scheme as the response cache (sorted-key JSON, Unicode-normalized). Sampling params (`temperature`, `top_p`, `top_k`), `metadata`, and stream flag are **excluded** so they don't fragment hits.
- **Stream replay on hit:** synthesizes Anthropic SSE event stream from the archived final response.
- **Retention:** forever by default. Manual prune via `scripts/archive-prune.ts --before YYYY-MM-DD` or `--session <id>`.
- **Independence from response cache:** archive hits never promote into the L1 cache. The two paths are orthogonal opt-ins.

### Token estimator (`tokenEstimator.ts`)

- Implements `/v1/messages/count_tokens`. Returns `{ input_tokens }`.
- Backend: `@anthropic-ai/tokenizer` if available; fallback `Math.ceil(charCount / 4)`.
- Same estimator powers the response-cache token-accounting fields.
- README documents the accuracy caveat — these are estimates unless the BPE tokenizer is installed.

### Stop sequences

Implemented in `claudeStreamRunner.ts`:

- Caller passes `stopSequences: string[]`.
- Wrapper maintains a rolling tail buffer of `max(stop_seq.length) - 1` bytes across stream chunks to catch sequences split across CLI output frames.
- On each new chunk, searches `(tail + chunk)` for any stop sequence.
- On match: terminate CLI subtree via `tree-kill`, truncate accumulated text at the match start, emit `message_stop` with `stop_reason: "stop_sequence"`.

### Tool calling — native `tool_use`

Anthropic shim only:

- Client `tools` array passed through to the CLI's tool-definition format.
- CLI's `stream-json` output emits `tool_use` content blocks natively; translator forwards them as-is in `content_block_start` / `content_block_delta` (input_json_delta) / `content_block_stop`.
- Follow-up requests with `tool_result` content blocks get re-inlined into the prompt.

OpenAI shim retains today's prompt-engineered emulation. Not backfilled per the parallel-shim decision.

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

- Single shared `config.apiKey`. Accept via:
  - `x-api-key: <key>` (Anthropic SDK)
  - `Authorization: Bearer <key>` (OpenAI SDK)
- Constant-time comparison.
- 401 error body shape matches the called endpoint family:
  - Anthropic-shaped on `/v1/messages*`, `/v1/files*`, `/v1/models*`, `/admin/*`.
  - OpenAI-shaped on `/v1/chat/completions`, `/v1/embeddings`.
- Migration: existing `config.openai.requireAuthHeader` is honored if `config.apiKey` is unset; deprecation warning logged on startup. To be removed in a future cleanup spec.

## Config schema additions

```jsonc
{
  // ... existing fields preserved ...
  "apiKey": "<required-string>",   // no default shipped; startup fails if missing

  "router": {
    "thresholds": {
      "opusPromptTokens":   50000,
      "opusToolCount":      5,
      "sonnetPromptTokens": 5000
    },
    "reasoningEffortMap": {
      "low":    "claude-haiku-4-5",
      "medium": "claude-sonnet-4-6",
      "high":   "claude-opus-4-7"
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
- Env-var overrides: `CLAUDE_MCP_API_KEY`, `CLAUDE_MCP_EMBEDDINGS_BACKEND_URL`, `CLAUDE_MCP_ARCHIVE_DB_PATH`.
- `configs/example.json` regenerated with a sibling `_comments` block per knob.

## Error policy

| Condition | HTTP | Body shape | Notes |
|---|---|---|---|
| Missing/invalid auth | 401 | Per-shim | Constant-time compare |
| Invalid request body | 400 | Per-shim | Zod validation surfaced |
| `model` unknown to CLI | 400 | `invalid_request_error` | After router resolution |
| `temperature` / `top_p` / `top_k` present | 200, ignored | Field absent from echo | Documented in README |
| `citations` requested | 501 | `not_implemented_error` | Hybrid policy |
| `/v1/messages/batches*` | 501 | `not_implemented_error` | Backlog |
| `/v1/embeddings` backend unreachable | 502 | `api_error` | Forwarded message |
| `/v1/embeddings` timeout | 504 | `api_error` | `config.embeddings.timeoutMs` |
| CLI spawn failure | 502 | `api_error` | Existing behavior preserved |
| CLI non-zero exit | 502 | `api_error` | stderr forwarded |
| CLI timeout | 504 | `api_error` | `status: "timeout"` in log/archive |
| Stop sequence matched | 200 | `stop_reason: "stop_sequence"` | Partial output returned |
| File `file_<hash>` not found | 400 | `invalid_request_error` | Per-shim |
| Archive reuse miss | proceed normally | — | Header ignored when no match |

## Logging additions

New JSONL fields (existing fields preserved for back-compat):

- `endpoint` — full URL path
- `modelRequested` — what the client asked for
- `modelResolved` — what the router picked
- `routerReason` — heuristic explanation
- `archiveHit` — `"exact-match"` | `false`
- `cacheHit` — `"hit"` | `"miss"` | `"n/a"`

`tool` field gains values: `messages`, `count_tokens`, `embeddings`, `files`, `models` (alongside existing `claude_ask`, `claude_task`, `openai_completion`).

## Testing

**Unit (`tests/unit/`):**

- `modelRouter.test.ts` — every resolution branch, all heuristic boundaries, config-override.
- `fileStore.test.ts` — upload returns stable ID, dedup, metadata round-trip, TTL eviction, max-size LRU eviction, missing-file 400.
- `responseCache.test.ts` — cacheable-prefix boundary at last `ephemeral` block, key construction, streaming replay synthesizes SSE correctly, TTL + max-entries eviction.
- `archive.test.ts` — every endpoint archived, hash canonicalization excludes sampling params, exact-match reuse on header, header absent never reuses, prune script removes correctly.
- `tokenEstimator.test.ts` — known-text counts within tolerance; multimodal and tool defs.
- `auth.test.ts` — both header schemes, both shim error shapes.
- `anthropicShim/requestTranslator.test.ts` — every content block type, system prompt placement, `tool_choice` directives, stop-sequence list.
- `anthropicShim/responseTranslator.test.ts` — full Anthropic SSE event sequence, non-streaming aggregation, stop-sequence cut.
- `openaiShim/embeddings.test.ts` — passthrough, auth forwarding, backend error → 502, timeout → 504.

**Integration (`tests/integration/`):** same mock-`claude` binary approach as existing tests. Real SQLite, disk file store, real cache.

- `messages.integration.test.ts` — streaming + non-streaming, with/without tools, with/without images.
- `files.integration.test.ts` — upload → reference in `/v1/messages` → delete.
- `archive.integration.test.ts` — request → archived → reuse via header replays without CLI spawn; admin endpoints return expected pages.
- `cache.integration.test.ts` — `cache_control` round-trip; archive and cache don't interfere.
- `embeddings.integration.test.ts` — proxied against a stub HTTP backend.
- `auth.integration.test.ts` — both header schemes, both shim error shapes.

**Compatibility (`tests/compat/`) — new:**

Real SDK clients pointed at the running server (mock CLI). This is the highest-signal "1:1 replacement" verification.

- `anthropic-sdk.test.ts` — `messages.create` (stream + non-stream), `messages.countTokens`, full `files.*` lifecycle, `models.list`.
- `openai-sdk.test.ts` — `chat.completions.create` regression, `embeddings.create` via proxy.

**Manual smoke (`docs/smoke-test.md`):** extended with Anthropic-side curl examples and an LM Studio embeddings round-trip.

**Coverage target:** ~80% line coverage in CI. Streaming edges and Windows process-tree teardown stay below the bar.

## Migration / back-compat notes

- Existing `POST /v1/chat/completions` behavior is preserved bit-for-bit. Current Agent Zero deployments require no client changes.
- `config.openai.requireAuthHeader` honored as fallback for `config.apiKey`; deprecation warning logged. Removed in a future cleanup spec.
- Existing JSONL log fields preserved; analysis scripts continue to work.
- Existing session-store file format unchanged.

## Implementation phasing note

The scope is large enough that the implementation plan will likely break into phases (e.g., auth + model router → Anthropic `/v1/messages` core → tool_use + multimodal → files → cache + archive → embeddings proxy → admin endpoints → compat tests). Phasing belongs in the implementation plan, not this spec.

## Open questions / future work

- **Real Anthropic tokenizer dependency.** `@anthropic-ai/tokenizer` may or may not exist at implementation time. If absent, the char/4 fallback ships with a documented caveat; a follow-up spec can swap in a proper BPE implementation.
- **CLI `tool_use` stability.** Native `tool_use` round-trip depends on the CLI's `stream-json` output continuing to emit Anthropic-shaped tool blocks. If a future CLI update changes the format, `claudeStreamRunner` is the single point of repair.
- **`/v1/messages/batches`.** Backlog. Implement when a concrete use case appears.
- **Citations.** No path through the CLI. Reserved for a future spec if Anthropic exposes attention spans in CLI output.
- **OpenAI shim feature parity.** Multimodal, native `tool_use`, and `cache_control` on the OpenAI side are not in this spec. If Agent Zero or another OpenAI-SDK client needs them, a follow-up spec can extend or refactor.
- **Unified internal core.** The parallel-shim decision is explicit but reversible. If maintenance pain emerges, a future spec can collapse to a single Anthropic-shaped pipeline with an OpenAI adapter on top.
- **Cross-vendor model aliases.** `gpt-4` → sonnet etc. not implemented. Add if a client requires it.
- **Archive search ergonomics.** Substring search is a simple `LIKE` query; if usage grows beyond personal-scale, add FTS5 indexing.
- **Admin auth separation.** Admin endpoints currently share the single API key. A separate admin key may be warranted if the server is ever exposed beyond localhost.
