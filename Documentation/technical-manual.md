# ClaudeMCP — Technical Manual

> Internal architecture, request flow, and data layout for the ClaudeMCP
> multi-backend local LLM gateway. Audience: contributors and operators who
> need to reason about how the system works inside.

**Companion documents:**
- [README.md](./README.md) — documentation index
- [deployment-guide.md](./deployment-guide.md) — installation and process management
- [configuration-guide.md](./configuration-guide.md) — `configs/default.json` reference
- [user-manual.md](./user-manual.md) — client-side usage (SDKs, model routing)
- [api-reference.md](./api-reference.md) — HTTP endpoint reference
- [operations-guide.md](./operations-guide.md) — monitoring, archive pruning, admin UI
- [development-guide.md](./development-guide.md) — TDD workflow, contributing, adding backends/shims

---

## 1. Architectural overview

ClaudeMCP is a single Node.js process that translates between three popular
LLM wire formats (Anthropic Messages, OpenAI Chat Completions, Google Gemini
GenerateContent) and four LLM backends (Claude Code CLI, Gemini CLI, LM Studio
HTTP, Ollama HTTP). Every request flows through the same internal pipeline:

```
client ──HTTP──> shim ──translator──> NormalizedRequest
                                            │
                                            ▼
                                       BackendRegistry
                                            │
                              ┌─────────────┼─────────────┐
                              ▼             ▼             ▼
                         claude CLI    gemini CLI    LM Studio / Ollama
                         subprocess    subprocess        HTTP daemon
                              │             │             │
                              └─────────────┼─────────────┘
                                            ▼
                                  NormalizedEvent stream
                                            │
                                            ▼
                                   shim response translator
                                            │
                                            ▼
                          wire-format SSE / JSON ──HTTP──> client
```

The single hand-off contract — `NormalizedRequest` in, async iterable of
`NormalizedEvent` out — lets any of the three shims drive any of the four
backends. A Gemini-SDK client requesting `claude-opus-4-7` works. An
Anthropic-SDK client requesting `qwen3-coder-30b` (a model loaded in LM Studio)
works. The 3 × 4 shim × backend matrix is collapsed into 3 translators +
4 backend adapters by normalizing the interior.

Three persistent stores hang off the pipeline as fire-and-forget side
channels: a SQLite **archive** (every request/response, zstd-compressed), a
content-addressed **file store** (image / document uploads, shared across all
shims), and an in-process **response cache** (driven by `cache_control`
blocks). A localhost-only **admin UI** reads these stores and exposes live
config editing.

---

## 2. Module layout

### Entry points and bootstrap

| Path | Role |
|---|---|
| `src/bin.ts` | CLI entry — parses `--config <path>` and `--port <n>`, calls `main()`. |
| `src/server.ts` | Express bootstrap. `main()` constructs every store, builds the registry, mounts routes, starts the periodic probe, wires SIGINT/SIGTERM to graceful shutdown. `buildApp()` returns the Express app without binding a port (used by tests). `buildRegistry()` registers exactly the enabled backends from config. |
| `src/config.ts` | Zod schema, `loadConfig(path)`, `applyEnvOverrides()` (`CLAUDE_MCP_API_KEY`), `deepFreeze()` so handlers can capture-by-reference without mutation hazards. |

### Cross-cutting infrastructure

| Path | Role |
|---|---|
| `src/auth.ts` | `checkAuth(carrier, expectedApiKey)` accepts `x-api-key`, `Authorization: Bearer <token>`, `x-goog-api-key`, or `?key=`. Constant-time comparison via `crypto.timingSafeEqual`. Plan-12 added `checkApiKey(presented, expected)` for the admin login flow. |
| `src/archive.ts` | SQLite + zstd persistence. Single `entries` table; one row per request/response. `recordEntry`, `getById`, `list`, `searchText`, `deleteOlderThan`, `deleteBySession`. WAL journal mode. Compression level threaded from config. |
| `src/fileStore.ts` | Content-addressed disk cache. `upload(bytes, filename, mime)` returns `file_<24hex>` ID derived from SHA-256. Sidecar JSON per file. TTL + max-total-bytes LRU eviction. `resolveById` accepts either `file_<24hex>` (Anthropic) or `files/<24hex>` (Gemini) form. |
| `src/responseCache.ts` | In-memory `Map` mirrored to a JSON-line file. Key = SHA-256 of canonicalized `(backend, model, system, cacheable-prefix, tail, tools, tool_choice)`. TTL + max-entries LRU. |
| `src/tokenEstimator.ts` | `Math.ceil(charCount / 4)` fallback. Image blocks contribute a 258-token placeholder; document blocks approximate via decoded base64 length. |
| `src/modelRouter.ts` | `identifyBackend(model, defaultBackend)` resolves to one of: prefix override (`lmstudio/X`), Anthropic alias (opus/sonnet/haiku), Gemini alias (pro/flash/flash-lite), CLI sentinel (`claude-code-cli`, `gemini-cli`, `auto`, `""`), or `needs-registry-lookup`. Backends and the registry then take over. |

### Backend layer

