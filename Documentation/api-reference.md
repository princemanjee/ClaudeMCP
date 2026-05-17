# ClaudeMCP API Reference

Endpoint-by-endpoint reference. For task-oriented walkthroughs see
[user-manual.md](./user-manual.md); for config tuning see
[configuration-guide.md](./configuration-guide.md); for ops see
[operations-guide.md](./operations-guide.md).

All examples assume `http://127.0.0.1:3210` and `apiKey: "changeme"`.

---

## Table of contents

- [Auth](#auth)
- [Anthropic shim](#anthropic-shim)
  - [`POST /v1/messages`](#post-v1messages)
  - [`POST /v1/messages/count_tokens`](#post-v1messagescount_tokens)
  - [`GET /v1/anthropic/models`](#get-v1anthropicmodels)
  - [`GET /v1/anthropic/models/{id}`](#get-v1anthropicmodelsid)
  - [`POST /v1/files`](#post-v1files)
  - [`GET /v1/files`](#get-v1files)
  - [`GET /v1/files/{id}`](#get-v1filesid)
  - [`GET /v1/files/{id}/content`](#get-v1filesidcontent)
  - [`DELETE /v1/files/{id}`](#delete-v1filesid)
- [OpenAI shim](#openai-shim)
  - [`POST /v1/chat/completions`](#post-v1chatcompletions)
  - [`POST /v1/embeddings`](#post-v1embeddings)
  - [`GET /v1/models`](#get-v1models)
  - [`GET /v1/models/{id}`](#get-v1modelsid)
- [Gemini shim](#gemini-shim)
  - [`POST /v1beta/models/{model}:generateContent`](#post-v1betamodelsmodelgeneratecontent)
  - [`POST /v1beta/models/{model}:streamGenerateContent`](#post-v1betamodelsmodelstreamgeneratecontent)
  - [`POST /v1beta/models/{model}:countTokens`](#post-v1betamodelsmodelcounttokens)
  - [`GET /v1beta/models`](#get-v1betamodels)
  - [`GET /v1beta/models/{id}`](#get-v1betamodelsid)
  - [`POST /v1beta/files` and `POST /upload/v1beta/files`](#post-v1betafiles-and-post-uploadv1betafiles)
  - [`GET /v1beta/files`](#get-v1betafiles)
  - [`GET /v1beta/files/{id}`](#get-v1betafilesid)
  - [`GET /v1beta/files/{id}:download`](#get-v1betafilesiddownload)
  - [`DELETE /v1beta/files/{id}`](#delete-v1betafilesid)
- [Admin](#admin)
  - [`GET /admin/archive`](#get-adminarchive)
  - [`GET /admin/archive/search`](#get-adminarchivesearch)
  - [`GET /admin/archive/{id}`](#get-adminarchiveid)
  - [`GET /admin/backends`](#get-adminbackends)
  - [`POST /admin/backends/reprobe`](#post-adminbackendsreprobe)
  - [`POST /admin/backends/test`](#post-adminbackendstest)
  - [`GET /admin/config`](#get-adminconfig)
  - [`PUT /admin/config`](#put-adminconfig)
  - [`PATCH /admin/config`](#patch-adminconfig)
- [Admin UI](#admin-ui)
  - [`GET /admin/ui` and `GET /admin/ui/*`](#get-adminui-and-get-adminui)
  - [`POST /admin/ui/session`](#post-adminuisession)
  - [`DELETE /admin/ui/session`](#delete-adminuisession)
- [Health](#health)
- [Error envelope shapes](#error-envelope-shapes)
- [Cross-shim file ID alias](#cross-shim-file-id-alias)
- [Backend capability matrix](#backend-capability-matrix)

---

## Auth

Every endpoint **except** `GET /health` and the `/admin/ui*` static assets
(HTML/CSS/JS) requires authentication.

Four accepted schemes — pick whichever matches your client SDK. All four
compare against the same single `config.apiKey` using a constant-time
comparator:

| Scheme | Header / param | Common in |
|---|---|---|
| Anthropic | `x-api-key: <key>` | Anthropic SDK |
| OpenAI | `Authorization: Bearer <key>` | OpenAI SDK |
| Google | `x-goog-api-key: <key>` | Google GenAI SDK |
| Google fallback | `?key=<key>` query string | Google REST GET fallback |

Admin endpoints (`/admin/*`) additionally accept a session cookie issued by
`POST /admin/ui/session`:

```http
Cookie: claudemcp_session=<opaque-token>
```

Session cookies are `HttpOnly`, `SameSite=Strict`, `Path=/admin`, with
`Max-Age=<config.adminUi.sessionTtlMs / 1000>`. The session middleware
synthesizes an `x-api-key` header on cookie-bearing requests so per-handler
auth checks pass uniformly.

Missing/invalid auth returns **401** with the wire-format-appropriate error
envelope ([see below](#error-envelope-shapes)).

---

## Anthropic shim

Source-of-truth wire format: [Anthropic Messages API docs](https://docs.anthropic.com/en/api/messages).
Error envelope: `{type: "error", error: {type, message}}`.

### `POST /v1/messages`

Send a Messages-API request to any backend. Routing follows the `model` field
([see modelRouter](../src/modelRouter.ts)).

**Request body** (`AnthropicMessagesRequest`):

```json
{
  "model": "claude-opus-4-7",
  "max_tokens": 1024,
  "stream": false,
  "system": "You are a helpful assistant.",
  "messages": [
    { "role": "user", "content": "Hello." }
  ],
  "temperature": 0.7,
  "top_p": 0.9,
  "top_k": 40,
  "stop_sequences": ["END"],
  "tools": [
    {
      "name": "get_weather",
      "description": "Get current weather",
      "input_schema": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"]
      }
    }
  ],
  "tool_choice": { "type": "auto" },
  "metadata": { "user_id": "abc" },
  "thinking": null
}
```

- `model` (required) — any model id; the router picks the backend.
- `max_tokens` (required by Anthropic spec; the shim accepts requests
  without it and defaults internally).
- `messages` (required) — array of `{role, content}`. `content` is a string
  shorthand OR an array of content blocks: `text`, `image`, `document`,
  `tool_use`, `tool_result`.
- `system` — string or array of text blocks.
- `stream` — `true` for SSE; defaults to `false`.
- `temperature`, `top_p`, `top_k`, `stop_sequences` — honored on
  LM Studio / Ollama; silently ignored on Claude / Gemini CLI backends.
- `tools`, `tool_choice` — native tool use; translated per-backend.
- `metadata`, `thinking` — forwarded to Claude backend; ignored elsewhere.

Content blocks may carry a `cache_control: {type: "ephemeral"}` marker to
enable local response caching of the prefix up through the marker.

**Image / document sources:**

```json
{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBORw0..." } }
{ "type": "image", "source": { "type": "url", "url": "https://example.com/x.png" } }
{ "type": "document", "source": { "type": "file", "file_id": "file_0123456789abcdef01234567" } }
```

**Response body — non-streaming** (`AnthropicMessagesResponse`):

```json
{
  "id": "msg_5a2c1e9f3b8d7e6c4a0f9b21",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-4-7",
  "content": [
    { "type": "text", "text": "Hello! How can I help today?" }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 12, "output_tokens": 8 }
}
```

`stop_reason` is one of: `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`.

When the model calls a tool, the `content` array includes a `tool_use` block:

```json
{
  "content": [
    { "type": "text", "text": "Let me check the weather." },
    {
      "type": "tool_use",
      "id": "toolu_01abc23def45...",
      "name": "get_weather",
      "input": { "city": "Paris" }
    }
  ],
  "stop_reason": "tool_use"
}
```

**Response body — streaming**: `Content-Type: text/event-stream`. Event
sequence:

```
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":8}}

event: message_stop
data: {"type":"message_stop"}
```

**Errors:**

| Status | `error.type` | Cause |
|---|---|---|
| 400 | `invalid_request_error` | Bad/unparseable body, unsupported block shape |
| 401 | `authentication_error` | Missing/invalid API key |
| 404 | `not_found_error` | `model` doesn't resolve to any backend |
| 500 | `api_error` | Backend invocation failed unexpectedly |

---

### `POST /v1/messages/count_tokens`

Estimate input token count without invoking the backend.

**Request body**: same shape as `/v1/messages` (the system + messages + tools
fields are counted).

**Response body**:

```json
{ "input_tokens": 47 }
```

Token count is an estimate via `@anthropic-ai/tokenizer` (Claude) or a
char/4 heuristic (other backends).

**Errors:** same as `/v1/messages`.

---

### `GET /v1/anthropic/models`

Relocated from `/v1/models` by Plan 10 — the canonical `/v1/models` serves the
OpenAI-shape envelope so the dominant SDK target is honored. The
Anthropic-shape envelope is here.

**Query params:**

| Name | Default | Notes |
|---|---|---|
| `limit` | (no limit) | Currently unpaginated; field accepted for SDK compat |

**Response body** (`AnthropicModelsListResponse`):

```json
{
  "data": [
    {
      "type": "model",
      "id": "claude-opus-4-7",
      "display_name": "Claude Opus 4.7",
      "created_at": "2026-01-01T00:00:00Z"
    },
    {
      "type": "model",
      "id": "gemini-pro",
      "display_name": "Gemini Pro",
      "created_at": "2026-01-01T00:00:00Z"
    }
  ],
  "has_more": false,
  "first_id": "claude-opus-4-7",
  "last_id": "gemini-pro"
}
```

`created_at` is a placeholder (`2026-01-01T00:00:00Z`) when the backend
doesn't expose a release date.

**Errors:** 401, 500.

---

### `GET /v1/anthropic/models/{id}`

Fetch a single model.

**Response body** (`AnthropicModelEntry`):

```json
{
  "type": "model",
  "id": "claude-opus-4-7",
  "display_name": "Claude Opus 4.7",
  "created_at": "2026-01-01T00:00:00Z"
}
```

**Errors:** 401, 404 (`not_found_error`), 500.

---

### `POST /v1/files`

Upload a file. Multipart form-data; one `file` field.

**Request:**

```http
POST /v1/files HTTP/1.1
Content-Type: multipart/form-data; boundary=----abc

------abc
Content-Disposition: form-data; name="file"; filename="report.pdf"
Content-Type: application/pdf

<bytes>
------abc--
```

**Response body**:

```json
{
  "id": "file_0123456789abcdef01234567",
  "type": "file",
  "filename": "report.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 124883,
  "created_at": "2026-05-17T10:14:22.000Z"
}
```

The id is `file_<24hex>` where the hex is a SHA-256 prefix of the bytes.

**Errors:**

| Status | Cause |
|---|---|
| 400 | Empty body, not multipart, no file field |
| 401 | Auth |
| 500 | Disk write failed |

---

### `GET /v1/files`

List uploaded files.

**Query params:**

| Name | Default | Max |
|---|---|---|
| `limit` | 20 | 1000 |
| `offset` | 0 | — |

**Response body**:

```json
{
  "data": [
    {
      "id": "file_...",
      "type": "file",
      "filename": "report.pdf",
      "mime_type": "application/pdf",
      "size_bytes": 124883,
      "created_at": "2026-05-17T10:14:22.000Z"
    }
  ],
  "has_more": false
}
```

---

### `GET /v1/files/{id}`

Get file metadata.

**Response body**: same shape as a single entry from `GET /v1/files`.

**Errors:** 401, 404.

Accepts either the Anthropic form `file_<24hex>` or the Gemini form
`files/<24hex>` — they resolve to the same content
([see cross-shim alias](#cross-shim-file-id-alias)).

---

### `GET /v1/files/{id}/content`

Download the file bytes.

**Response:**

```http
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Length: 124883

<bytes>
```

**Errors:** 401, 404.

---

### `DELETE /v1/files/{id}`

Delete a file.

**Response body**:

```json
{ "id": "file_0123456789abcdef01234567", "type": "file_deleted" }
```

Always returns 200 even if the file was already gone (idempotent).

---

## OpenAI shim

Source-of-truth wire format: [OpenAI Chat Completions docs](https://platform.openai.com/docs/api-reference/chat).
Error envelope: `{error: {message, type, param, code}}`.

### `POST /v1/chat/completions`

Multi-backend chat completions. Dispatches by `model`.

**Request body** (`OpenAIChatCompletionsRequest`):

```json
{
  "model": "claude-opus-4-7",
  "messages": [
    { "role": "system", "content": "You are concise." },
    { "role": "user", "content": "Hello." }
  ],
  "stream": false,
  "temperature": 0.7,
  "top_p": 0.9,
  "max_tokens": 1024,
  "max_completion_tokens": 1024,
  "stop": ["END"],
  "n": 1,
  "presence_penalty": 0,
  "frequency_penalty": 0,
  "seed": 42,
  "response_format": { "type": "text" },
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather",
        "parameters": {
          "type": "object",
          "properties": { "city": { "type": "string" } },
          "required": ["city"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "user": "user-123"
}
```

Notes:

- `model` accepts any id; routing identical to Anthropic shim.
- `n > 1`, `image_url` content parts, `response_format` JSON-mode, and native
  `tool_calls` are NOT honored — request translator either 400s or
  silently flattens.
- `logprobs`, `top_logprobs`, `audio`, `modalities`, `prediction`,
  `service_tier`, `store` are accepted-and-ignored.
- Tool use is **emulated** via prompt engineering (not native). For native
  tool calling against Claude/Gemini, use those SDKs against their respective
  shims.

**Response body — non-streaming** (`OpenAIChatCompletionResponse`):

```json
{
  "id": "chatcmpl-5a2c1e9f3b8d7e6c4a0f9b2104ab",
  "object": "chat.completion",
  "created": 1747476862,
  "model": "claude-opus-4-7",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help?",
        "refusal": null
      },
      "finish_reason": "stop",
      "logprobs": null
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 6,
    "total_tokens": 18
  }
}
```

`finish_reason`: `stop`, `length`, `tool_calls`, `content_filter`, or `null`.

`usage` is omitted when the backend doesn't emit token counts (e.g.
mock-Claude in tests).

**Response body — streaming**: `Content-Type: text/event-stream`. Each event
is a JSON-encoded chunk:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1747476862,"model":"claude-opus-4-7","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null,"logprobs":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1747476862,"model":"claude-opus-4-7","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null,"logprobs":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1747476862,"model":"claude-opus-4-7","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null,"logprobs":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1747476862,"model":"claude-opus-4-7","choices":[{"index":0,"delta":{},"finish_reason":"stop","logprobs":null}]}

data: [DONE]
```

**Errors:**

| Status | `error.type` | Cause |
|---|---|---|
| 400 | `invalid_request_error` | Bad body |
| 401 | `authentication_error` | Auth |
| 404 | `not_found_error` | Model not found (`code: "model_not_found"`) |
| 500 | `api_error` | Backend failure |

---

### `POST /v1/embeddings`

Compute embeddings. Routes to LM Studio or Ollama based on the model id.

**Request body** (`OpenAIEmbeddingsRequest`):

```json
{
  "model": "nomic-embed-text-v1.5",
  "input": ["first text", "second text"],
  "encoding_format": "float",
  "dimensions": 768,
  "user": "user-123"
}
```

- `input` — string or array of strings.
- `encoding_format` — `"float"` (default) or `"base64"`.

**Response body** (`OpenAIEmbeddingsResponse`):

```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "embedding": [0.012, -0.034, 0.567, ...],
      "index": 0
    },
    {
      "object": "embedding",
      "embedding": [0.045, 0.123, -0.234, ...],
      "index": 1
    }
  ],
  "model": "nomic-embed-text-v1.5",
  "usage": {
    "prompt_tokens": 6,
    "total_tokens": 6
  }
}
```

`usage` is populated on every successful response (deferred-items fix Issue 6
— char/4 estimate, total_tokens === prompt_tokens for embeddings).

When `encoding_format: "base64"`, `embedding` is a base64-encoded `Float32`
buffer (4 bytes per dimension, little-endian) rather than a number array.

**Errors:**

| Status | `error.type` | Cause |
|---|---|---|
| 400 | `invalid_request_error` | Bad body, OR `model` is Claude/Gemini (no embeddings support) |
| 401 | `authentication_error` | Auth |
| 404 | `not_found_error` | Model not found |
| 502 | `api_error` | Legacy embeddings proxy failed (when `legacyBackendUrl` is set) |
| 504 | `api_error` | Legacy embeddings proxy timeout |

---

### `GET /v1/models`

Canonical models endpoint. Returns the **OpenAI-shape** envelope across all
backends.

**Response body** (`OpenAIModelsListResponse`):

```json
{
  "object": "list",
  "data": [
    {
      "id": "claude-opus-4-7",
      "object": "model",
      "created": 1735689600,
      "owned_by": "claude"
    },
    {
      "id": "gemini-pro",
      "object": "model",
      "created": 1735689600,
      "owned_by": "gemini"
    },
    {
      "id": "llama-3.3-70b",
      "object": "model",
      "created": 1735689600,
      "owned_by": "lmstudio"
    }
  ]
}
```

`created` is a placeholder Unix epoch (`2025-01-01T00:00:00Z`).

`owned_by` is the backend id: `"claude" | "gemini" | "lmstudio" | "ollama"`.

For the Anthropic-shape models response, see
[`GET /v1/anthropic/models`](#get-v1anthropicmodels).

---

### `GET /v1/models/{id}`

Fetch a single model in OpenAI shape.

**Response body** (`OpenAIModelEntry`): same shape as a single `data[]` entry
from `GET /v1/models`.

**Errors:** 401, 404 (`code: "model_not_found"`).

---

## Gemini shim

Source-of-truth wire format: [Google Generative AI REST docs](https://ai.google.dev/api/rest/v1beta/models/generateContent).
Error envelope: `{error: {code, message, status}}`.

The Express path-to-regexp parser treats `:` as a parameter sigil. The shim
escapes it via `[:]` and provides both bare-id (`/v1beta/models/<id>:action`)
and double-wrap (`/v1beta/models/models/<id>:action`) route variants because
some SDK versions construct the URL with the `models/` prefix already in the
model name.

### `POST /v1beta/models/{model}:generateContent`

Generate content non-streaming. The Gemini shim dispatches to whichever
backend resolves the requested model id.

**Request body** (`GeminiGenerateContentRequest`):

```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        { "text": "Hello, Gemini." }
      ]
    }
  ],
  "systemInstruction": "You are a helpful assistant.",
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "get_weather",
          "description": "Get current weather",
          "parameters": {
            "type": "object",
            "properties": { "city": { "type": "string" } },
            "required": ["city"]
          }
        }
      ]
    }
  ],
  "toolConfig": {
    "functionCallingConfig": {
      "mode": "AUTO"
    }
  },
  "generationConfig": {
    "temperature": 0.7,
    "topP": 0.9,
    "topK": 40,
    "candidateCount": 1,
    "maxOutputTokens": 1024,
    "stopSequences": ["END"]
  },
  "safetySettings": []
}
```

- `contents` (required) — array of `{role?, parts: [...]}`. Parts can be
  `text`, `inlineData` (base64 + mimeType), `fileData` (fileUri reference),
  `functionCall`, `functionResponse`.
- `systemInstruction` — string OR `{parts: [...]}` OR raw `parts[]` array.
- `tools` — `functionDeclarations` honored; `googleSearchRetrieval` and
  `codeExecution` return 400.
- `safetySettings` — accepted and ignored.
- `cachedContent` — rejected with 400 (context caching not implemented).

**Response body** (`GeminiGenerateContentResponse`):

```json
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [
          { "text": "Hello! How can I help today?" }
        ]
      },
      "finishReason": "STOP",
      "safetyRatings": [],
      "index": 0
    }
  ],
  "modelVersion": "gemini-pro",
  "usageMetadata": {
    "promptTokenCount": 4,
    "candidatesTokenCount": 8,
    "totalTokenCount": 12
  }
}
```

`finishReason`: `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `OTHER`,
`FINISH_REASON_UNSPECIFIED`.

`safetyRatings` is synthesized empty when the executing backend isn't Gemini.

When the model calls a function:

```json
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [
          {
            "functionCall": {
              "name": "get_weather",
              "args": { "city": "Paris" }
            }
          }
        ]
      },
      "finishReason": "STOP",
      "safetyRatings": []
    }
  ]
}
```

**Errors:**

| Status | `status` | Cause |
|---|---|---|
| 400 | `INVALID_ARGUMENT` | Bad body, unsupported tool kind, `cachedContent` set |
| 401 | `UNAUTHENTICATED` | Auth |
| 404 | `NOT_FOUND` | Model doesn't resolve |
| 500 | `INTERNAL` | Backend failure |

---

### `POST /v1beta/models/{model}:streamGenerateContent`

Same as `:generateContent` but streams via SSE-like chunked responses. Each
chunk is one JSON `GeminiGenerateContentResponse`:

```
data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]},"index":0,"safetyRatings":[]}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":"! How"}]},"index":0,"safetyRatings":[]}]}

data: {"candidates":[{"content":{"role":"model","parts":[{"text":" can I help?"}]},"finishReason":"STOP","index":0,"safetyRatings":[]}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":8,"totalTokenCount":12}}
```

---

### `POST /v1beta/models/{model}:countTokens`

Count tokens for a request without invoking the backend. Accepts **both**
envelope shapes (per deferred-items fix Issue 4):

**Bare shape (REST / curl):**

```json
{
  "contents": [
    { "role": "user", "parts": [{ "text": "count these tokens please" }] }
  ]
}
```

**Wrapped shape (Google SDK):**

```json
{
  "generateContentRequest": {
    "contents": [
      { "role": "user", "parts": [{ "text": "count these tokens please" }] }
    ]
  }
}
```

When `generateContentRequest` is present and `contents` is absent, the
handler unwraps one level before translation.

**Response body** (`GeminiCountTokensResponse`):

```json
{ "totalTokens": 7 }
```

**Errors:** 400, 401, 404, 500.

---

### `GET /v1beta/models`

List models in Gemini shape.

**Response body** (`GeminiModelsListResponse`):

```json
{
  "models": [
    {
      "name": "models/gemini-pro",
      "displayName": "Gemini Pro",
      "description": "Gemini Pro",
      "inputTokenLimit": 1048576,
      "outputTokenLimit": 8192,
      "supportedGenerationMethods": [
        "generateContent",
        "streamGenerateContent",
        "countTokens"
      ]
    },
    {
      "name": "models/claude-opus-4-7",
      "displayName": "Claude Opus 4.7",
      "description": "Claude Opus 4.7",
      "supportedGenerationMethods": [
        "generateContent",
        "streamGenerateContent",
        "countTokens"
      ]
    }
  ]
}
```

Plan 07 ships unpaginated — `nextPageToken` is always omitted.

`inputTokenLimit` / `outputTokenLimit` are only populated when the backend
reports a context window.

---

### `GET /v1beta/models/{id}`

Fetch a single model. Accepts both bare-id and `models/<id>` double-wrap
forms in the path.

**Response body** (`GeminiModelEntry`): same shape as a single `models[]`
entry from `GET /v1beta/models`.

**Errors:** 401, 404, 500.

---

### `POST /v1beta/files` and `POST /upload/v1beta/files`

Upload a file. Both routes point at the same handler.

- `/v1beta/files` accepts `multipart/form-data` (curl-style).
- `/upload/v1beta/files` is the Google SDK alias; accepts
  `multipart/related` with a JSON metadata part + a bytes part.

**Multipart/related body** (Google SDK shape):

```http
POST /upload/v1beta/files HTTP/1.1
Content-Type: multipart/related; boundary=----abc

------abc
Content-Type: application/json

{ "file": { "mimeType": "text/plain", "displayName": "hello.txt" } }
------abc
Content-Type: text/plain

hello world
------abc--
```

**Response body** (`{file: GeminiFileResource}`):

```json
{
  "file": {
    "name": "files/0123456789abcdef01234567",
    "displayName": "hello.txt",
    "mimeType": "text/plain",
    "sizeBytes": "11",
    "createTime": "2026-05-17T10:14:22.000Z",
    "updateTime": "2026-05-17T10:14:22.000Z",
    "state": "ACTIVE",
    "uri": "http://127.0.0.1:3210/v1beta/files/0123456789abcdef01234567:download"
  }
}
```

- `sizeBytes` is a stringified int64 per Google convention.
- `state` is always `"ACTIVE"` (no async upload pipeline).
- `uri` points back to this server's `:download` route.

**Important caveat:** the full Google **resumable-upload handshake** (separate
init URL → upload URL two-step) is NOT implemented. The SDK only uses the
single-POST shape in practice; if you have a client that needs the two-step
protocol, it'll fail.

**Errors:** 400 (bad multipart), 401, 500.

---

### `GET /v1beta/files`

List files in Gemini shape.

**Query params:**

| Name | Default | Notes |
|---|---|---|
| `pageSize` | 20 | Capped at 1000 |
| `pageToken` | — | base64url-encoded offset cursor |

**Response body** (`GeminiFilesListResponse`):

```json
{
  "files": [
    {
      "name": "files/...",
      "displayName": "hello.txt",
      "mimeType": "text/plain",
      "sizeBytes": "11",
      "createTime": "...",
      "updateTime": "...",
      "state": "ACTIVE",
      "uri": "..."
    }
  ],
  "nextPageToken": "MTA="
}
```

`nextPageToken` is omitted when no more pages exist.

---

### `GET /v1beta/files/{id}`

Get file metadata.

**Response body**: a `GeminiFileResource` (same shape as the entries from
`GET /v1beta/files`).

**Errors:** 401, 404.

---

### `GET /v1beta/files/{id}:download`

Download file bytes.

**Response:**

```http
HTTP/1.1 200 OK
Content-Type: text/plain
Content-Length: 11

hello world
```

The download route is mounted **before** the bare-id route so path-to-regexp
doesn't greedily swallow `:download` into the `id` param.

**Errors:** 401, 404.

---

### `DELETE /v1beta/files/{id}`

Delete a file.

**Response body**: `{}` (empty object, 200 status).

---

## Admin

All `/admin/*` endpoints sit behind two layers:

1. `bindLocalhostMiddleware` — rejects non-loopback requests with 403 when
   `config.adminUi.bindLocalhost === true` (default).
2. `sessionAuthMiddleware` — synthesizes `x-api-key` from a valid session
   cookie if present.
3. Per-handler `checkAuth` — rejects with **401 Anthropic-shape error envelope**
   (admin routes consistently use the Anthropic envelope regardless of which
   shim's data they manipulate).

### `GET /admin/archive`

Paginated archived request listing.

**Query params:**

| Name | Type | Default | Notes |
|---|---|---|---|
| `limit` | int | 20 | Capped at 200 |
| `offset` | int | 0 | — |
| `backend` | string | — | Exact match: `claude` / `gemini` / `lmstudio` / `ollama` |
| `session` | string | — | Exact match on session id |
| `model` | string | — | Substring match on resolved model id |
| `since` | ISO-8601 | — | Inclusive lower bound on timestamp |
| `until` | ISO-8601 | — | Exclusive upper bound |
| `status` | enum | — | `ok` / `error` / `timeout` |
| `q` | string | — | When set, substring search on request+response (uses `/admin/archive/search` logic inline) |

**Response body** (`ArchivePage`):

```json
{
  "data": [
    {
      "id": 1234,
      "requestHash": "sha256-abc...",
      "logId": "log_5a2c...",
      "endpoint": "/v1/messages",
      "backend": "claude",
      "modelResolved": "claude-opus-4-7",
      "sessionId": "session-xyz",
      "timestamp": "2026-05-17T10:14:22.000Z",
      "status": "ok",
      "durationMs": 1247,
      "inputTokens": 12,
      "outputTokens": 8,
      "requestBody": { "model": "claude-opus-4-7", "messages": [...] },
      "responseBody": { "id": "msg_...", "content": [...] }
    }
  ],
  "has_more": true
}
```

`requestBody` and `responseBody` are decompressed from zstd on read; the
on-disk blobs are zstd-compressed at `config.archive.compressionLevel`.

---

### `GET /admin/archive/search`

Substring search across request + response bodies.

**Query params:**

| Name | Type | Required | Notes |
|---|---|---|---|
| `q` | string | yes | Search term |
| `limit` | int | no | Default 20, capped 200 |
| `offset` | int | no | Default 0 |

**Response body**: same `ArchivePage` shape as `/admin/archive`.

**Errors:**

| Status | `error.type` | Cause |
|---|---|---|
| 400 | `invalid_request_error` | `q` missing |

---

### `GET /admin/archive/{id}`

Get a single archive entry by numeric id.

**Response body**: a single `StoredArchiveEntry` (one of the `data[]` entries
from `/admin/archive`).

**Errors:**

| Status | Cause |
|---|---|
| 400 | id is not an integer |
| 404 | id not found |

---

### `GET /admin/backends`

Per-backend inventory with capabilities, last-probe status, reachability.

**Response body**:

```json
{
  "data": [
    {
      "id": "claude",
      "models": [
        {
          "id": "claude-opus-4-7",
          "description": "Claude Opus 4.7",
          "contextWindow": 200000
        }
      ],
      "capabilities": {
        "claude-opus-4-7": {
          "toolUse": true,
          "multimodal": true,
          "thinking": true,
          "cacheControl": "local-emul",
          "samplingParams": false,
          "stopSequences": "server-side-cut",
          "embeddings": false
        }
      },
      "lastProbe": {
        "ok": true,
        "at": "2026-05-17T10:13:50.000Z"
      },
      "reachable": true
    },
    {
      "id": "lmstudio",
      "models": [...],
      "capabilities": {...},
      "lastProbe": {
        "ok": false,
        "at": "2026-05-17T10:13:50.000Z",
        "error": "ECONNREFUSED 127.0.0.1:1234"
      },
      "reachable": false
    }
  ]
}
```

`lastProbe` is `null` if the backend has never been probed.

**Errors:** 401, 500.

---

### `POST /admin/backends/reprobe`

Force an immediate re-probe across all backends.

**Query params:**

| Name | Required | Notes |
|---|---|---|
| `instance` | no | If set, validates that the instance is known; the actual probe still scopes "all" |

**Request body**: none.

**Response body**: same shape as `GET /admin/backends`, with an additional
`_meta`:

```json
{
  "data": [...],
  "_meta": {
    "reprobeScope": "all",
    "requestedInstance": "lmstudio"
  }
}
```

`requestedInstance` is only present if the query param was supplied.

**Errors:**

| Status | Cause |
|---|---|
| 400 | `instance` doesn't match any known backend |
| 500 | Reprobe failed |

---

### `POST /admin/backends/test`

Test connectivity to an arbitrary baseUrl (without registering it). Useful for
validating a new LM Studio install before persisting it.

**Request body**:

```json
{
  "baseUrl": "http://192.168.1.50:1234",
  "apiKey": "lm-studio-key",
  "useNativeApi": false
}
```

- `baseUrl` (required) — server URL to probe.
- `apiKey` (optional) — sent as `Authorization: Bearer`.
- `useNativeApi` (optional) — when `true`, probes `/api/tags` (Ollama-native);
  otherwise probes `/v1/models` (OpenAI-compat).

**Response body**:

```json
{
  "ok": true,
  "models": ["llama-3.3-70b", "qwen2.5-coder-32b"],
  "latencyMs": 47
}
```

On failure:

```json
{
  "ok": false,
  "error": "HTTP 503",
  "latencyMs": 12
}
```

`ok: false` is **not** a 5xx response — the test endpoint always 200s and
puts the result in the body. (5xx only happens for malformed test requests.)

**Errors:**

| Status | Cause |
|---|---|
| 400 | Missing `baseUrl` |

---

### `GET /admin/config`

Get the current live config snapshot. `apiKey` and per-instance `apiKey`
fields are redacted to the literal string `"***"`.

**Response body** — the full Zod-validated config shape (see
[configuration-guide.md](./configuration-guide.md) for field-by-field
documentation):

```json
{
  "apiKey": "***",
  "claude": {
    "enabled": true,
    "command": "claude",
    "priority": 100,
    "timeoutMs": 600000
  },
  "gemini": {
    "enabled": true,
    "command": "gemini",
    "priority": 90,
    "timeoutMs": 600000
  },
  "lmstudio": {
    "enabled": true,
    "instances": [
      {
        "name": "main",
        "baseUrl": "http://127.0.0.1:1234",
        "apiKey": "***",
        "priority": 50,
        "timeoutMs": 300000,
        "useNativeApi": null
      }
    ]
  },
  "ollama": {
    "enabled": true,
    "useNativeApi": false,
    "instances": [...]
  },
  "router": {
    "defaultBackend": "claude",
    "localProbeIntervalMs": 60000,
    "thresholds": {
      "opusPromptTokens": 50000,
      "opusToolCount": 5,
      "sonnetPromptTokens": 5000
    },
    "reasoningEffortMap": {
      "claude": { "low": "claude-haiku-4-5", "medium": "claude-sonnet-4-6", "high": "claude-opus-4-7" },
      "gemini": { "low": "gemini-flash-lite", "medium": "gemini-flash", "high": "gemini-pro" },
      "lmstudio": {},
      "ollama": {}
    }
  },
  "files": { "dir": "data/files", "ttlMs": 604800000, "maxTotalBytes": 5368709120 },
  "cache": { "file": "data/response-cache.json", "ttlMs": 3600000, "maxEntries": 500 },
  "archive": { "dbPath": "data/archive.sqlite", "compressionLevel": 3 },
  "embeddings": { "legacyBackendUrl": "", "legacyApiKey": "", "legacyTimeoutMs": 30000 },
  "adminUi": { "enabled": true, "bindLocalhost": true, "sessionTtlMs": 3600000 }
}
```

---

### `PUT /admin/config`

Full config replacement. Zod-validated; rejected wholesale if any field is
invalid. On success, atomically writes the new config to disk and updates the
in-memory snapshot for all subsequent requests.

**Request body**: a full config object (same shape as `GET` response, with the
real `apiKey` instead of `"***"`).

If `apiKey` is the literal string `"***"`, the request is rejected with a
400 — supply the real key or use `PATCH` to update other fields.

**Response body**: the redacted post-write snapshot (same shape as `GET`).

**Errors:**

| Status | `error.type` | Cause |
|---|---|---|
| 400 | `invalid_request_error` | Body not an object, Zod validation failed, or apiKey is `"***"` |
| 401 | `authentication_error` | Auth |
| 500 | `api_error` | Disk write failed |

---

### `PATCH /admin/config`

JSON merge-patch (RFC 7396) — recursively merges the body into the current
config:

- Object keys merge recursively.
- Array values replace atomically (no element-level merge).
- `null` at any key deletes that key.
- Nested `null` inside array elements is stripped before Zod validation, so
  Zod defaults can repopulate the field.

After merging, the result is Zod-validated and persisted exactly like `PUT`.

**Example — change router default + add an LM Studio instance:**

```http
PATCH /admin/config HTTP/1.1
Content-Type: application/json
x-api-key: changeme

{
  "router": { "defaultBackend": "gemini" },
  "lmstudio": {
    "instances": [
      {
        "name": "main",
        "baseUrl": "http://127.0.0.1:1234"
      }
    ]
  }
}
```

The `instances` array fully replaces the prior `lmstudio.instances`; the
omitted Zod-defaultable fields (`apiKey`, `priority`, `timeoutMs`,
`useNativeApi`) repopulate from defaults.

**Response body**: same as `PUT` (redacted post-write snapshot).

**Errors:** same as `PUT`.

---

## Admin UI

### `GET /admin/ui` and `GET /admin/ui/*`

Serves the SPA: `index.html`, `app.js`, `styles.css`,
`themes/{light,dark}.css`, `icons/*.svg`.

**No auth required** to fetch the static page — the page IS the login form;
the SPA fetches all data from `/admin/*` JSON endpoints which DO require
auth. The static assets are inert without a valid `apiKey`.

The router is mounted with `index: "index.html"` so `/admin/ui` and
`/admin/ui/` both serve the SPA shell.

Content-Type headers are explicitly set:

- `.js` → `application/javascript; charset=utf-8`
- `.css` → `text/css; charset=utf-8`
- `.svg` → `image/svg+xml; charset=utf-8`

ETag and Last-Modified are enabled; `maxAge: 0` (no client-side caching of
the SPA itself).

---

### `POST /admin/ui/session`

Login. Exchanges an `apiKey` for an `HttpOnly` session cookie.

**Request body**:

```json
{ "apiKey": "changeme" }
```

Body is limited to 4 KiB. Comparison is constant-time via `checkApiKey`.

**Response — success**:

```http
HTTP/1.1 204 No Content
Set-Cookie: claudemcp_session=<opaque-token>; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=3600
```

**Response — failure** (401 Anthropic-shape envelope):

```json
{
  "type": "error",
  "error": { "type": "authentication_error", "message": "invalid apiKey" }
}
```

Cookie attributes:

| Attribute | Value | Why |
|---|---|---|
| `HttpOnly` | yes | Prevent JS-based XSS exfiltration |
| `SameSite` | `Strict` | Not sent on cross-origin requests |
| `Path` | `/admin` | Only sent to admin endpoints, not data endpoints |
| `Max-Age` | `config.adminUi.sessionTtlMs / 1000` | Auto-expire at TTL |

The session token is opaque and in-memory only — sessions don't survive a
server restart.

---

### `DELETE /admin/ui/session`

Logout. Revokes the session token server-side and clears the cookie.

**Response:**

```http
HTTP/1.1 204 No Content
Set-Cookie: claudemcp_session=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0
```

Idempotent — always returns 204 regardless of whether a valid session was
present.

---

## Health

### `GET /health`

Liveness probe. **No auth required.**

**Response body**:

```json
{ "status": "ok" }
```

Always 200 if the process is running. Does not validate backend reachability —
use `GET /admin/backends` for that.

---

## Error envelope shapes

Three shapes by shim family. Pick the shape that matches your SDK; routes
return the shape of their own shim family.

### Anthropic shape

Used by: `/v1/messages*`, `/v1/anthropic/models*`, `/v1/files*`, **all
`/admin/*`**, `/admin/ui/session`.

```json
{
  "type": "error",
  "error": {
    "type": "authentication_error",
    "message": "invalid or missing API key"
  }
}
```

`error.type` enum:

- `invalid_request_error` (400)
- `authentication_error` (401)
- `permission_error` (403 — bindLocalhost rejection)
- `not_found_error` (404)
- `api_error` (500)
- `overloaded_error` (529 — reserved; not currently emitted)

### OpenAI shape

Used by: `/v1/chat/completions`, `/v1/embeddings`, `/v1/models*`.

```json
{
  "error": {
    "message": "The model `gpt-9` does not exist.",
    "type": "not_found_error",
    "param": null,
    "code": "model_not_found"
  }
}
```

`error.type` enum:

- `invalid_request_error` (400)
- `authentication_error` (401, `code: "invalid_api_key"`)
- `permission_denied_error` (403)
- `not_found_error` (404, `code: "model_not_found"` for model lookups)
- `api_error` (500)

`param` and `code` are always-present strings or `null`. `param` is the
offending request-body field name when applicable.

### Gemini shape

Used by: `/v1beta/*` (all Gemini shim routes including files).

```json
{
  "error": {
    "code": 401,
    "message": "invalid or missing API key",
    "status": "UNAUTHENTICATED"
  }
}
```

`error.code` is the HTTP status as a number (Google convention).

`error.status` enum:

- `INVALID_ARGUMENT` (400)
- `UNAUTHENTICATED` (401)
- `PERMISSION_DENIED` (403)
- `NOT_FOUND` (404)
- `FAILED_PRECONDITION` (412)
- `INTERNAL` (500)
- `UNAVAILABLE` (503)

---

## Cross-shim file ID alias

The Anthropic shim uses `file_<24hex>` ids; the Gemini shim uses
`files/<24hex>`. **Both forms refer to the same on-disk content.** The
24-hex part is a SHA-256 prefix of the file bytes, so the same bytes
uploaded twice always produce the same id (content-addressed).

| Upload route | Returned id | Also resolvable as |
|---|---|---|
| `POST /v1/files` | `file_<24hex>` | `files/<24hex>` (via Gemini routes) |
| `POST /v1beta/files` | `files/<24hex>` | `file_<24hex>` (via Anthropic routes) |
| `POST /upload/v1beta/files` | `files/<24hex>` | `file_<24hex>` (via Anthropic routes) |

`GET /v1/files/{id}`, `GET /v1beta/files/{id}`, and the `{id}/content` /
`{id}:download` variants all accept **either** form. Cross-format reference
in message bodies works the same way — a Gemini `fileData.fileUri` of
`file_<24hex>` is accepted, and an Anthropic `source.file_id` of
`files/<24hex>` is accepted.

---

## Backend capability matrix

Per [the spec](../docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md),
this is the capability surface honored by each backend. The
`GET /admin/backends` response includes per-model capabilities derived from
this table.

| Capability | Claude | Gemini | LM Studio | Ollama |
|---|:-:|:-:|:-:|:-:|
| `toolUse` | yes | yes (Plan 07) | yes | yes |
| `multimodal` | yes | yes | model-dep | model-dep |
| `thinking` | yes | – | – | – |
| `cacheControl` | local-emul | local-emul | local-emul | local-emul |
| `samplingParams` (`temperature`/`top_p`/`top_k`) | – | yes | yes | yes |
| `stopSequences` | server-side-cut | native | native | native |
| `embeddings` | – | – | yes | yes |

Legend:

- **yes** — fully honored by the backend.
- **–** — not supported; the shim drops or rejects the parameter.
- **model-dep** — depends on the chosen model (e.g. vision LLMs vs. text-only).
- **local-emul** — ClaudeMCP's local response cache emulates the behavior
  (round-trip avoidance, NOT cloud cost savings).
- **server-side-cut** — the Claude CLI doesn't natively honor
  `stop_sequences`; ClaudeMCP truncates the output after the first match
  before returning.
- **native** — backend honors the parameter directly.

---

## See also

- [user-manual.md](./user-manual.md) — task-oriented walkthroughs
- [configuration-guide.md](./configuration-guide.md) — config field reference
- [operations-guide.md](./operations-guide.md) — ops/troubleshooting
- [technical-manual.md](./technical-manual.md) — internal architecture
- [development-guide.md](./development-guide.md) — contributing
