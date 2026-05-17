# ClaudeMCP User Manual

This manual teaches you how to USE a running ClaudeMCP server. For installation
and bootstrap see [deployment-guide.md](./deployment-guide.md); for tuning
config see [configuration-guide.md](./configuration-guide.md); for endpoint
shapes see [api-reference.md](./api-reference.md); for daily operations see
[operations-guide.md](./operations-guide.md).

---

## Overview

ClaudeMCP is a local LLM gateway that serves **three HTTP wire formats
simultaneously** on a single port:

| Wire format | Path prefix | Canonical SDK |
|---|---|---|
| Anthropic Messages | `/v1/messages*`, `/v1/anthropic/models*`, `/v1/files*` | [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) |
| OpenAI Chat Completions + Embeddings | `/v1/chat/completions`, `/v1/embeddings`, `/v1/models` | [`openai`](https://github.com/openai/openai-node) |
| Google Generative AI | `/v1beta/models/{model}:generateContent`, `/v1beta/files*` | [`@google/generative-ai`](https://github.com/google/generative-ai-js) |

Pick whichever SDK your codebase already uses. The translation between wire
formats is internal — your request lands in a backend-agnostic intermediate
representation and is rendered back into the response shape your SDK expects.

**Four backends** sit behind those shims:

- **Claude CLI** — invokes the local `claude` executable; routes Anthropic
  models (opus/sonnet/haiku) by default.
- **Gemini CLI** — invokes the local `gemini` executable; routes Google models
  (pro/flash/flash-lite).
- **LM Studio HTTP** — talks to the OpenAI-compatible local server LM Studio
  exposes on `http://localhost:1234` by default. Supports chat + embeddings.
- **Ollama HTTP** — talks to the local Ollama server on `http://localhost:11434`
  by default. Supports chat + embeddings. Defaults to OpenAI-compat mode; flip
  to native via `useNativeApi: true` for keep_alive/format/raw support.

You don't pick the backend explicitly per call. **Routing happens automatically
from the `model` field** of your request — `claude-opus-4-7` routes to Claude,
`gemini-pro` routes to Gemini, anything else (or a bare local model name) is
looked up against the registry of discovered LM Studio + Ollama models. You can
force-pick a backend with the `lmstudio/<model>` or `ollama:remote-1/<model>`
prefix syntax (see [Common workflows](#common-workflows)).

**Same single server** handles chat, embeddings, and file uploads. There's no
sidecar process for embeddings — `/v1/embeddings` routes requests to LM Studio
or Ollama based on the model id.

**Admin UI** is bundled and served at `/admin/ui` on the same port — no
separate admin daemon to run.

---

## Using the admin UI

The web admin SPA gives you at-a-glance backend health, on-the-fly config
edits, and an archive viewer for past requests. It's localhost-only by default.

### Opening the admin UI

```text
http://127.0.0.1:<port>/admin/ui
```

The default port is `3210`; check your deployment for the actual value.

Log in with the `apiKey` from your `config.json`. The login form exchanges the
key for an `HttpOnly` session cookie scoped to `/admin`; the cookie lives for
`adminUi.sessionTtlMs` (default 1 hour) and is auto-evicted on expiry.

### The five panels

#### Dashboard

At-a-glance summary across all backends:

- Reachability (green dot = `lastProbe.ok && reachable`, red dot otherwise).
- Last-probe timestamp and any error message.
- Recent request count (last hour, capped at 200 — suffixed `+` if more).
- Quick links to Backends / Archive panels for any reachable backend.

#### Backends

The full backend inventory:

- Per-backend list of model ids with capability badges
  (`toolUse`, `multimodal`, `thinking`, `cacheControl`, `samplingParams`,
  `stopSequences`, `embeddings`).
- "Reprobe" button — re-runs `BackendRegistry.probe()` against every backend
  immediately (don't wait for `localProbeIntervalMs`).
- "Test connection" form — type a `baseUrl` (+ optional apiKey + optional
  `useNativeApi: true` for Ollama native), and ClaudeMCP probes that URL to
  see if it responds with a usable model list. Useful for validating a new
  LM Studio install before persisting it to config.
- Per-instance add/remove (for LM Studio + Ollama; Claude + Gemini are
  single-instance CLIs).

#### Router

The routing logic between request-time `model` strings and concrete backends:

- **Default backend** — what the router falls through to when the model string
  doesn't carry an identifying prefix. Default `claude`.
- **Reasoning-effort map** — per-backend `{low, medium, high}` → model-id
  table. Pass `reasoning_effort: "low"` in your request to map to a smaller,
  cheaper model. (See [Common workflows](#common-workflows).)
- **Heuristic thresholds** — token/tool-count thresholds the router uses to
  auto-pick between sonnet and opus (or flash and pro) within a backend
  when the request leaves model unspecified or set to `"auto"`.

#### General

Server-wide settings:

- `apiKey` rotation (PUT new key; logs you out — re-log-in with the new key).
- Archive settings: db path, zstd compression level (1=fastest, 22=tightest).
- Cache settings: file path, TTL, max entries.
- Files settings: dir, TTL, max total bytes (default 5 GiB).
- AdminUI: enable/disable, bindLocalhost toggle (with a confirmation modal),
  session TTL.

#### Archive viewer

Paginated table of past requests with filters:

- Filter by backend, session id, model name, status (`ok`/`error`/`timeout`).
- Date-range filter via `since`/`until` (datetime-local inputs, converted to
  ISO-8601 on submit).
- Substring search via the `q` text box (matches request + response bodies).
- Click an entry id to drill into the full archived request + response JSON
  (decompressed from zstd on the fly).

### Theme toggle

Sun/moon button top-right toggles light ↔ dark. The preference is persisted to
`localStorage["claudemcp-theme"]`. First-visit defaults follow your OS's
`prefers-color-scheme` (light or dark). Theme switch is a single attribute
change on `<html>`; no full re-render.

### Logout

Logout button revokes the session token server-side and clears the cookie.
Subsequent admin requests must re-authenticate.

---

## Using the SDKs

Every SDK below assumes a running server at `http://127.0.0.1:3210` and an
`apiKey` of `"changeme"`. Replace with your actual values.

### Anthropic SDK (`@anthropic-ai/sdk`)

The Anthropic SDK speaks the wire format ClaudeMCP serves on `/v1/messages`.

```bash
npm install @anthropic-ai/sdk
```

#### Instantiate

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: "changeme",
  baseURL: "http://127.0.0.1:3210"
});
```

The SDK appends `/v1/messages` (and friends) automatically; pass the bare
server origin as `baseURL`.

#### Chat — non-streaming

```ts
const msg = await client.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Explain prompt caching in one paragraph." }]
});

console.log(msg.content[0].type === "text" ? msg.content[0].text : "");
console.log(msg.usage); // { input_tokens, output_tokens }
```

#### Chat — streaming (helper API)

```ts
const stream = client.messages.stream({
  model: "claude-sonnet-4-6",
  max_tokens: 512,
  messages: [{ role: "user", content: "Write a haiku about caching." }]
});

stream.on("text", (chunk) => process.stdout.write(chunk));
const final = await stream.finalMessage();
console.log("\n---\n", final.stop_reason, final.usage);
```

#### Chat — streaming (raw event iterator)

```ts
const stream = await client.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 256,
  stream: true,
  messages: [{ role: "user", content: "stream me" }]
});

for await (const event of stream) {
  if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
    process.stdout.write(event.delta.text);
  }
}
```

#### Count tokens

```ts
const res = await client.messages.countTokens({
  model: "claude-opus-4-7",
  messages: [{ role: "user", content: "how big is this?" }]
});
console.log(res.input_tokens); // number > 0
```

#### File upload

The Anthropic SDK 0.96 moved files to the `beta` namespace:

```ts
import { toFile } from "@anthropic-ai/sdk";