| Path | Role |
|---|---|
| `src/backends/types.ts` | The single internal contract. Defines `Backend`, `BackendCapabilities`, `NormalizedRequest`, `NormalizedContentBlock`, `NormalizedEvent`, `NormalizedEmbeddingRequest/Response`, `ModelDescriptor`. Discriminant choice: content blocks use `type`, stream events use `kind` — see [§3.2](#32-discriminant-conventions). |
| `src/backends/registry.ts` | `BackendRegistry` — `register`, `get`, `resolveModel`, `probe`, `startPeriodicProbe`, `stop`. Probes every backend's `listModels()` in parallel, rebuilds the model map with priority-aware collision resolution. |
| `src/backends/claudeBackend.ts` | Wraps the `claude` CLI via `runners/claudeStreamRunner`. Curated `MODEL_CATALOG` (opus-4-7 / sonnet-4-6 / haiku-4-5). `capabilities.cacheControl = "none"`, `samplingParams = {temp: false, topP: false, topK: false}`, `stopSequences = "server-side-cut"`. |
| `src/backends/geminiBackend.ts` | Wraps the `gemini` CLI via `runners/geminiStreamRunner`. Curated catalog of pro / flash / flash-lite. Capability profile matches Claude. |
| `src/backends/lmstudioBackend.ts` | Multi-instance HTTP client. Each instance has its own `OpenAICompatClient`. `capabilities = {toolUse: true, multimodal: true, samplingParams: {all true}, stopSequences: "native"}`. Embeddings supported per model. |
| `src/backends/ollamaBackend.ts` | Multi-instance HTTP. Per-instance `useNativeApi` flag picks `OpenAICompatClient` (default) vs `OllamaNativeClient` (NDJSON `/api/chat`). |
| `src/backends/openaiCompatClient.ts` | Shared HTTP client speaking OpenAI's `/v1/chat/completions`, `/v1/embeddings`, `/v1/models`. SSE parsing. Used by LM Studio + Ollama (compat mode). |
| `src/backends/ollamaNativeClient.ts` | Ollama's native `/api/*` surface. NDJSON streaming. Used when `instance.useNativeApi: true`. |

### Runner layer (CLI subprocesses)

| Path | Role |
|---|---|
| `src/runners/types.ts` | Shared option/result types. `command: string \| string[]` for bare-name vs prefix-args forms (`["wsl", "claude"]`). |
| `src/runners/claudeRunner.ts` | One-shot `claude -p --output-format json`. Synchronous body return. |
| `src/runners/claudeStreamRunner.ts` | Streaming `claude -p --output-format stream-json`. NDJSON parsing. Used by `ClaudeBackend.invoke`. |
| `src/runners/geminiRunner.ts` | One-shot `gemini` invoker. |
| `src/runners/geminiStreamRunner.ts` | Streaming `gemini` invoker. NDJSON-ish parsing of `candidates[].content.parts[]` deltas. |

The runner layer is the *only* place that spawns `claude` or `gemini`. Anything
above it operates on normalized events.

### Shim layer (HTTP translators)

| Path | Role |
|---|---|
| `src/anthropicShim/types.ts` | Anthropic Messages API shapes (request body, content blocks, errors). |
| `src/anthropicShim/errors.ts` | Error envelope helpers — `authenticationError`, `invalidRequestError`, `notFoundError`, `internalServerError` — plus `ShimRequestError` exception class. |
| `src/anthropicShim/requestTranslator.ts` | Anthropic body → `NormalizedRequest`. Resolves `file_<hash>` references via `fileStore`, inlines image / document content, applies `tool_choice` directive into the system prompt. |
| `src/anthropicShim/responseTranslator.ts` | `NormalizedEvent` → Anthropic SSE (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`) for streaming, or buffered final response for non-streaming. |
| `src/anthropicShim/messages.ts` | `POST /v1/messages` handler factory. Auth → resolve backend → cache lookup → archive lookup → invoke → translate → archive. |
| `src/anthropicShim/countTokens.ts` | `POST /v1/messages/count_tokens` — delegates to `backend.countTokens`. |
| `src/anthropicShim/models.ts` | `GET /v1/anthropic/models` (Anthropic envelope). |
| `src/anthropicShim/files.ts` | Multipart upload, list, metadata, download, delete. Wires `fileStore`. |
| `src/openaiShim/` | Parallel set for OpenAI. `chatCompletions.ts` (with SSE streaming), `embeddings.ts` (multi-backend routing + legacy passthrough), `models.ts` (OpenAI envelope), `requestTranslator.ts`, `responseTranslator.ts`, `promptBuilder.ts` (legacy prompt-engineered tool emulation), `responseParser.ts`. |
| `src/geminiShim/` | Parallel set for Gemini. `generateContent.ts` (handles both `generateContent` and `streamGenerateContent`), `countTokens.ts`, `models.ts`, `files.ts`, `modelPath.ts` (path stripping for `models/<id>` vs bare-id forms), `requestTranslator.ts`, `responseTranslator.ts`. |

### Admin layer

| Path | Role |
|---|---|
| `src/admin/router.ts` | `mountAdminRoutes(app, deps)` mounts every `/admin/*` route behind the `bindLocalhostMiddleware` fence. |
| `src/admin/bindLocalhost.ts` | Per-request gate. Reads `adminUi.bindLocalhost` from the live snapshot (so a PATCH takes effect immediately) and rejects non-localhost IPs with 403. |
| `src/admin/archive.ts` | `GET /admin/archive` (paginated + filters), `GET /admin/archive/:id`, `GET /admin/archive/search?q=`. |
| `src/admin/backends.ts` | `GET /admin/backends` (per-backend reachability, capability matrix, discovered models), `POST /admin/backends/reprobe`, `POST /admin/backends/test`. |
| `src/admin/config.ts` | `GET /admin/config` (api key redacted), `PUT /admin/config` (full replace), `PATCH /admin/config` (JSON merge patch). |
| `src/admin/configValidate.ts` | Wraps `ConfigSchema.parse` for live edits. |
| `src/admin/configSnapshot.ts` | `ConfigSnapshotStore` — atomic write-then-swap, in-flight requests keep their old snapshot. |
| `src/admin/recordCompletion.ts` | Shared fire-and-forget archive-write helper. Used by OpenAI + Gemini shims (the Anthropic shim has its own cache-key-derived archive path). |
| `src/admin/session.ts` | `SessionStore` — in-memory `Map<token, {createdAt}>` with TTL eviction. Issues 64-char hex tokens. Used by the admin UI login. |
| `src/admin/ui.ts` | `createAdminUiHandler` — serves static SPA assets, handles `POST /admin/ui/session` (login) and `DELETE /admin/ui/session` (logout). Reads cookies via the bridge in `src/server.ts`. |
| `src/admin-ui/` | Vanilla SPA. `index.html` + `app.js` (Alpine components) + `styles.css` + `themes/{light,dark}.css` + inline SVG `icons/`. No build step. |

---

## 3. The normalized request/event pipeline

### 3.1 Why a single internal contract

Three HTTP wire formats × four backend protocols = twelve cells. Implementing
each cell independently means 12 translators. Instead, ClaudeMCP defines a
single Anthropic-ish internal shape — `NormalizedRequest` for input,
`AsyncIterable<NormalizedEvent>` for output — and pivots through it:

- **3 shim request translators** (Anthropic, OpenAI, Gemini) → `NormalizedRequest`
- **4 backend adapters** consume `NormalizedRequest`, emit `NormalizedEvent`
- **3 shim response translators** consume `NormalizedEvent`, emit wire format

That's 3 + 4 + 3 = 10 translators, each independently testable. More
importantly, *any* shim can drive *any* backend without bespoke glue.

### 3.2 Discriminant conventions

Content blocks (`NormalizedContentBlock`) use `type` as the discriminant —
matching Anthropic's Messages API shape so translators can pass blocks through
with minimal renaming:

```ts
type NormalizedContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "document"; mediaType: string; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string };
```

Stream events (`NormalizedEvent`) use `kind` instead. Two reasons:

1. **Browser/DOM `Event.type` collision.** Code that uses these types in
   browser-adjacent contexts shouldn't have to disambiguate.
2. **Call-site clarity.** A handler iterating over events can pattern-match
   on `ev.kind` without confusing the reader who might expect "type" to mean
   "content block type".

```ts
type NormalizedEvent =
  | { kind: "message_start"; model: string }
  | { kind: "text_delta"; index: number; text: string }
  | { kind: "thinking_delta"; index: number; text: string }
  | { kind: "tool_use_start"; index: number; id: string; name: string }
  | { kind: "tool_use_delta"; index: number; partialJson: string }
  | { kind: "tool_use_stop"; index: number }
  | {
      kind: "message_stop";
      stopReason: "end_turn" | "stop_sequence" | "max_tokens" | "tool_use" | "error";
      usage?: { inputTokens: number; outputTokens: number };
    };
```

This is documented in `src/backends/types.ts` directly above the type
definitions.

### 3.3 The `Backend` interface

```ts
interface Backend {
  readonly id: BackendId;                                          // "claude" | "gemini" | "lmstudio" | "ollama"
  capabilitiesFor(model: string): BackendCapabilities;             // per-model capability gate
  listModels(): Promise<ModelDescriptor[]>;                        // probed at startup + on interval
  invoke(req: NormalizedRequest): AsyncIterable<NormalizedEvent>;  // the hot path
  countTokens(req: NormalizedRequest): Promise<number>;            // for /count_tokens endpoints
  embed?(req: NormalizedEmbeddingRequest):                         // optional — only LM Studio + Ollama
    Promise<NormalizedEmbeddingResponse>;
}
```

Method contracts:

- **`id`** is the static backend identity, used as a key in `BackendRegistry`
  and stored verbatim in archive rows so observability queries can filter by
  backend.
- **`capabilitiesFor(model)`** is consulted by shims *before* dispatching.
  Shims use it to silently drop unsupported request fields (e.g.,
  `temperature` on Claude where `samplingParams.temperature = false`), to
  decide between "native stop sequence" and "server-side cut" semantics, etc.
- **`listModels()`** is called by `BackendRegistry.probe()` at startup and on
  the periodic re-probe. Failures are recorded against the backend's
  `ProbeStatus` but don't tear down the registry.
- **`invoke(req)`** returns an async iterable. The shim's response translator
  consumes it as `for await (const ev of stream)`. Backends are expected to
  yield exactly one `message_start`, zero-or-more deltas / tool events, and
  exactly one `message_stop`.
- **`countTokens(req)`** is allowed to fall back to a char/4 estimate when
  the backend has no real tokenizer reachable. The result is advisory; the
  shim returns it as `input_tokens` (Anthropic) or `totalTokens` (Gemini).
- **`embed(req)`** is optional. Backends that don't support embeddings
  (Claude, Gemini CLIs) omit the method; the OpenAI `/v1/embeddings` handler
  returns 400 `"model does not support embeddings"` when resolution lands on
  such a backend.

### 3.4 Capability matrix (as built)

| Capability | Claude CLI | Gemini CLI | LM Studio | Ollama |
|---|---|---|---|---|
| `toolUse` | true | true | true | true |
| `multimodal` | true | true | true (per model) | true (per model) |
| `thinking` | true | true | false | false |
| `cacheControl` | `"none"` | `"none"` | `"none"` | `"none"` |
| `samplingParams.temperature` | false | false | true | true |
| `samplingParams.topP` | false | false | true | true |
| `samplingParams.topK` | false | false | true | true |
| `stopSequences` | `"server-side-cut"` | `"server-side-cut"` | `"native"` | `"native"` |
| `embeddings` | false | false | true | true |

`cacheControl = "none"` everywhere because no backend speaks the
Anthropic-native cache-control protocol; the response cache is the local
re-interpretation (see [§7](#7-response-cache-and-cache_control-reinterpretation)).

---

## 4. Request flow (deep dive)

A `POST /v1/messages` walks the full pipeline. Numbered annotations key into
`src/anthropicShim/messages.ts` and surrounding modules.

### Step 1 — Client sends the request

Standard Anthropic Messages body:

```http
POST /v1/messages HTTP/1.1
x-api-key: <api-key>
content-type: application/json

{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": true
}
```

### Step 2 — Express middleware

In order (see `src/server.ts` `buildApp`):

1. `express.json({ limit: "32mb" })` — body parsing.
2. `cookieParser()` — populates `req.cookies` for the admin session bridge.
3. For `/admin/*` routes only: the `sessionAuthMiddleware` (synthesizes an
   `x-api-key` header from a valid session cookie) and the
   `bindLocalhostMiddleware` (rejects non-localhost IPs when configured).
4. The per-handler factory (`createMessagesHandler(...)`) takes over.

### Step 3 — Auth + backend resolution

```ts
// src/anthropicShim/messages.ts
if (!checkAuth({ headers: req.headers, query: req.query }, config.apiKey)) {
  return res.status(401).json(authenticationError("..."));
}

const resolution = resolveBackend(registry, config.router.defaultBackend, body.model);
if ("error" in resolution) {
  return res.status(404).json(notFoundError("model not found: ..."));
}
const { backend, resolvedModel } = resolution;
```

`resolveBackend` delegates to `identifyBackend(model, defaultBackend)`. If
that returns a concrete `BackendId`, the registry's `get(id)` is consulted.
If it returns `null` (a bare model name like `qwen3-coder-30b`), the
registry's `resolveModel(modelId)` is consulted to find which backend
probed it. Either lookup miss → 404.

### Step 4 — Response cache lookup (when `cache_control` is present)

If the body contains at least one block with `cache_control: { type: "ephemeral" }`:

```ts
const keyParts: CacheKeyParts = {
  backendId: backend.id,
  resolvedModel,
  system: body.system,
  cacheablePrefix: prefix,   // up to and including the last ephemeral block
  tail,                      // everything after
  tools: body.tools,
  toolChoice: body.tool_choice
};
const key = buildCacheKey(keyParts);
const hit = responseCache.get(key);
if (hit) {
  // Replay as synthetic SSE matching what the backend would have produced.
  return replayAsSse(res, hit);
}
```

The cache is checked *before* the archive — it's the hotter path (in-memory
`Map`, microsecond lookup) and is keyed on a tighter canonicalization than
the archive (system + cacheable-prefix + tail vs the full messages list).

### Step 5 — Archive reuse lookup (when `X-Archive-Reuse: exact-match`)

```ts
if (req.headers["x-archive-reuse"] === "exact-match") {
  const hash = canonicalHash({ backendId, resolvedModel, system, messages, tools, tool_choice, max_tokens });
  const archived = archive.findByHash(hash);
  if (archived) {
    return replayAsSse(res, archived.responseBody);
  }
}
```

Opt-in only. Sampling params, metadata, and the stream flag are excluded
from the hash so they don't fragment hits.

### Step 6 — Translate to `NormalizedRequest`

```ts
const normalized = await anthropicRequestToNormalized(body, fileStore);
```

This step:

- Resolves any `file_<hash>` block references via `fileStore.resolveById`.
  Inlines them as `{ type: "image" | "document", mediaType, data: base64 }`.
- Applies the `tool_choice` directive as a system-prompt suffix (`"You must
  call exactly one tool this turn."` for `"any"`, etc.).
- Collapses `cache_control` markers (they were used in step 4 to identify
  the cacheable prefix; the backend doesn't need them).
- Validates that fields requiring backend support are honored — e.g.,
  rejecting `tool_use` blocks if `capabilities.toolUse === false`.

### Step 7 — Backend invocation

```ts
const stream = backend.invoke(normalized);
```

The backend's adapter:

- **Claude / Gemini:** spawns the CLI via the relevant runner. The runner
  yields raw JSON objects parsed from stdout NDJSON; the backend normalizes
  each into a `NormalizedEvent`. Stop sequences are enforced by the runner
  (tail-buffered match → `tree-kill` on the subprocess tree).
- **LM Studio / Ollama (compat mode):** `OpenAICompatClient.chatCompletions`
  sends `POST /v1/chat/completions` with `stream: true`, parses the SSE
  `data: {...}\n\n` chunks, normalizes to `NormalizedEvent`s.
- **Ollama (native mode):** `OllamaNativeClient.chat` sends `POST /api/chat`,
  parses NDJSON lines (`{"message": {"content": "..."}}\n`).

The async iterable is lazy — the backend yields events as soon as they're
parsed, so the response translator can flush per-event to the client.

### Step 8 — Translate to wire format

```ts
const sseStream = normalizedEventsToSSE(stream, { messageId, model: resolvedModel });
for await (const chunk of sseStream) {
  res.write(chunk);
}
res.end();
```

For Anthropic SSE, that means emitting:

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_...",...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

...

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":N,"output_tokens":N}}

event: message_stop
data: {"type":"message_stop"}
```

Per-event flush. The response translator manages content-block indices,
opening/closing blocks across `tool_use_*` events, and assembling the final
`message_delta` from the `message_stop` event's `stopReason` and `usage`.

### Step 9 — Post-completion side effects

```ts
// After the stream completes
if (cacheable) {
  responseCache.set(cacheKey, { body: aggregatedFinalResponse, metadata: { backendId, resolvedModel } });
}
recordCompletion(archive, {
  endpoint: "/v1/messages",
  backend: backend.id,
  modelResolved: resolvedModel,
  logId,
  startedAtMs,
  durationMs,
  status: "ok",
  inputTokens, outputTokens,
  requestBody: body,
  responseBody: aggregatedFinalResponse,
  sessionId: null
});
```

Both are fire-and-forget. `recordCompletion` uses `setImmediate` to defer the
archive write off the response path — a failure to write the archive must not
fail the client request.

### 4.1 OpenAI / Gemini variants

`POST /v1/chat/completions` follows the same shape with `src/openaiShim/` in
place of `src/anthropicShim/`. The differences:

- The cache reinterpretation path is absent (OpenAI shim doesn't honor
  `cache_control`).
- The legacy single-Claude `dist/openaiShim/` is still on disk for transitional
  pinning; the new multi-backend path lives in `src/openaiShim/`.
- The archive write uses the shared `recordCompletion` helper instead of the
  cache-key-derived hash the Anthropic shim uses (see [§11](#11-known-architectural-smells)).

`POST /v1beta/models/:model[:]generateContent` follows the same shape with
`src/geminiShim/` translators. Per-event SSE format is Gemini's
`data: {"candidates":[{"content":{"parts":[{"text":"..."}]}}]}\n\n`. The path
parser strips the `models/` prefix when present (see the colon-escape comment
in `src/server.ts` around line 142).

---

## 5. Discovery and routing

### 5.1 Probing

At startup, `main()` calls `registry.startPeriodicProbe(config.router.localProbeIntervalMs)`
(default 60 s). The first call inside that helper runs `probe()` immediately;
subsequent calls fire on the interval.

`probe()` iterates over every registered backend and calls `listModels()` in
parallel via `Promise.all`. Each backend's outcome is recorded in
`probeStatus.set(backend.id, { ok, lastProbedAt, error? })`. Failures are
caught per-backend and don't tear down the whole probe — one failed backend
returns 503 at request time, the others stay healthy.

`Claude` and `Gemini` backends serve their static `MODEL_CATALOG` from
`listModels()` — those don't change at runtime, so the periodic re-probe is
free for them. `LMStudio` and `Ollama` actually issue HTTP `GET /v1/models` (or
`GET /api/tags` in native mode) per instance and merge the results — that's
the load-bearing case the interval exists for.

### 5.2 Model map and collision resolution

```ts
private rebuildModelMap(successes: ProbeResult[]): void {
  const next = new Map<string, BackendId>();
  // Sort ascending by priority (low first) so high-priority entries
  // get written last and overwrite low-priority entries in the map.
  const sorted = [...successes].sort(
    (a, b) => (this.priorities[a.backendId] ?? 0) - (this.priorities[b.backendId] ?? 0)
  );
  for (const { backendId, models } of sorted) {
    for (const m of models) next.set(m.id, backendId);
  }
  this.modelMap = next;
}
```

If two backends advertise the same model id, the higher-priority backend
wins the bare-name lookup. The loser is still reachable via prefix override
(`lmstudio:work/qwen3-coder-30b`).

Default priorities (from `src/server.ts` `buildRegistry`):

| Backend | Priority |
|---|---|
| `claude` | 100 (config.claude.priority) |
| `gemini` | 90 (config.gemini.priority) |
| `lmstudio` | 50 |
| `ollama` | 40 |

So if both LM Studio and Ollama advertise `qwen3-coder-30b`, LM Studio wins
the bare-name lookup; Ollama is reachable as `ollama/qwen3-coder-30b`.

### 5.3 `modelRouter.identifyBackend`

The routing decision tree (see `src/modelRouter.ts`):

```
identifyBackend(model, defaultBackend)
├── model === "claude-code-cli"  → { backend: "claude", reason: "cli-sentinel" }
├── model === "gemini-cli"       → { backend: "gemini", reason: "cli-sentinel" }
├── model === undefined || "auto" || ""  → { backend: defaultBackend, reason: "default-backend" }
├── matches /^(claude|gemini|lmstudio|ollama)(?::([\w-]+))?\/(.+)$/
│       → { backend: <captured>, instance: <captured?>, remainingModel: <captured>, reason: "prefix-override" }
├── starts with "claude-" or in {opus, sonnet, haiku}
│       → { backend: "claude", reason: "anthropic-id-prefix" }
├── starts with "gemini-" or in {pro, flash, flash-lite}
│       → { backend: "gemini", reason: "google-id-prefix" }
└── otherwise → { backend: null, reason: "needs-registry-lookup" }
```

The `null` outcome is the cue for `messages.ts` to consult
`registry.resolveModel(model)` for bare local model names that aren't aliased.

The aliases are deliberately permissive — `opus`, `sonnet`, `haiku`, `pro`,
`flash`, `flash-lite` all claim their respective backends globally. A user who
has a local model literally named `opus` loaded in LM Studio must escape via
the prefix override: `lmstudio/opus`.

---

## 6. Data layout

The `data/` directory is the persistent state root. Default paths from
`configs/default.json`:

```
data/
├── archive.sqlite              # SQLite database (single table: entries)
├── archive.sqlite-wal          # WAL journal (WAL mode is mandatory — see archive.ts L113)
├── archive.sqlite-shm          # WAL shared memory
├── response-cache.json         # JSON-line dump of the response cache
├── sessions.json               # legacy session metadata (carryover from earlier iteration)
└── files/
    ├── <hash>                  # raw file bytes (named by sha256(content), 64 hex chars)
    └── <hash>.json             # sidecar metadata: {id, filename, mime, size, createdAt, lastAccessedAt}
```

### 6.1 Archive schema

```sql
CREATE TABLE IF NOT EXISTS entries (
  id              INTEGER PRIMARY KEY,
  request_hash    TEXT NOT NULL,           -- SHA-256 of canonicalized request
  log_id          TEXT NOT NULL,           -- request UUID for cross-referencing logs
  endpoint        TEXT NOT NULL,           -- e.g. "/v1/messages", "/v1/chat/completions",
                                           --      "...gemini-pro:generateContent"
  backend         TEXT NOT NULL,           -- "claude" | "gemini" | "lmstudio" | "ollama"
  model_resolved  TEXT,                    -- the resolved model id (may differ from requested)
  session_id      TEXT,
  timestamp       TEXT NOT NULL,           -- ISO-8601
  status          TEXT NOT NULL,           -- "ok" | "error" | "timeout"
  duration_ms     INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  request_body    BLOB NOT NULL,           -- zstd-compressed JSON
  response_body   BLOB NOT NULL            -- zstd-compressed JSON
);

CREATE INDEX IF NOT EXISTS idx_hash    ON entries(request_hash);
CREATE INDEX IF NOT EXISTS idx_time    ON entries(timestamp);
CREATE INDEX IF NOT EXISTS idx_session ON entries(session_id);
CREATE INDEX IF NOT EXISTS idx_backend ON entries(backend);
```

Compression: zstd at `config.archive.compressionLevel` (default 3, range 1-22).
Decompressed lazily on read (the admin endpoints inflate per-row). Tested with
both ends of the range — level 22 blobs are reliably smaller than level 1.

**Schema migration:** there is none. `CREATE TABLE IF NOT EXISTS` + `CREATE
INDEX IF NOT EXISTS` only. If you change the schema, existing databases
silently retain the old shape. To reset, delete `data/archive.sqlite*` and
let the next startup recreate.

### 6.2 File store layout

- One content file per upload, named by `sha256(bytes)`. Identical content
  uploaded twice resolves to the same file — the second upload bumps
  `lastAccessedAt` on the existing sidecar and returns the same ID.
- Sidecar JSON adjacent to each content file: `<hash>.json` with the
  `FileMetadata` shape.
- ID format on the wire: `file_<first-24-hex-of-sha256>`. The full hash on
  disk is 64 hex; the first 24 are sufficient for collision avoidance at
  the scales we care about and produce shorter URLs.

The Gemini shim renders the same ID as `files/<24hex>` (matching Google's
convention) via `toGeminiFileId`. `fileStore.resolveById` accepts either —
see [§8](#8-cross-shim-file-id-alias).

### 6.3 Response cache file

`data/response-cache.json` is one JSON object per line. Each line:

```json
{"key":"<64-hex>","value":{"body":{...},"metadata":{"backendId":"...","resolvedModel":"..."}},"createdAt":1234567890000,"lastAccessedAt":1234567890000}
```

Atomic write: write `.tmp` → fsync → rename. Corrupt lines are skipped on
load (a future compaction sweep could remove them — currently they accumulate
until the file is rotated manually).

### 6.4 Eviction summary

| Store | TTL | LRU cap | Sweep cadence |
|---|---|---|---|
| `archive.sqlite` | none (forever) | none | manual via `scripts/archive-prune.ts --before <YYYY-MM-DD>` or `--session <id>` |
| `data/files/` | `config.files.ttlMs` (default 7 days) | `config.files.maxTotalBytes` (default 5 GB) | every 5 min via `FileStore` interval timer |
| `data/response-cache.json` | `config.cache.ttlMs` (default 1 h) | `config.cache.maxEntries` (default 500) | on read (lazy TTL) + on write (LRU) |
| `SessionStore` (in-memory) | `config.adminUi.sessionTtlMs` (default 1 h) | none | every 60 s + lazy on `validate()` |

---

## 7. Response cache and `cache_control` reinterpretation

Anthropic's `cache_control: { type: "ephemeral" }` block normally tells the
upstream API to cache that prefix. The Claude CLI doesn't expose that machinery
to us, so ClaudeMCP reinterprets the marker locally:

1. Walk the request body's `messages[].content[]` and find the last block
   with `cache_control`. Everything up to and including that block is the
   **cacheable prefix**; everything after is the **tail**.
2. Canonicalize `(backendId, resolvedModel, system, prefix, tail, tools,
   toolChoice)` by NFC-normalizing strings and sorting object keys, then
   SHA-256 the JSON.
3. Look up the hash in the cache. On hit, replay as synthetic SSE.
4. On miss, run the backend normally, then store the aggregated final
   response under the key.

This is a hash-based cache, not a true prefix cache — a request that differs
in the tail by a single character is a miss. The trade-off is documented in
the spec: a true prefix cache would require backend cooperation (the upstream
API actually serving partial-prefix completions); we instead make it useful
as a "stable conversation prefix → same response" cache for agentic workflows
that replay the same intro turns.

`cache_creation_input_tokens` and `cache_read_input_tokens` are reported via
the local `tokenEstimator` — these are estimates, not authoritative counts.

---

## 8. Cross-shim file ID alias

One `FileStore`, two ID surfaces. The Anthropic and Gemini conventions differ:

| Shim | ID format | Example |
|---|---|---|
| Anthropic | `file_<24hex>` | `file_aaff112233445566778899aa` |
| Gemini | `files/<24hex>` | `files/aaff112233445566778899aa` |

Internally, both forms collapse to the same `sha256(bytes)` content key. The
two regex literals in `src/fileStore.ts`:

```ts
const ANTHROPIC_FILE_ID_RE = /^file_([0-9a-f]{24})$/;
const GEMINI_FILE_ID_RE    = /^files\/([0-9a-f]{24})$/;

export function normalizeFileId(id: string): string | null {
  if (ANTHROPIC_FILE_ID_RE.test(id)) return id;
  const gemini = GEMINI_FILE_ID_RE.exec(id);
  if (gemini) return `file_${gemini[1]}`;
  return null;
}
```

`fileStore.resolveById` calls `normalizeFileId` first, then dispatches to the
canonical Anthropic-form `get(id)`. The net effect:

- A client uploads via `POST /v1/files` (Anthropic shim). They receive
  `file_abc...`.
- A different (Gemini-SDK) client references the same content as
  `{ fileData: { fileUri: "files/abc..." } }`.
- The Gemini-shim request translator hands `files/abc...` to
  `fileStore.resolveById` → resolves to the same on-disk bytes → inlines as
  a `NormalizedContentBlock` → the backend (whichever it is) consumes it.

Dedup by SHA-256 means the same bytes uploaded via either shim use one
on-disk slot.

---

## 9. Auth and admin

### 9.1 Shared API key

A single `config.apiKey` authenticates all requests across all surfaces. The
key can be presented via any of four schemes (see `src/auth.ts`):

| Scheme | Header / param | Use case |
|---|---|---|
| `x-api-key` | header | Anthropic SDK default |
| `Authorization: Bearer <token>` | header | OpenAI SDK default |
| `x-goog-api-key` | header | Google Gemini SDK default |
| `?key=<key>` | query string | Google REST quickstarts |

`checkAuth` extracts whichever is present and compares with `timingSafeEqual`
against `config.apiKey`. The same function is called from every shim's
handler factory — no shim authenticates differently.

### 9.2 Admin UI session bridge

The admin UI is served from `/admin/ui` and stores its session token in an
HttpOnly cookie after the user posts the API key once. Subsequent admin
requests authenticate via either:

- The existing `x-api-key` header (programmatic clients), OR
- The session cookie (browser).

`src/server.ts` mounts a `sessionAuthMiddleware` for `/admin/*`:

```ts
const sessionAuthMiddleware: RequestHandler = (req, _res, next) => {
  if (typeof req.headers["x-api-key"] === "string" && req.headers["x-api-key"].length > 0) {
    next(); return;
  }
  const token = readSessionCookie(req);
  if (token && sessionStore.validate(token)) {
    // Promote the cookie session to an x-api-key header for downstream
    // handlers. This keeps the existing per-handler auth unchanged.
    req.headers["x-api-key"] = deps.config.apiKey;
  }
  next();
};
```

The bridge synthesizes an `x-api-key` header from a valid session cookie so
the existing `checkAuth` continues to work without per-handler awareness of
cookies. This is the Plan 12 design — sessions are an addition, not a
parallel auth path.

### 9.3 `bindLocalhost` middleware

`bindLocalhostMiddleware(getEnabled)` is mounted in front of *every*
`/admin/*` route via `mountAdminRoutes`. The crucial bit is that it
re-evaluates `getEnabled()` per request:

```ts
router.use(
  bindLocalhostMiddleware(() => deps.snapshot.current().adminUi.bindLocalhost)
);
```

So a `PATCH /admin/config` that flips `adminUi.bindLocalhost: false` takes
effect immediately for subsequent requests without rebuilding the
middleware stack.

When enabled (default), the middleware rejects any request whose `req.ip` is
not in the set `{ "127.0.0.1", "::1", "::ffff:127.0.0.1" }` with HTTP 403 +
an Anthropic-shaped error envelope. Operators behind a reverse proxy need
either `app.set("trust proxy", true)` (not enabled by default) or
`adminUi.bindLocalhost: false` (with a startup-time warning).

### 9.4 `ConfigSnapshotStore`

```ts
class ConfigSnapshotStore {
  private snapshot: Config;
  private readonly path: string;

  current(): Config { return this.snapshot; }

  replace(next: Config): Config {
    // Atomic write-then-swap: if the disk write throws, the in-memory
    // snapshot is unchanged and the exception propagates.
    atomicWriteJson(this.path, JSON.stringify(next, null, 2));
    this.snapshot = deepFreeze({ ...next });
    return this.snapshot;
  }
}
```

**In-flight semantics:** handlers that capture the live snapshot
(`bindLocalhostMiddleware`, admin handlers) get the new config on the next
call. Handlers that captured a `Config` value at startup (the Anthropic shim's
messages handler captures `apiKey` and `defaultBackend` once) keep their old
view — a deliberate scope boundary per Plan 11's "In-flight snapshot
semantics" section. The trade-off: in-flight requests see consistent state;
new requests pick up the change immediately.

---

## 10. Streaming, stop sequences, and tool use

### 10.1 SSE per-event flush

The response translator yields chunks as the backend emits events. Each
chunk is one SSE event (`event: ...\ndata: ...\n\n`). Express's underlying
`http.ServerResponse.write` writes immediately; we don't buffer above the
TCP layer. Clients see deltas in near-real time.

### 10.2 Stop sequences

| Backend `capabilities.stopSequences` | Implementation |
|---|---|
| `"native"` (LM Studio, Ollama) | Pass `stop_sequences` array through as `stop: [...]` in the upstream request. The runtime handles termination and emits a normal "stop" finish reason; backend normalizes to `message_stop { stopReason: "stop_sequence" }`. |
| `"server-side-cut"` (Claude, Gemini) | Stream runner maintains a rolling tail buffer of `max(stopSeq.length) - 1` bytes. On each text chunk, scans `(tail + chunk)` for any stop sequence. On match: kills the CLI subprocess tree via `tree-kill`, truncates accumulated text at the match boundary, emits `message_stop { stopReason: "stop_sequence" }`. |

Either way, the shim's response translator renders the stop event in its
wire format — clients see consistent behavior across backends.

### 10.3 Tool use

All four backends emit native tool-use events on the normalized stream:

- **Claude CLI:** `stream-json` emits `tool_use` content blocks natively.
  `claudeBackend` parses and re-emits as `tool_use_start` + `tool_use_delta` +
  `tool_use_stop`.
- **Gemini CLI:** emits `candidates[].content.parts[]` with
  `functionCall: { name, args }`. `geminiBackend` normalizes to the same trio.
- **LM Studio / Ollama (compat mode):** OpenAI `tool_calls` arrays in the SSE
  delta stream. `openaiCompatClient` parses; the backend re-emits.
- **Ollama (native mode):** `message.tool_calls` in the NDJSON stream.
  `ollamaNativeClient` parses.

Follow-up `tool_result` blocks in the next request are inlined identically
across all backends — the request translator re-renders them in each
backend's native protocol.

**Anthropic shim** always emits `tool_use` content blocks regardless of which
backend executed. **Gemini shim** always emits `functionCall` parts.
**OpenAI shim** retains its prompt-engineered emulation from the original
implementation (per the spec's parallel-shim decision — not backfilled).

---

## 11. Known architectural smells (flagged for future cleanup)

These are documented limitations the codebase carries today. Each is a
candidate for a future small spec.

### 11.1 Archive `request_hash` divergence

The Anthropic shim's `/v1/messages` handler synthesizes its archive
`request_hash` from the same canonical cache-key derivation it uses for
the response cache (so a cache-hit and an archive-hit on the same body
produce the same hash). The OpenAI and Gemini shims, by contrast, use the
shared `recordCompletion` helper, which hashes
`(endpoint, backend, modelResolved, requestBody)` — a coarser, shim-agnostic
shape.

Effect: an archive query by `request_hash` can find Anthropic entries with
one hash shape and OpenAI/Gemini entries with another. Search-by-hash isn't
broken (each shim is internally consistent), but cross-shim hash equality
isn't meaningful.

Future cleanup: unify on the shared `recordCompletion` hash, or move the
Anthropic shim to record both hashes. Trade-off: the cache-key-derived hash
is more precise (Anthropic shim can deduplicate by it usefully); the
generic hash is more comparable.

### 11.2 Streaming archive write buffers in memory

The OpenAI and Gemini streaming handlers tee the normalized event iterator —
one branch flushes to the client, the other accumulates into a final
response object for the archive. The accumulation is unbounded; a multi-megabyte
streaming response holds the full event list in memory until the stream
completes.

Effect: memory pressure on very large responses. Has not been observed in
practice (typical Claude/Gemini responses are <1 MB), but a tool-heavy
session that emits many large tool calls could be a problem.

Future cleanup: stream-to-disk for archive bodies above a size threshold, or
compress incrementally instead of at end-of-stream.

### 11.3 Periodic probe is unguarded against re-entrancy

`BackendRegistry.startPeriodicProbe` calls `void probe()` immediately, then
again on each interval tick. If a `probe()` invocation runs longer than the
interval (slow CLI listModels), two probes can run concurrently and the
second `rebuildModelMap` call wins. This is documented in
`src/backends/registry.ts` directly above `probe()`.

Effect: model map flickering during slow probes. Has not been observed
because all four current backends respond to `listModels()` in well under
the 60s default interval.

Future cleanup: add a `private probeInFlight: boolean` guard.

### 11.4 Two-shape `Backend.command`

The Claude and Gemini backend configs accept `command: string | string[]`:

```ts
command: z.union([z.string(), z.array(z.string()).nonempty()]).default("claude"),
```

The `string` form is the executable name. The `string[]` form is
prefix-args (`["wsl", "claude"]` to run the Claude CLI inside WSL). The
runners and tests handle both, but the duality is doc'd only at the config
schema and the runner option type.

Effect: a contributor reading `command: "claude"` in one place and
`command: ["wsl", "claude"]` in another may miss the shared semantic.

Future cleanup: normalize at config-load time to always-array form
internally, keep the string convenience at the schema layer.

---

## 12. Where to look next

- For a request walkthrough with actual file references, re-read
  [§4](#4-request-flow-deep-dive) alongside `src/anthropicShim/messages.ts`.
- For the capability matrix's enforcement, see each backend's
  `capabilitiesFor` and grep for `capabilitiesFor(` in `src/anthropicShim/`
  and `src/geminiShim/`.
- For the test matrix, see [development-guide.md](./development-guide.md) and
  `docs/plan-13-compat-tests-readme.md`.
- For the spec that drove the architecture, see
  `docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md`.
- For per-plan deviations and as-built notes, see `docs/plan-XX-*-readme.md`
  for each of plans 01-13, and `docs/deferred-items-fix-summary.md` for the
  post-plan-13 fix sprint.