const content = Buffer.from("hello world", "utf-8");
const uploaded = await client.beta.files.upload({
  file: await toFile(content, "hello.txt", { type: "text/plain" })
});
// uploaded.id matches /^file_[0-9a-f]{24}$/
// uploaded.type === "file"

// List, retrieve, delete:
const list = await client.beta.files.list({ limit: 100 });
const retrieved = await client.beta.files.retrieveMetadata(uploaded.id);
const deleted = await client.beta.files.delete(uploaded.id);
// deleted.type === "file_deleted"
```

#### Reference an uploaded file in a message

```ts
const msg = await client.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  messages: [
    {
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "file", file_id: uploaded.id }
        },
        { type: "text", text: "Summarize this document." }
      ]
    }
  ]
});
```

The Anthropic shim also accepts the Gemini-shape file id `files/<24hex>` for
the same underlying content — see the cross-shim id alias in
[api-reference.md](./api-reference.md#cross-shim-file-id-alias).

#### Models list — caveat

The canonical `/v1/models` endpoint serves the **OpenAI-shape** envelope (so
that `openai` SDK clients can call `client.models.list()` without surprises).
The Anthropic-shape models response is relocated to `/v1/anthropic/models`.
The Anthropic SDK's `client.models.list()` doesn't expose a per-call baseURL
override, so use raw fetch:

```ts
const res = await fetch("http://127.0.0.1:3210/v1/anthropic/models?limit=20", {
  headers: { "x-api-key": "changeme" }
});
const page = await res.json();
// page.data[].type === "model"
// page.data[].id, page.data[].display_name, page.data[].created_at
```

Or set the SDK's `baseURL` to include `/anthropic` if you only need models
listing (other endpoints will then 404 — separate clients per use case).

#### Tool use — round-trip

```ts
const tools = [
  {
    name: "get_weather",
    description: "Get the current weather in a given city",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"]
    }
  }
];

// First turn: model decides to call the tool.
const first = await client.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  tools,
  messages: [{ role: "user", content: "What's the weather in Paris?" }]
});

// Find the tool_use block in the response.
const toolUse = first.content.find((b) => b.type === "tool_use");
if (!toolUse || toolUse.type !== "tool_use") throw new Error("no tool call");

// Second turn: execute the tool yourself, send the result back.
const second = await client.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  tools,
  messages: [
    { role: "user", content: "What's the weather in Paris?" },
    { role: "assistant", content: first.content },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({ city: "Paris", temp_c: 18, sky: "overcast" })
        }
      ]
    }
  ]
});
console.log(second.content); // model's natural-language answer
```

---

### OpenAI SDK (`openai`)

The OpenAI SDK speaks the wire format ClaudeMCP serves on
`/v1/chat/completions` and `/v1/embeddings`. **Pick any model id** — Anthropic,
Google, or a local LM Studio/Ollama model — the OpenAI shim dispatches across
all four backends.

```bash
npm install openai
```

#### Instantiate

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "changeme",
  baseURL: "http://127.0.0.1:3210/v1"
});
```

Note the `/v1` suffix — the OpenAI SDK appends `/chat/completions` directly,
not `/v1/chat/completions`.

#### Chat — non-streaming

```ts
const completion = await client.chat.completions.create({
  model: "claude-opus-4-7", // routes to Claude
  messages: [{ role: "user", content: "Hello, OpenAI-style." }]
});

console.log(completion.choices[0].message.content);
console.log(completion.usage); // { prompt_tokens, completion_tokens, total_tokens }
```

#### Chat — streaming

```ts
const stream = await client.chat.completions.create({
  model: "gemini-pro", // routes to Gemini
  messages: [{ role: "user", content: "stream me as Gemini" }],
  stream: true
});

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta.content;
  if (delta) process.stdout.write(delta);
}
```

#### Embeddings — LM Studio / Ollama only

```ts
const res = await client.embeddings.create({
  model: "nomic-embed-text-v1.5", // local model loaded in LM Studio or Ollama
  input: ["first input", "second input"]
});

for (const item of res.data) {
  console.log(item.index, item.embedding.slice(0, 5), "...");
}
console.log(res.usage); // { prompt_tokens, total_tokens } — populated by the deferred-items fix
```

Passing a Claude or Gemini model id (e.g. `claude-opus-4-7`) returns
`400 invalid_request_error` because those backends don't expose embeddings.

#### Function calling (caveat)

The OpenAI shim emulates function calling via prompt engineering rather than
native tool calls on every backend. The `tools` array on the request body is
translated to a system-prompt addendum; tool-call extraction parses the
model's text output for a `{tool_call: {...}}` JSON block. This works for
most use cases but is **less reliable than native tool calling**:

```ts
const completion = await client.chat.completions.create({
  model: "claude-opus-4-7",
  messages: [{ role: "user", content: "What's the weather in SF?" }],
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"]
        }
      }
    }
  ]
});

const toolCall = completion.choices[0].message.tool_calls?.[0];
if (toolCall) {
  const args = JSON.parse(toolCall.function.arguments);
  // execute get_weather(args.city) and round-trip via { role: "tool", tool_call_id, content }
}
```

For **native** tool use against Claude/Gemini backends, use the Anthropic or
Gemini SDK against the matching shim path instead — those translate to the
backend's native tool protocol directly.

#### Model selection

The OpenAI shim's router accepts any model id:

| Model id | Backend |
|---|---|
| `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5` | Claude |
| `opus`, `sonnet`, `haiku` (aliases) | Claude |
| `gemini-pro`, `gemini-flash`, `gemini-flash-lite` | Gemini |
| `pro`, `flash`, `flash-lite` (aliases) | Gemini |
| `llama-3.3-70b`, `nomic-embed-text-v1.5`, ... (anything else) | Registry lookup |
| `lmstudio/<model>`, `ollama/<model>` | Backend-forced prefix |
| `ollama:remote-1/<model>` | Backend + instance-forced prefix |

The Anthropic and Gemini aliases (`opus`/`sonnet`/`haiku`/`pro`/`flash`/...)
claim those bare names globally. If you have an LM Studio model literally
named `opus`, force-route to it via `lmstudio/opus`.

---

### Google GenerativeAI SDK (`@google/generative-ai`)

The Google SDK speaks the wire format ClaudeMCP serves on
`/v1beta/models/*:generateContent`. The Gemini shim dispatches to whichever
backend resolves the requested model id — so this SDK can drive Claude, LM
Studio, and Ollama backends too (cross-backend translation).

```bash
npm install @google/generative-ai
```

(The successor package `@google/genai` has an incompatible wire format and is
NOT supported by the shim. Use `@google/generative-ai@0.24.x`.)

#### Instantiate

```ts
import { GoogleGenerativeAI } from "@google/generative-ai";

const client = new GoogleGenerativeAI("changeme");

const model = client.getGenerativeModel(
  { model: "gemini-pro" },
  { baseUrl: "http://127.0.0.1:3210" }
);
```

#### Generate — non-streaming

```ts
const result = await model.generateContent("Hello, Gemini-style.");
console.log(result.response.text());
console.log(result.response.usageMetadata);
// { promptTokenCount, candidatesTokenCount, totalTokenCount }
```

#### Generate — streaming

```ts
const result = await model.generateContentStream("stream me as Gemini");

for await (const chunk of result.stream) {
  process.stdout.write(chunk.text());
}

const final = await result.response;
console.log("\n---\n", final.candidates![0]!.finishReason);
```

#### Count tokens

The Google SDK wraps `countTokens` payloads as
`{generateContentRequest: {contents: [...]}}`. The Gemini shim accepts both
that wrapped form AND the bare `{contents: [...]}` form (per the deferred-items
fix sprint), so `model.countTokens(...)` works directly:

```ts
const res = await model.countTokens("count these tokens please");
console.log(res.totalTokens); // number > 0
```

#### Cross-backend routing

The model id selects the backend:

```ts
// Routes to the Claude backend, translated through the Gemini wire format.
const claudeViaGemini = client.getGenerativeModel(
  { model: "claude-opus-4-7" },
  { baseUrl: "http://127.0.0.1:3210" }
);
const r = await claudeViaGemini.generateContent("hello from Google SDK -> Claude");
console.log(r.response.text());
```

#### File upload

The Google SDK's `GoogleAIFileManager.uploadFile` posts a `multipart/related`
body to `/upload/v1beta/files`. The shim mounts that alias against the same
in-memory upload handler (one-shot only; resumable two-step handshake is
NOT implemented):

```ts
import { GoogleAIFileManager } from "@google/generative-ai/server";

const fm = new GoogleAIFileManager("changeme", {
  baseUrl: "http://127.0.0.1:3210"
});

const buf = Buffer.from("hello upload bytes");
const uploaded = await fm.uploadFile(buf, {
  mimeType: "text/plain",
  displayName: "hello.txt"
});
// uploaded.file.name starts with "files/" (Gemini id format)
// uploaded.file.uri points back to /v1beta/files/<id>:download on this server

// Reference in a generation:
const r = await model.generateContent([
  { fileData: { mimeType: "text/plain", fileUri: uploaded.file.name } },
  "Summarize this file."
]);

// Delete when done.
await fm.deleteFile(uploaded.file.name);
```

---

## Common workflows

### Switch a model across providers without changing SDK

Keep the same SDK; change the `model` string. The model-prefix router picks
the backend automatically.

```ts
// Anthropic SDK can drive any backend:
await anthropic.messages.create({ model: "claude-opus-4-7", ... });    // Claude
await anthropic.messages.create({ model: "gemini-pro", ... });          // Gemini
await anthropic.messages.create({ model: "llama-3.3-70b", ... });       // LM Studio/Ollama (lookup)
await anthropic.messages.create({ model: "lmstudio/llama-3.3-70b", ... });  // forced LM Studio
```

The Anthropic and Gemini shims accept any model id this way — the response is
always rendered in the SDK's expected shape.

### Get faster responses for short prompts

Pass `reasoning_effort: "low"` on an Anthropic-shape request:

```ts
await anthropic.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 256,
  reasoning_effort: "low",
  messages: [{ role: "user", content: "two-line summary please" }]
});
```

The router consults `config.router.reasoningEffortMap.claude.low` (default
`claude-haiku-4-5`) and routes there instead of opus. Same for `medium` and
`high`. Configure the map in the admin UI Router panel.

### Hit a local model

1. Load the model in LM Studio (or `ollama pull <model>`).
2. Reference it by its bare name OR force-pick the backend:

```ts
// Bare name — registry lookup picks the first backend that hosts it.
await openai.chat.completions.create({
  model: "qwen2.5-coder-32b",
  messages: [...]
});

// Forced — explicit backend wins.
await openai.chat.completions.create({
  model: "lmstudio/qwen2.5-coder-32b",
  messages: [...]
});

// Forced — explicit backend + instance (when you have multiple LM Studios).
await openai.chat.completions.create({
  model: "lmstudio:gaming-rig/qwen2.5-coder-32b",
  messages: [...]
});
```

### Upload a PDF once, reference many times

```ts
// Once:
const uploaded = await anthropic.beta.files.upload({
  file: await toFile(fs.readFileSync("report.pdf"), "report.pdf", { type: "application/pdf" })
});
const fileId = uploaded.id; // save this

// Every subsequent call:
await anthropic.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 2048,
  messages: [{
    role: "user",
    content: [
      { type: "document", source: { type: "file", file_id: fileId } },
      { type: "text", text: "What did the customer ask for on page 3?" }
    ]
  }]
});
```

Files persist for `config.files.ttlMs` (default 7 days). The store evicts the
oldest files once `config.files.maxTotalBytes` is hit (default 5 GiB).

### Avoid recomputing expensive prompts

Mark the cacheable prefix with `cache_control: {type: "ephemeral"}`:

```ts
await anthropic.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  messages: [
    {
      role: "user",
      content: [
        // Long, stable system context — gets cached.
        {
          type: "text",
          text: BIG_DOCUMENT_OR_INSTRUCTIONS,
          cache_control: { type: "ephemeral" }
        },
        // Per-call variable suffix — not cached.
        { type: "text", text: "Now answer: What is the SLA in section 4.2?" }
      ]
    }
  ]
});
```

This is a **local cache** — ClaudeMCP saves the round-trip when the same
prefix is sent again within `config.cache.ttlMs` (default 1 hour). It does
NOT replicate Anthropic's real prompt-caching cost savings (those are a
server-side GPU feature on Anthropic's infrastructure).

### See what I sent yesterday

Open the admin UI → Archive panel:

- Set `since` to yesterday 00:00 and `until` to today 00:00 (via the
  datetime-local inputs).
- Optionally narrow by `backend`, `model`, `session`, or status.
- Substring-search request/response bodies via the `q` text box.
- Click any row id to see the full request + response JSON.

Programmatic access: `GET /admin/archive?since=...&until=...` — see
[api-reference.md](./api-reference.md#admin).

---

## Caveats and limitations

### Sampling parameters

`temperature`, `top_p`, `top_k`:
- **LM Studio / Ollama:** honored — forwarded to the backend.
- **Claude / Gemini CLI:** silently ignored — the local CLIs don't accept
  per-request sampling overrides. Set these via your CLI's own config or via
  the Anthropic/Google online APIs (not via ClaudeMCP CLI backends).

### Citations

The Anthropic Messages API supports `citations` blocks. ClaudeMCP **never**
honors citations on any backend — they're surface-only on Anthropic's hosted
API and the local `claude` CLI doesn't expose them.

### Prompt caching

Real Anthropic prompt caching cost savings (the 90% input-token discount on
cache hits) is a **server-side feature on Anthropic's GPUs**, not replicable
locally. The `cache_control` block IS honored — it triggers a **local
response cache** that skips the backend round-trip when the same prefix is
seen again within TTL. That avoids latency and CLI invocation cost, but
doesn't reduce any "cloud" bill.

### Multimodal

Image and document inputs are honored only when the **chosen model** supports
them:

| Backend | Multimodal? |
|---|---|
| Claude (opus/sonnet) | Yes (image + document) |
| Claude (haiku) | Image only |
| Gemini (pro/flash) | Yes |
| LM Studio | Model-dependent (vision models like `llava` work; text-only models reject) |
| Ollama | Model-dependent (same) |

The shim does NOT validate model-vs-content combinations up front — a vision
input to a text-only model returns whatever error the backend emits (often a
500-class).

### Ollama API mode

Ollama exposes both an OpenAI-compatible API (`/v1/chat/completions`) and a
native API (`/api/chat`, `/api/tags`). By default, ClaudeMCP talks the
OpenAI-compat API, which is simpler but **doesn't expose** these Ollama-only
parameters:

- `keep_alive` (control how long the model stays loaded)
- `format: "json"` (force structured output)
- `raw: true` (skip template formatting)
- `options.*` (Ollama-specific generation options)

To access those, flip the backend (or per-instance) to native mode:

```jsonc
// config.json
{
  "ollama": {
    "enabled": true,
    "useNativeApi": true,             // global default for Ollama
    "instances": [
      {
        "name": "main",
        "baseUrl": "http://127.0.0.1:11434",
        "useNativeApi": null           // null = inherit global; true = force native; false = force compat
      }
    ]
  }
}
```

Or edit via the admin UI Backends panel.

### Embeddings

- Only LM Studio and Ollama backends expose embeddings.
- Claude and Gemini model ids return `400 invalid_request_error` from
  `/v1/embeddings` (Anthropic doesn't expose embeddings; Gemini embeddings are
  intentionally deferred per spec Phase 10).
- `config.embeddings.legacyBackendUrl` exists for proxying to an existing
  separate embeddings server (legacy migration path). Leave empty in normal
  operation.

### Files

- File upload size is bounded by `config.files.maxTotalBytes` (default 5 GiB)
  store-wide, not per-file. Pruning is FIFO by oldest.
- `config.files.ttlMs` (default 7 days) is a TTL from last access, not from
  upload — actively referenced files don't expire mid-conversation.
- File ids cross-alias: an `file_<24hex>` upload via the Anthropic shim is
  readable as `files/<24hex>` via the Gemini shim, and vice versa. They
  resolve to the same on-disk bytes (the 24-hex part is a SHA-256 prefix).

### Authentication

- The `apiKey` is a single shared secret. There's no per-user / per-team
  separation yet.
- All four auth schemes (`x-api-key`, `Authorization: Bearer`,
  `x-goog-api-key`, `?key=`) check the same key.
- Rotate via the admin UI General panel; PUT-style rotation requires the
  current key in `x-api-key` and invalidates existing session cookies.

### Admin UI scope

Not in scope (deferred):

- Log streaming over WebSocket (use the JSON archive endpoints instead).
- In-UI request replay.
- In-UI prompt playground.
- Multi-user audit log.
- Theme customization beyond light/dark.
- Persistent sessions across restarts (in-memory; restart re-logs everyone out).

---

## Where to go next

- **Endpoint shapes, error envelopes, full request/response surface:**
  [api-reference.md](./api-reference.md)
- **Tuning config values:**
  [configuration-guide.md](./configuration-guide.md)
- **Daily ops, log locations, troubleshooting:**
  [operations-guide.md](./operations-guide.md)
- **Internal architecture:**
  [technical-manual.md](./technical-manual.md)
- **Contributing changes:**
  [development-guide.md](./development-guide.md)
