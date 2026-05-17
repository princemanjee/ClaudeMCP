# Plan 03: Anthropic Shim Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Anthropic-shaped HTTP surface on top of the Plan-01 foundation and the Plan-02 Claude backend. Three endpoints go live: `POST /v1/messages` (streaming + non-streaming), `POST /v1/messages/count_tokens`, and `GET /v1/models` (+ `GET /v1/models/{id}`). An Express bootstrap (`src/server.ts`) wires `loadConfig`, the `BackendRegistry`, the `Archive` instance (constructed only — writes wait for Plan 05), and the three handler factories, plus a tiny `src/bin.ts` CLI entry. The result: any client speaking Anthropic's Messages API can reach the Claude CLI through this server with full SSE wire-shape parity.

**Architecture:** Each shim handler is a pure factory that accepts its dependencies (registry, config, archive) as constructor args — module-scoped state is forbidden so unit tests can spin up an Express app instance per case via supertest. Two translators live in `src/anthropicShim/`: `requestTranslator.ts` (pure function `anthropicRequestToNormalized`) and `responseTranslator.ts` (one async generator that yields Anthropic SSE event strings from `NormalizedEvent`s, one async function that buffers the same events into a non-streaming response body). A new `src/tokenEstimator.ts` ships the simplest version of the estimator (char/4) needed by `count_tokens`; Plan 05 swaps in real tokenizer dependencies. Scope is deliberately the **text-only path** — image/document blocks, native `tool_use` round-trip, `stop_sequences`, and `cache_control` all return 400 with descriptive error messages and defer to later plans.

**Tech Stack:** Same as Plans 01-02 — Node.js 20+, TypeScript 5 (NodeNext ESM), Express 4, Vitest + Supertest for tests. All `src/*` imports use explicit `.js` extensions (NodeNext).

**Spec:** `docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md` (Phase 3: Anthropic shim core).

**Builds on:**
- Plan 01 (`docs/superpowers/plans/2026-05-16-plan-01-foundation.md`) — `Backend`, `BackendCapabilities`, `NormalizedRequest`, `NormalizedEvent`, `ModelDescriptor` from `src/backends/types.ts`; `loadConfig` from `src/config.ts`; `checkAuth` from `src/auth.ts`; `BackendRegistry` from `src/backends/registry.ts`; `identifyBackend` from `src/modelRouter.ts`; `Archive` from `src/archive.ts` (constructed, never written to in this plan).
- Plan 02 (`docs/superpowers/plans/2026-05-16-plan-02-claude-backend.md`) — `ClaudeBackend` from `src/backends/claudeBackend.ts`; the runners under `src/runners/`; the `mock-claude` fixture at `tests/fixtures/mock-claude/index.mjs`.

---

## Scope boundary for Plan 03

The spec's implementation phasing note draws a hard line between Plan 03 and the plans that follow. Bake the following deferrals into the handler logic — they must return Anthropic-shaped 400 errors rather than silently produce wrong output:

| Feature on the request | Plan 03 disposition | Lands in |
|---|---|---|
| Text-only `content` blocks | Honored | — |
| `system` field (string) | Honored | — |
| `system` field (array of text blocks) | Honored — concatenated to single string | — |
| `image` content blocks | 400 `invalid_request_error` | Plan 04 |
| `document` content blocks | 400 `invalid_request_error` | Plan 04 |
| `tool_use` content blocks (in request) | 400 `invalid_request_error` | Plan 04 |
| `tool_result` content blocks (in request) | 400 `invalid_request_error` | Plan 04 |
| `tools` field non-empty | 400 `invalid_request_error` | Plan 04 |
| `tool_choice` field present | 400 `invalid_request_error` | Plan 04 |
| `stop_sequences` field non-empty | 400 `invalid_request_error` | Plan 04 |
| `cache_control` on any block | 400 `invalid_request_error` | Plan 05 |
| `file_<hash>` references | 400 `invalid_request_error` | Plan 05 |
| `thinking` field | 400 `invalid_request_error` | Plan 04 |
| `metadata` field | Accepted and ignored | — |
| `temperature` / `top_p` / `top_k` | Accepted and ignored (claude backend ignores per capability matrix) | — |
| `max_tokens` | Honored as request-shape passthrough; backend may ignore | — |
| `stream: true` | Honored — Anthropic SSE event stream | — |
| `stream: false` (default) | Honored — buffered Anthropic response body | — |

Additional deferrals that are server-internal (not user-facing):
- Archive writes (Plan 05; this plan instantiates the `Archive` object but never calls write methods).
- Response cache (Plan 05).
- Admin endpoints (Plan 11).
- Other shims — OpenAI surface stays on the legacy `dist/` server for now; Gemini shim lands in Plan 06.

---

## File map

| File | Responsibility |
|---|---|
| `src/server.ts` | Express bootstrap. Loads config, opens archive, builds registry, registers `ClaudeBackend`, starts periodic probe, mounts Anthropic shim routes, exposes `/health`, handles SIGINT/SIGTERM graceful shutdown. Exports `main(opts)` for the CLI and `buildApp(deps)` for unit tests. |
| `src/bin.ts` | Tiny CLI entry. Parses `--config <path>`, calls `main()`. |
| `src/anthropicShim/types.ts` | TypeScript types for the Anthropic Messages API request/response shapes (only the subset Plan 03 honors). |
| `src/anthropicShim/errors.ts` | Anthropic-shaped error envelope helpers (`invalidRequestError`, `authenticationError`, `notFoundError`, `internalServerError`). |
| `src/anthropicShim/requestTranslator.ts` | Pure function `anthropicRequestToNormalized(body): NormalizedRequest`. Throws `ShimRequestError` on out-of-scope content. |
| `src/anthropicShim/responseTranslator.ts` | Two functions: `normalizedEventsToSSE(events, meta)` (async generator yielding Anthropic SSE event strings) and `normalizedEventsToFinalResponse(events, meta)` (async function returning the assembled non-streaming response body). |
| `src/anthropicShim/messages.ts` | Express handler factory `createMessagesHandler(deps)`. Auth check, request translation, backend resolution via registry + router, streaming or buffered response. |
| `src/anthropicShim/countTokens.ts` | Express handler factory `createCountTokensHandler(deps)`. Auth + translation + delegate to `backend.countTokens`. |
| `src/anthropicShim/models.ts` | Express handler factory `createModelsHandlers(deps)` returning `{ list, get }` for `GET /v1/models` and `GET /v1/models/{id}`. Lists all models across all enabled backends, Anthropic-shaped envelope. |
| `src/tokenEstimator.ts` | Skeleton: `estimateTokens(text)` (char/4) and `estimateRequestTokens(req)`. Plan 05 swaps in a real tokenizer dependency. |
| `tests/unit/tokenEstimator.test.ts` | Char/4 estimator covers text + multimodal placeholder logic. |
| `tests/unit/anthropicShim/errors.test.ts` | Envelope shape parity with Anthropic's documented error format. |
| `tests/unit/anthropicShim/requestTranslator.test.ts` | Every Anthropic content block shape, system prompt handling, model field passthrough, error cases for out-of-scope features. |
| `tests/unit/anthropicShim/responseTranslator.test.ts` | SSE event sequence (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`), non-streaming aggregation, stop_reason mapping. |
| `tests/unit/anthropicShim/messages.test.ts` | Handler behavior in isolation (mock backend, supertest against an Express app instance). |
| `tests/unit/anthropicShim/countTokens.test.ts` | Token counting endpoint. |
| `tests/unit/anthropicShim/models.test.ts` | Models listing endpoint. |
| `tests/integration/messages.test.ts` | Full HTTP stack: spawn `src/bin.ts` as a subprocess, hit it with supertest, verify SSE wire shape and final response body. Uses `mock-claude`. |
| `docs/plan-03-anthropic-shim-readme.md` | Close-out documentation. |

---

## Pre-flight check

Before starting Task 1, confirm the Plans 01-02 baseline is in place:

- [ ] `git log --oneline -20` shows Plan 02's commits merged (look for `feat(claudeBackend): wire invoke() through claudeStreamRunner`).
- [ ] `npm test` shows the full Plan-02 suite passing (94 tests).
- [ ] `npx tsc --noEmit` clean.
- [ ] `src/backends/claudeBackend.ts` exists and exports `ClaudeBackend`.
- [ ] `src/backends/registry.ts` exports `BackendRegistry`.
- [ ] `src/runners/claudeStreamRunner.ts` exists.
- [ ] `tests/fixtures/mock-claude/index.mjs` is executable and emits valid `stream-json` output when given `--output-format stream-json`.

If any check fails, stop and resolve before proceeding.

---

## Task 1: Anthropic shim types + error envelopes

**Files:**
- Create: `src/anthropicShim/types.ts`
- Create: `src/anthropicShim/errors.ts`
- Test: `tests/unit/anthropicShim/errors.test.ts`

Define the request and response shapes for the subset of the Anthropic Messages API that Plan 03 honors, plus the error envelope helpers. Types first because every later module imports them. The error helpers exist as standalone functions so handlers can return Anthropic-shaped JSON without duplicating literal shapes.

- [ ] **Step 1: Create `src/anthropicShim/types.ts`**

```ts
// Subset of the Anthropic Messages API shape that Plan 03 honors. Tool_use,
// multimodal, cache_control, file references, and thinking blocks are
// intentionally absent — the request translator rejects them with a 400.

export type AnthropicRole = "user" | "assistant";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

/**
 * Content blocks the translator may encounter. Plan 03 only honors `text`;
 * the rest are listed so the type system catches handling additions in later
 * plans without losing exhaustiveness checks today.
 */
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | { type: "image"; source: unknown }
  | { type: "document"; source: unknown }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown };

export interface AnthropicMessage {
  role: AnthropicRole;
  /** May be a plain string (shorthand) or an array of blocks. */
  content: string | AnthropicContentBlock[];
}

export type AnthropicSystem = string | AnthropicTextBlock[];

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: AnthropicSystem;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: unknown[];
  tool_choice?: unknown;
  metadata?: Record<string, unknown>;
  thinking?: unknown;
}

// ---- Response shapes ------------------------------------------------------

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface AnthropicResponseTextBlock {
  type: "text";
  text: string;
}

export type AnthropicResponseContentBlock = AnthropicResponseTextBlock;

export type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use";

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicResponseContentBlock[];
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

// ---- Count tokens shapes --------------------------------------------------

export interface AnthropicCountTokensResponse {
  input_tokens: number;
}

// ---- Models shapes --------------------------------------------------------

export interface AnthropicModelEntry {
  type: "model";
  id: string;
  display_name: string;
  created_at: string; // ISO-8601
}

export interface AnthropicModelsListResponse {
  data: AnthropicModelEntry[];
  has_more: false;
  first_id: string | null;
  last_id: string | null;
}
```

- [ ] **Step 2: Write the failing test for error envelopes**

Create `tests/unit/anthropicShim/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  authenticationError,
  internalServerError,
  invalidRequestError,
  notFoundError,
  ShimRequestError
} from "../../../src/anthropicShim/errors.js";

describe("Anthropic error envelopes", () => {
  it("invalidRequestError matches Anthropic's documented shape", () => {
    const env = invalidRequestError("missing model field");
    expect(env).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "missing model field"
      }
    });
  });

  it("authenticationError matches Anthropic's documented shape", () => {
    const env = authenticationError("invalid x-api-key");
    expect(env).toEqual({
      type: "error",
      error: {
        type: "authentication_error",
        message: "invalid x-api-key"
      }
    });
  });

  it("notFoundError matches Anthropic's documented shape", () => {
    const env = notFoundError("model not_a_real_model not found");
    expect(env).toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message: "model not_a_real_model not found"
      }
    });
  });

  it("internalServerError matches Anthropic's documented shape", () => {
    const env = internalServerError("backend crashed");
    expect(env).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "backend crashed"
      }
    });
  });

  it("ShimRequestError carries status code and message", () => {
    const err = new ShimRequestError(400, "bad block type");
    expect(err.status).toBe(400);
    expect(err.message).toBe("bad block type");
    expect(err).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/unit/anthropicShim/errors.test.ts`
Expected: FAIL — module `src/anthropicShim/errors.js` not found.

- [ ] **Step 4: Create `src/anthropicShim/errors.ts`**

```ts
export interface AnthropicErrorEnvelope {
  type: "error";
  error: {
    type:
      | "invalid_request_error"
      | "authentication_error"
      | "not_found_error"
      | "api_error"
      | "overloaded_error";
    message: string;
  };
}

export function invalidRequestError(message: string): AnthropicErrorEnvelope {
  return {
    type: "error",
    error: { type: "invalid_request_error", message }
  };
}

export function authenticationError(message: string): AnthropicErrorEnvelope {
  return {
    type: "error",
    error: { type: "authentication_error", message }
  };
}

export function notFoundError(message: string): AnthropicErrorEnvelope {
  return {
    type: "error",
    error: { type: "not_found_error", message }
  };
}

export function internalServerError(message: string): AnthropicErrorEnvelope {
  return {
    type: "error",
    error: { type: "api_error", message }
  };
}

/**
 * Thrown by the request translator (and any other pre-handler validation) to
 * signal a client-facing error with a specific HTTP status. The handler catches
 * these and converts to the matching Anthropic envelope.
 */
export class ShimRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ShimRequestError";
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/anthropicShim/errors.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add src/anthropicShim/types.ts src/anthropicShim/errors.ts tests/unit/anthropicShim/errors.test.ts
git commit -m "feat(anthropicShim): add request/response types and error envelope helpers"
```

---

## Task 2: Token estimator skeleton

**Files:**
- Create: `src/tokenEstimator.ts`
- Test: `tests/unit/tokenEstimator.test.ts`

The simplest version of the token estimator that satisfies `POST /v1/messages/count_tokens`. Char/4 fallback only — Plan 05 swaps in `@anthropic-ai/tokenizer` and per-backend dispatch. Lives at `src/tokenEstimator.ts` (not under `anthropicShim/`) because the Gemini shim (Plan 06) and the response cache (Plan 05) will reuse it.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/tokenEstimator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  estimateRequestTokens,
  estimateTokens
} from "../../src/tokenEstimator.js";
import type { NormalizedRequest } from "../../src/backends/types.js";

describe("estimateTokens (char/4)", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns ceil(length/4) for ASCII text", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("hello world")).toBe(3); // 11 chars → 3
  });

  it("counts each code unit (not grapheme cluster)", () => {
    // Multi-byte char: char length is the unit of measure here.
    expect(estimateTokens("é")).toBe(1); // 1 code unit
    expect(estimateTokens("éééé")).toBe(1);
  });
});

describe("estimateRequestTokens", () => {
  it("sums text from a single user message", () => {
    const req: NormalizedRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello world hello world" }] }
      ]
    };
    // 23 chars → ceil(23/4) = 6
    expect(estimateRequestTokens(req)).toBe(6);
  });

  it("includes the system prompt", () => {
    const req: NormalizedRequest = {
      model: "claude-sonnet-4-6",
      system: "you are helpful", // 15 → 4
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] // 2 → 1
    };
    expect(estimateRequestTokens(req)).toBe(5);
  });

  it("walks every message and every text block", () => {
    const req: NormalizedRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] }, // 5 → 2
        { role: "assistant", content: [{ type: "text", text: "ok" }] }, // 2 → 1
        {
          role: "user",
          content: [
            { type: "text", text: "second" }, // 6 → 2
            { type: "text", text: "third" } // 5 → 2
          ]
        }
      ]
    };
    expect(estimateRequestTokens(req)).toBe(7);
  });

  it("approximates image blocks with a fixed placeholder cost", () => {
    const req: NormalizedRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" }, // 8 → 2
            { type: "image", mediaType: "image/png", data: "BASE64" } // placeholder cost: 258
          ]
        }
      ]
    };
    expect(estimateRequestTokens(req)).toBe(2 + 258);
  });

  it("approximates document blocks with a per-byte cost", () => {
    const req: NormalizedRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            // 64 bytes of base64 → ~48 raw bytes → ceil(48/4) = 12
            { type: "document", mediaType: "application/pdf", data: "A".repeat(64) }
          ]
        }
      ]
    };
    expect(estimateRequestTokens(req)).toBe(12);
  });

  it("includes serialized tool_use input and tool_result content", () => {
    const req: NormalizedRequest = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "calc", input: { x: 1, y: 2 } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "t1", content: "3" }
          ]
        }
      ]
    };
    // JSON.stringify({x:1,y:2}) = 13 chars → 4
    // "3" → 1
    expect(estimateRequestTokens(req)).toBe(4 + 1);
  });

  it("returns 0 for an empty messages array with no system prompt", () => {
    const req: NormalizedRequest = {
      model: "claude-sonnet-4-6",
      messages: []
    };
    expect(estimateRequestTokens(req)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/tokenEstimator.test.ts`
Expected: FAIL — module `src/tokenEstimator.js` not found.

- [ ] **Step 3: Create `src/tokenEstimator.ts`**

```ts
import type { NormalizedRequest } from "./backends/types.js";

/**
 * Char/4 estimate. Plan 05 swaps in `@anthropic-ai/tokenizer` and per-backend
 * dispatch; until then this is the single source of token counts for
 * `/v1/messages/count_tokens` and any internal accounting.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Image blocks contribute a fixed approximation. Anthropic's published
 * formula is roughly `tokens = (w * h) / 750`. With no source-image
 * dimensions in the normalized block today, 258 (≈ a 512x378 image, the
 * upper-bound for Anthropic's "low-detail" tier) is a conservative
 * placeholder — close enough for billing pre-flight on the count_tokens
 * endpoint. Plan 05 plumbs real dimensions through and refines this.
 */
const IMAGE_TOKEN_PLACEHOLDER = 258;

export function estimateRequestTokens(req: NormalizedRequest): number {
  let total = 0;
  if (req.system) total += estimateTokens(req.system);
  for (const msg of req.messages) {
    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          total += estimateTokens(block.text);
          break;
        case "image":
          total += IMAGE_TOKEN_PLACEHOLDER;
          break;
        case "document": {
          // Approximate document blocks by the decoded byte length of the
          // base64 payload; close enough for billing pre-flight.
          const rawBytes = Math.floor((block.data.length * 3) / 4);
          total += estimateTokens(" ".repeat(rawBytes));
          break;
        }
        case "tool_use":
          total += estimateTokens(JSON.stringify(block.input));
          break;
        case "tool_result":
          total += estimateTokens(block.content);
          break;
      }
    }
  }
  return total;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/tokenEstimator.test.ts`
Expected: PASS — all 10 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/tokenEstimator.ts tests/unit/tokenEstimator.test.ts
git commit -m "feat(tokenEstimator): add char/4 skeleton with image/document placeholders"
```

---

## Task 3: Request translator — Anthropic → NormalizedRequest

**Files:**
- Create: `src/anthropicShim/requestTranslator.ts`
- Test: `tests/unit/anthropicShim/requestTranslator.test.ts`

The pure translator. Function signature: `anthropicRequestToNormalized(body: AnthropicMessagesRequest): NormalizedRequest`. Validates structure, normalizes the `content: string` shorthand into a single `text` block, concatenates a multi-block `system` array, and throws `ShimRequestError(400, ...)` on any out-of-scope feature.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/anthropicShim/requestTranslator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { anthropicRequestToNormalized } from "../../../src/anthropicShim/requestTranslator.js";
import { ShimRequestError } from "../../../src/anthropicShim/errors.js";

describe("anthropicRequestToNormalized — happy paths", () => {
  it("translates the simplest text-only request", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }]
    });
    expect(out).toEqual({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] }
      ]
    });
  });

  it("preserves multi-block text content", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" }
          ]
        }
      ]
    });
    expect(out.messages[0]?.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" }
    ]);
  });

  it("string system prompt becomes NormalizedRequest.system as-is", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      system: "you are helpful",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(out.system).toBe("you are helpful");
  });

  it("array system prompt is joined with double newline", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      system: [
        { type: "text", text: "be concise" },
        { type: "text", text: "be polite" }
      ],
      messages: [{ role: "user", content: "hi" }]
    });
    expect(out.system).toBe("be concise\n\nbe polite");
  });

  it("forwards max_tokens", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: "hi" }]
    });
    expect(out.maxTokens).toBe(4096);
  });

  it("forwards sampling params (claudeBackend will ignore — that's fine)", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      messages: [{ role: "user", content: "hi" }]
    });
    expect(out.samplingParams).toEqual({
      temperature: 0.7,
      topP: 0.9,
      topK: 40
    });
  });

  it("forwards metadata", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      metadata: { user_id: "u_42" },
      messages: [{ role: "user", content: "hi" }]
    });
    expect(out.metadata).toEqual({ user_id: "u_42" });
  });

  it("preserves message ordering across roles", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" }
      ]
    });
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("anthropicRequestToNormalized — required-field validation", () => {
  it("throws 400 when model is missing", () => {
    expect(() =>
      anthropicRequestToNormalized({
        // @ts-expect-error — testing runtime validation
        messages: [{ role: "user", content: "hi" }]
      })
    ).toThrow(ShimRequestError);
  });

  it("throws 400 when messages is missing", () => {
    expect(() =>
      anthropicRequestToNormalized({
        model: "claude-sonnet-4-6"
        // messages omitted
      } as never)
    ).toThrow(/messages/i);
  });

  it("throws 400 when messages is empty", () => {
    expect(() =>
      anthropicRequestToNormalized({
        model: "claude-sonnet-4-6",
        messages: []
      })
    ).toThrow(/at least one message/i);
  });

  it("throws 400 when a message has an unsupported role", () => {
    expect(() =>
      anthropicRequestToNormalized({
        model: "claude-sonnet-4-6",
        messages: [
          // @ts-expect-error — testing runtime validation
          { role: "system", content: "no" }
        ]
      })
    ).toThrow(/role/i);
  });

  it("throws 400 when a content block has an unknown type", () => {
    expect(() =>
      anthropicRequestToNormalized({
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            // @ts-expect-error — testing runtime validation
            content: [{ type: "neon-pixel-art", text: "?" }]
          }
        ]
      })
    ).toThrow(/unknown.*type/i);
  });
});

describe("anthropicRequestToNormalized — Plan 03 scope rejections", () => {
  function assertRejected(body: unknown, pattern: RegExp): void {
    let caught: unknown;
    try {
      anthropicRequestToNormalized(body as never);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ShimRequestError);
    expect((caught as ShimRequestError).status).toBe(400);
    expect((caught as ShimRequestError).message).toMatch(pattern);
  }

  it("rejects image content blocks", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "X" } }
            ]
          }
        ]
      },
      /image|multimodal/i
    );
  });

  it("rejects document content blocks", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "X" } }]
          }
        ]
      },
      /document|multimodal/i
    );
  });

  it("rejects tool_use content blocks in the request", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "calc", input: {} }]
          }
        ]
      },
      /tool/i
    );
  });

  it("rejects tool_result content blocks in the request", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]
          }
        ]
      },
      /tool/i
    );
  });

  it("rejects non-empty tools field", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "calc", input_schema: {} }]
      },
      /tool/i
    );
  });

  it("rejects tool_choice field when present", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: { type: "auto" }
      },
      /tool_choice/i
    );
  });

  it("rejects non-empty stop_sequences", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        stop_sequences: ["STOP"]
      },
      /stop_sequences/i
    );
  });

  it("rejects thinking field", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: 1024 }
      },
      /thinking/i
    );
  });

  it("rejects cache_control on a content block", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "hi",
                cache_control: { type: "ephemeral" }
              } as unknown as { type: "text"; text: string }
            ]
          }
        ]
      },
      /cache_control/i
    );
  });

  it("accepts empty stop_sequences array (treated as not supplied)", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      stop_sequences: []
    });
    expect(out.stopSequences).toBeUndefined();
  });

  it("accepts empty tools array (treated as not supplied)", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tools: []
    });
    expect(out.tools).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/anthropicShim/requestTranslator.test.ts`
Expected: FAIL — module `src/anthropicShim/requestTranslator.js` not found.

- [ ] **Step 3: Create `src/anthropicShim/requestTranslator.ts`**

```ts
import type {
  NormalizedContentBlock,
  NormalizedMessage,
  NormalizedRequest
} from "../backends/types.js";
import { ShimRequestError } from "./errors.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicSystem
} from "./types.js";

function bad(message: string): never {
  throw new ShimRequestError(400, message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeSystem(system: AnthropicSystem | undefined): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) bad("system must be a string or an array of text blocks");
  const parts: string[] = [];
  for (const block of system) {
    if (!isRecord(block) || block["type"] !== "text" || typeof block["text"] !== "string") {
      bad("system array entries must be text blocks");
    }
    parts.push(block["text"] as string);
  }
  return parts.join("\n\n");
}

function normalizeContentBlock(block: AnthropicContentBlock): NormalizedContentBlock {
  if (!isRecord(block) || typeof block["type"] !== "string") {
    bad("content block must have a string type field");
  }
  // Reject cache_control wherever it appears.
  if (isRecord(block) && "cache_control" in block) {
    bad("cache_control is not supported in Plan 03 (lands in Plan 05)");
  }

  const t = (block as { type: string }).type;
  switch (t) {
    case "text": {
      const text = (block as { text?: unknown }).text;
      if (typeof text !== "string") bad("text content block requires a string text field");
      return { type: "text", text };
    }
    case "image":
      bad("image content blocks are not supported in Plan 03 (multimodal lands in Plan 04)");
      break;
    case "document":
      bad("document content blocks are not supported in Plan 03 (multimodal lands in Plan 04)");
      break;
    case "tool_use":
      bad(
        "tool_use content blocks are not supported in Plan 03 (native tool round-trip lands in Plan 04)"
      );
      break;
    case "tool_result":
      bad(
        "tool_result content blocks are not supported in Plan 03 (native tool round-trip lands in Plan 04)"
      );
      break;
    default:
      bad(`unknown content block type: ${t}`);
  }
}

function normalizeMessage(msg: AnthropicMessage): NormalizedMessage {
  if (!isRecord(msg)) bad("each message must be an object");
  const role = msg["role"];
  if (role !== "user" && role !== "assistant") {
    bad(`unsupported message role: ${String(role)} (must be user or assistant)`);
  }
  const rawContent = msg["content"];
  let blocks: AnthropicContentBlock[];
  if (typeof rawContent === "string") {
    blocks = [{ type: "text", text: rawContent }];
  } else if (Array.isArray(rawContent)) {
    blocks = rawContent as AnthropicContentBlock[];
  } else {
    bad("message.content must be a string or an array of content blocks");
  }
  const normalized = blocks.map(normalizeContentBlock);
  return { role, content: normalized };
}

export function anthropicRequestToNormalized(
  body: AnthropicMessagesRequest
): NormalizedRequest {
  if (!isRecord(body)) bad("request body must be a JSON object");

  const model = (body as { model?: unknown }).model;
  if (typeof model !== "string" || model.length === 0) {
    bad("model is required and must be a non-empty string");
  }

  const rawMessages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(rawMessages)) bad("messages is required and must be an array");
  if (rawMessages.length === 0) bad("messages must contain at least one message");

  // Out-of-scope scalar fields
  if ("thinking" in body && body.thinking !== undefined) {
    bad(
      "thinking is not supported in Plan 03 (extended thinking lands in Plan 04)"
    );
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    bad("tools is not supported in Plan 03 (native tool round-trip lands in Plan 04)");
  }
  if ("tool_choice" in body && body.tool_choice !== undefined) {
    bad("tool_choice is not supported in Plan 03 (native tool round-trip lands in Plan 04)");
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    bad("stop_sequences is not supported in Plan 03 (server-side cut lands in Plan 04)");
  }

  const messages = (rawMessages as AnthropicMessage[]).map(normalizeMessage);
  const system = normalizeSystem(body.system);

  const samplingParams =
    body.temperature !== undefined || body.top_p !== undefined || body.top_k !== undefined
      ? {
          ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
          ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
          ...(body.top_k !== undefined ? { topK: body.top_k } : {})
        }
      : undefined;

  const out: NormalizedRequest = {
    model,
    messages
  };
  if (system !== undefined) out.system = system;
  if (typeof body.max_tokens === "number") out.maxTokens = body.max_tokens;
  if (samplingParams) out.samplingParams = samplingParams;
  if (isRecord(body.metadata)) out.metadata = body.metadata;
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/anthropicShim/requestTranslator.test.ts`
Expected: PASS — all 21 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/anthropicShim/requestTranslator.ts tests/unit/anthropicShim/requestTranslator.test.ts
git commit -m "feat(anthropicShim): add requestTranslator with Plan 03 scope enforcement"
```

---

## Task 4: Response translator — NormalizedEvent → Anthropic SSE + buffered

**Files:**
- Create: `src/anthropicShim/responseTranslator.ts`
- Test: `tests/unit/anthropicShim/responseTranslator.test.ts`

Two functions:
- `normalizedEventsToSSE(events, meta)` — async generator yielding raw SSE event strings. Each yield is a complete `event: <name>\ndata: <json>\n\n` chunk that the handler writes directly to the response.
- `normalizedEventsToFinalResponse(events, meta)` — async function that buffers all events and returns the assembled Anthropic non-streaming response body.

Anthropic SSE format is **event-typed** (`event: message_start\ndata: {...}\n\n`), distinct from OpenAI SSE (`data: {...}\n\n`). Honor the event ordering Anthropic documents: `message_start` → `content_block_start` (per index) → `content_block_delta` (per delta) → `content_block_stop` (per index) → `message_delta` (carrying stop_reason + usage) → `message_stop`. Plan 03 only emits text content blocks; later plans add `tool_use` blocks.

Stop reason mapping: `NormalizedEvent.message_stop.stopReason` is `"end_turn" | "stop_sequence" | "max_tokens" | "tool_use" | "error"`. Map to Anthropic's `stop_reason` field: `"end_turn"` → `"end_turn"`, `"stop_sequence"` → `"stop_sequence"`, `"max_tokens"` → `"max_tokens"`, `"tool_use"` → `"tool_use"`, `"error"` → `null` (error already surfaced via the HTTP response upstream).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/anthropicShim/responseTranslator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  normalizedEventsToFinalResponse,
  normalizedEventsToSSE
} from "../../../src/anthropicShim/responseTranslator.js";
import type { NormalizedEvent } from "../../../src/backends/types.js";

async function* fromArray(events: NormalizedEvent[]): AsyncIterable<NormalizedEvent> {
  for (const e of events) yield e;
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function parseSseChunk(chunk: string): { event: string; data: unknown } {
  const lines = chunk.split("\n");
  const event = lines[0]?.replace(/^event:\s*/, "") ?? "";
  const data = lines[1]?.replace(/^data:\s*/, "") ?? "";
  return { event, data: JSON.parse(data) };
}

const META = { messageId: "msg_test_001", model: "claude-sonnet-4-6" };

describe("normalizedEventsToSSE — single text block", () => {
  it("emits the documented Anthropic event sequence", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hello " },
      { kind: "text_delta", index: 0, text: "world" },
      {
        kind: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 2 }
      }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const parsed = chunks.map(parseSseChunk);
    expect(parsed.map((p) => p.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]);
  });

  it("message_start carries id, model, role, and zeroed usage", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const start = parseSseChunk(chunks[0]!);
    expect(start.event).toBe("message_start");
    expect(start.data).toMatchObject({
      type: "message_start",
      message: {
        id: "msg_test_001",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  });

  it("content_block_start carries index and empty text block", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const start = parseSseChunk(chunks[1]!);
    expect(start.event).toBe("content_block_start");
    expect(start.data).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    });
  });

  it("content_block_delta carries index and text_delta", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hello" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const delta = parseSseChunk(chunks[2]!);
    expect(delta.event).toBe("content_block_delta");
    expect(delta.data).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" }
    });
  });

  it("message_delta carries stop_reason and usage", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hi" },
      {
        kind: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 2 }
      }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const messageDelta = parseSseChunk(chunks[chunks.length - 2]!);
    expect(messageDelta.event).toBe("message_delta");
    expect(messageDelta.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 }
    });
  });

  it("each emitted chunk is a complete Anthropic SSE event", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    for (const chunk of chunks) {
      expect(chunk.startsWith("event: ")).toBe(true);
      expect(chunk.endsWith("\n\n")).toBe(true);
      expect(chunk.split("\n").filter((l) => l.startsWith("data: "))).toHaveLength(1);
    }
  });

  it("synthesizes message_start when the source stream omits it", async () => {
    const events: NormalizedEvent[] = [
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    expect(parseSseChunk(chunks[0]!).event).toBe("message_start");
  });

  it("synthesizes message_stop when the source stream ends without one", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hi" }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!);
    expect(last.event).toBe("message_stop");
  });
});

describe("normalizedEventsToSSE — stop_reason mapping", () => {
  async function stopReasonInResponse(
    reason: NonNullable<
      Extract<NormalizedEvent, { kind: "message_stop" }>["stopReason"]
    >
  ): Promise<unknown> {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: reason }
    ];
    const chunks = await collect(normalizedEventsToSSE(fromArray(events), META));
    const messageDelta = parseSseChunk(chunks[chunks.length - 2]!);
    return (messageDelta.data as { delta: { stop_reason: unknown } }).delta.stop_reason;
  }

  it("maps end_turn → end_turn", async () => {
    expect(await stopReasonInResponse("end_turn")).toBe("end_turn");
  });

  it("maps stop_sequence → stop_sequence", async () => {
    expect(await stopReasonInResponse("stop_sequence")).toBe("stop_sequence");
  });

  it("maps max_tokens → max_tokens", async () => {
    expect(await stopReasonInResponse("max_tokens")).toBe("max_tokens");
  });

  it("maps tool_use → tool_use", async () => {
    expect(await stopReasonInResponse("tool_use")).toBe("tool_use");
  });

  it("maps error → null", async () => {
    expect(await stopReasonInResponse("error")).toBeNull();
  });
});

describe("normalizedEventsToFinalResponse — non-streaming aggregation", () => {
  it("assembles a single text block from concatenated deltas", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hello " },
      { kind: "text_delta", index: 0, text: "world" },
      {
        kind: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 2 }
      }
    ];
    const resp = await normalizedEventsToFinalResponse(fromArray(events), META);
    expect(resp).toEqual({
      id: "msg_test_001",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hello world" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 }
    });
  });

  it("returns zeroed usage when the source provides none", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const resp = await normalizedEventsToFinalResponse(fromArray(events), META);
    expect(resp.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("returns stop_reason null on error events", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      { kind: "text_delta", index: 0, text: "partial" },
      { kind: "message_stop", stopReason: "error" }
    ];
    const resp = await normalizedEventsToFinalResponse(fromArray(events), META);
    expect(resp.stop_reason).toBeNull();
  });

  it("model field uses meta.model (not the backend's reported model id)", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "DIFFERENT-MODEL" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const resp = await normalizedEventsToFinalResponse(fromArray(events), META);
    expect(resp.model).toBe("claude-sonnet-4-6");
  });

  it("empty event stream returns an empty content array and stop_reason null", async () => {
    const events: NormalizedEvent[] = [];
    const resp = await normalizedEventsToFinalResponse(fromArray(events), META);
    expect(resp.content).toEqual([]);
    expect(resp.stop_reason).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/anthropicShim/responseTranslator.test.ts`
Expected: FAIL — module `src/anthropicShim/responseTranslator.js` not found.

- [ ] **Step 3: Create `src/anthropicShim/responseTranslator.ts`**

```ts
import type { NormalizedEvent } from "../backends/types.js";
import type {
  AnthropicMessagesResponse,
  AnthropicStopReason
} from "./types.js";

export interface ResponseMeta {
  /** Anthropic message id ("msg_..."). Caller supplies. */
  messageId: string;
  /** Model id as the client requested it. */
  model: string;
}

function mapStopReason(
  reason: Extract<NormalizedEvent, { kind: "message_stop" }>["stopReason"]
): AnthropicStopReason | null {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "stop_sequence":
      return "stop_sequence";
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "error":
      return null;
  }
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Yield Anthropic-shaped SSE event strings for each NormalizedEvent.
 *
 * Synthesizes the leading `message_start` if the source stream omits it
 * (some backends emit text_delta first when there's no init event upstream).
 * Synthesizes the trailing `message_delta` + `message_stop` if the source
 * stream ends without one. Never emits content_block_start/stop for a block
 * that received zero deltas.
 */
export async function* normalizedEventsToSSE(
  events: AsyncIterable<NormalizedEvent>,
  meta: ResponseMeta
): AsyncIterable<string> {
  let startEmitted = false;
  // Track which content-block indexes have been opened so we can emit
  // start/stop pairs as deltas come and go.
  const openBlocks = new Set<number>();
  let stopReason: AnthropicStopReason | null = null;
  let outputTokens = 0;
  let messageStopSent = false;

  function ensureStart(model: string): string | undefined {
    if (startEmitted) return undefined;
    startEmitted = true;
    return sse("message_start", {
      type: "message_start",
      message: {
        id: meta.messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  for await (const ev of events) {
    if (ev.kind === "message_start") {
      const chunk = ensureStart(ev.model || meta.model);
      if (chunk) yield chunk;
      continue;
    }

    if (ev.kind === "text_delta") {
      const chunk = ensureStart(meta.model);
      if (chunk) yield chunk;
      if (!openBlocks.has(ev.index)) {
        openBlocks.add(ev.index);
        yield sse("content_block_start", {
          type: "content_block_start",
          index: ev.index,
          content_block: { type: "text", text: "" }
        });
      }
      yield sse("content_block_delta", {
        type: "content_block_delta",
        index: ev.index,
        delta: { type: "text_delta", text: ev.text }
      });
      continue;
    }

    if (ev.kind === "message_stop") {
      const chunk = ensureStart(meta.model);
      if (chunk) yield chunk;
      // Close every still-open content block.
      for (const idx of [...openBlocks].sort((a, b) => a - b)) {
        yield sse("content_block_stop", {
          type: "content_block_stop",
          index: idx
        });
      }
      openBlocks.clear();
      stopReason = mapStopReason(ev.stopReason);
      outputTokens = ev.usage?.outputTokens ?? 0;
      yield sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens }
      });
      yield sse("message_stop", { type: "message_stop" });
      messageStopSent = true;
      return;
    }

    // tool_use_* events are Plan-04 territory. If they arrive here, ignore
    // them rather than crashing — the request translator already rejected
    // requests that would have caused them.
  }

  // Source ended without an explicit message_stop. Synthesize one so clients
  // never see a half-open stream.
  if (!messageStopSent) {
    const chunk = ensureStart(meta.model);
    if (chunk) yield chunk;
    for (const idx of [...openBlocks].sort((a, b) => a - b)) {
      yield sse("content_block_stop", {
        type: "content_block_stop",
        index: idx
      });
    }
    yield sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: null, stop_sequence: null },
      usage: { output_tokens: outputTokens }
    });
    yield sse("message_stop", { type: "message_stop" });
  }
}

/**
 * Buffer the entire event stream and assemble the non-streaming response body.
 * Each content-block index gets its own AnthropicResponseTextBlock; deltas with
 * the same index are concatenated in arrival order.
 */
export async function normalizedEventsToFinalResponse(
  events: AsyncIterable<NormalizedEvent>,
  meta: ResponseMeta
): Promise<AnthropicMessagesResponse> {
  // Index → accumulated text. Map preserves insertion order, which is the
  // order content blocks first appeared.
  const blocks = new Map<number, string>();
  let stopReason: AnthropicStopReason | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const ev of events) {
    if (ev.kind === "text_delta") {
      blocks.set(ev.index, (blocks.get(ev.index) ?? "") + ev.text);
    } else if (ev.kind === "message_stop") {
      stopReason = mapStopReason(ev.stopReason);
      if (ev.usage) {
        inputTokens = ev.usage.inputTokens;
        outputTokens = ev.usage.outputTokens;
      }
    }
    // message_start ignored — meta.model wins
    // tool_use_* ignored in Plan 03 — request translator rejects upstream
  }

  return {
    id: meta.messageId,
    type: "message",
    role: "assistant",
    model: meta.model,
    content: Array.from(blocks.values()).map((text) => ({ type: "text", text })),
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/anthropicShim/responseTranslator.test.ts`
Expected: PASS — all 16 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/anthropicShim/responseTranslator.ts tests/unit/anthropicShim/responseTranslator.test.ts
git commit -m "feat(anthropicShim): add responseTranslator for SSE + buffered Anthropic shapes"
```

---

## Task 5: Messages handler factory

**Files:**
- Create: `src/anthropicShim/messages.ts`
- Test: `tests/unit/anthropicShim/messages.test.ts`

Express handler factory `createMessagesHandler(deps)`. Auth check → request translation → backend resolution via registry + router → streaming or buffered response. All dependencies (registry, config, archive — even though archive is unused in Plan 03 it's threaded for Plan 05) come in via the deps object; no module-scoped state.

Handler contract:
1. `checkAuth(req, config.apiKey)` — 401 with `authentication_error` envelope on failure.
2. `anthropicRequestToNormalized(req.body)` — `ShimRequestError` → status code + `invalid_request_error` envelope.
3. `identifyBackend(req.body.model, config.router.defaultBackend)` returns `{ backend: BackendId | null, ... }`. If `backend` is null, call `registry.resolveModel(remainingModel)` to look up by model id. If still unresolved, 404 `not_found_error`.
4. If `req.body.stream === true`, write SSE response. Otherwise buffer and write JSON.
5. Generate a fresh `messageId` (`msg_` + crypto-random hex) for both paths.

Mock the `Backend` interface in unit tests so the handler can be exercised without spawning a real CLI.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/anthropicShim/messages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { BackendRegistry } from "../../../src/backends/registry.js";
import { createMessagesHandler } from "../../../src/anthropicShim/messages.js";
import type {
  Backend,
  BackendCapabilities,
  NormalizedEvent,
  NormalizedRequest
} from "../../../src/backends/types.js";

interface Recorded {
  request?: NormalizedRequest;
}

function stubClaude(opts: {
  models?: string[];
  events?: NormalizedEvent[];
  countTokensReturn?: number;
  recorded?: Recorded;
}): Backend {
  const caps: BackendCapabilities = {
    toolUse: false,
    multimodal: false,
    thinking: false,
    cacheControl: "none",
    samplingParams: { temperature: false, topP: false, topK: false },
    stopSequences: "server-side-cut",
    embeddings: false
  };
  const events = opts.events ?? [
    { kind: "message_start", model: "claude-sonnet-4-6" },
    { kind: "text_delta", index: 0, text: "ok" },
    {
      kind: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 }
    }
  ];
  return {
    id: "claude",
    capabilitiesFor: () => caps,
    listModels: async () => (opts.models ?? ["claude-sonnet-4-6"]).map((id) => ({ id })),
    invoke: async function* (req: NormalizedRequest) {
      if (opts.recorded) opts.recorded.request = req;
      for (const e of events) yield e;
    },
    countTokens: async () => opts.countTokensReturn ?? 1
  };
}

function buildApp(opts: {
  apiKey: string;
  backend: Backend;
  defaultBackend?: "claude" | "gemini" | "lmstudio" | "ollama";
}): express.Express {
  const registry = new BackendRegistry({
    claude: 100,
    gemini: 90,
    lmstudio: 50,
    ollama: 40
  });
  registry.register(opts.backend);
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.post(
    "/v1/messages",
    createMessagesHandler({
      registry,
      config: {
        apiKey: opts.apiKey,
        router: { defaultBackend: opts.defaultBackend ?? "claude" }
      }
    })
  );
  return app;
}

describe("POST /v1/messages — auth", () => {
  it("returns 401 with Anthropic-shaped envelope on missing key", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      type: "error",
      error: { type: "authentication_error", message: expect.any(String) }
    });
  });

  it("returns 401 with Anthropic-shaped envelope on wrong key", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "wrong")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(401);
  });

  it("accepts x-api-key header", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(200);
  });

  it("accepts Authorization: Bearer", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("Authorization", "Bearer sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/messages — request validation", () => {
  it("returns 400 with invalid_request_error envelope on missing model", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: expect.stringMatching(/model/i) }
    });
  });

  it("returns 400 on image content blocks (Plan 03 scope)", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "X" } }
            ]
          }
        ]
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/image|multimodal/i);
  });

  it("returns 400 on non-empty tools array (Plan 03 scope)", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "calc", input_schema: {} }]
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/tool/i);
  });

  it("returns 400 on non-empty stop_sequences (Plan 03 scope)", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        stop_sequences: ["STOP"]
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/stop_sequences/i);
  });
});

describe("POST /v1/messages — routing", () => {
  it("returns 404 with not_found_error envelope on unknown model", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "qwen3-coder-30b",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(404);
    expect(res.body.error.type).toBe("not_found_error");
  });

  it("routes claude-* models to the Claude backend even without probe", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/messages — non-streaming response", () => {
  it("returns the Anthropic non-streaming body shape", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }
    });
    expect(res.body.id).toMatch(/^msg_/);
  });

  it("forwards the translated NormalizedRequest to the backend", async () => {
    const recorded: Recorded = {};
    const app = buildApp({
      apiKey: "sk-test",
      backend: stubClaude({ recorded })
    });
    await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        system: "be brief",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(recorded.request).toEqual({
      model: "claude-sonnet-4-6",
      system: "be brief",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] }
      ]
    });
  });
});

describe("POST /v1/messages — streaming response", () => {
  it("emits Content-Type: text/event-stream", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
  });

  it("emits the documented Anthropic event sequence", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      });
    const text = res.text;
    const eventNames = text
      .split("\n\n")
      .filter((b) => b.length > 0)
      .map((b) => {
        const first = b.split("\n")[0] ?? "";
        return first.replace(/^event:\s*/, "");
      });
    expect(eventNames).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]);
  });
});

describe("POST /v1/messages — backend errors", () => {
  it("surfaces backend.invoke throws as 500 with api_error envelope", async () => {
    const failing: Backend = {
      id: "claude",
      capabilitiesFor: () => ({
        toolUse: false,
        multimodal: false,
        thinking: false,
        cacheControl: "none",
        samplingParams: { temperature: false, topP: false, topK: false },
        stopSequences: "server-side-cut",
        embeddings: false
      }),
      listModels: async () => [{ id: "claude-sonnet-4-6" }],
      invoke: async function* (): AsyncIterable<NormalizedEvent> {
        throw new Error("backend boom");
      },
      countTokens: async () => 0
    };
    const app = buildApp({ apiKey: "sk-test", backend: failing });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      type: "error",
      error: { type: "api_error", message: expect.stringContaining("backend boom") }
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/anthropicShim/messages.test.ts`
Expected: FAIL — module `src/anthropicShim/messages.js` not found.

- [ ] **Step 3: Create `src/anthropicShim/messages.ts`**

```ts
import type { Request, RequestHandler, Response } from "express";
import { randomBytes } from "node:crypto";
import { checkAuth } from "../auth.js";
import type { BackendRegistry } from "../backends/registry.js";
import type { Backend, BackendId } from "../backends/types.js";
import { identifyBackend } from "../modelRouter.js";
import {
  authenticationError,
  internalServerError,
  invalidRequestError,
  notFoundError,
  ShimRequestError
} from "./errors.js";
import { anthropicRequestToNormalized } from "./requestTranslator.js";
import {
  normalizedEventsToFinalResponse,
  normalizedEventsToSSE
} from "./responseTranslator.js";
import type { AnthropicMessagesRequest } from "./types.js";

export interface MessagesHandlerConfig {
  apiKey: string;
  router: { defaultBackend: BackendId };
}

export interface MessagesHandlerDeps {
  registry: BackendRegistry;
  config: MessagesHandlerConfig;
}

function newMessageId(): string {
  return `msg_${randomBytes(12).toString("hex")}`;
}

function resolveBackend(
  registry: BackendRegistry,
  defaultBackend: BackendId,
  requestedModel: string
): { backend: Backend; resolvedModel: string } | { error: "not_found" } {
  const ident = identifyBackend(requestedModel, defaultBackend);
  if (ident.backend !== null) {
    const backend = registry.get(ident.backend);
    if (!backend) return { error: "not_found" };
    return { backend, resolvedModel: ident.remainingModel || requestedModel };
  }
  // Bare local model name — consult the registry's discovered model map.
  const found = registry.resolveModel(ident.remainingModel);
  if (found) return { backend: found, resolvedModel: ident.remainingModel };
  return { error: "not_found" };
}

export function createMessagesHandler(deps: MessagesHandlerDeps): RequestHandler {
  return async (req: Request, res: Response) => {
    // ---- Auth -----------------------------------------------------------
    if (!checkAuth(req, deps.config.apiKey)) {
      res.status(401).json(authenticationError("invalid or missing API key"));
      return;
    }

    // ---- Translate ------------------------------------------------------
    const body = req.body as AnthropicMessagesRequest;
    let normalized;
    try {
      normalized = anthropicRequestToNormalized(body);
    } catch (e) {
      if (e instanceof ShimRequestError) {
        res.status(e.status).json(invalidRequestError(e.message));
        return;
      }
      res
        .status(500)
        .json(internalServerError(e instanceof Error ? e.message : String(e)));
      return;
    }

    // ---- Route ----------------------------------------------------------
    const resolved = resolveBackend(
      deps.registry,
      deps.config.router.defaultBackend,
      normalized.model
    );
    if ("error" in resolved) {
      res
        .status(404)
        .json(notFoundError(`model ${normalized.model} not found in any enabled backend`));
      return;
    }
    const { backend } = resolved;

    // ---- Invoke ---------------------------------------------------------
    const messageId = newMessageId();
    const meta = { messageId, model: normalized.model };
    const wantStream = body.stream === true;

    try {
      const events = backend.invoke(normalized);

      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        for await (const chunk of normalizedEventsToSSE(events, meta)) {
          res.write(chunk);
        }
        res.end();
      } else {
        const finalBody = await normalizedEventsToFinalResponse(events, meta);
        res.status(200).json(finalBody);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (res.headersSent) {
        // Streaming already started; we can't change the status code. The
        // only thing we can do is end the stream — Plan 11 will document
        // this corner in the admin/error logs.
        res.end();
      } else {
        res.status(500).json(internalServerError(`backend error: ${msg}`));
      }
    }
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/anthropicShim/messages.test.ts`
Expected: PASS — all 12 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/anthropicShim/messages.ts tests/unit/anthropicShim/messages.test.ts
git commit -m "feat(anthropicShim): add /v1/messages handler with streaming + non-streaming paths"
```

---

## Task 6: Count tokens handler factory

**Files:**
- Create: `src/anthropicShim/countTokens.ts`
- Test: `tests/unit/anthropicShim/countTokens.test.ts`

`POST /v1/messages/count_tokens` accepts an Anthropic Messages request body (same shape minus `stream`) and returns `{input_tokens: <n>}`. The handler:
1. Auth check.
2. Translate request via `anthropicRequestToNormalized`.
3. Resolve backend the same way `/v1/messages` does.
4. Call `backend.countTokens(normalized)`.

Plan 03's `ClaudeBackend.countTokens` is char/4 (from Plan 02). When Plan 05 lands the real tokenizer dispatch, the handler doesn't change.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/anthropicShim/countTokens.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { BackendRegistry } from "../../../src/backends/registry.js";
import { createCountTokensHandler } from "../../../src/anthropicShim/countTokens.js";
import type {
  Backend,
  BackendCapabilities,
  NormalizedEvent,
  NormalizedRequest
} from "../../../src/backends/types.js";

function stubBackend(opts: {
  countTokensReturn: number;
  models?: string[];
}): Backend {
  const caps: BackendCapabilities = {
    toolUse: false,
    multimodal: false,
    thinking: false,
    cacheControl: "none",
    samplingParams: { temperature: false, topP: false, topK: false },
    stopSequences: "server-side-cut",
    embeddings: false
  };
  return {
    id: "claude",
    capabilitiesFor: () => caps,
    listModels: async () => (opts.models ?? ["claude-sonnet-4-6"]).map((id) => ({ id })),
    invoke: async function* (): AsyncIterable<NormalizedEvent> {
      // unused in this endpoint
    },
    countTokens: async (_req: NormalizedRequest) => opts.countTokensReturn
  };
}

function buildApp(opts: { apiKey: string; backend: Backend }): express.Express {
  const registry = new BackendRegistry({
    claude: 100,
    gemini: 90,
    lmstudio: 50,
    ollama: 40
  });
  registry.register(opts.backend);
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.post(
    "/v1/messages/count_tokens",
    createCountTokensHandler({
      registry,
      config: {
        apiKey: opts.apiKey,
        router: { defaultBackend: "claude" }
      }
    })
  );
  return app;
}

describe("POST /v1/messages/count_tokens", () => {
  it("returns 401 on missing auth", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubBackend({ countTokensReturn: 5 }) });
    const res = await request(app)
      .post("/v1/messages/count_tokens")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(401);
  });

  it("returns 400 on missing model", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubBackend({ countTokensReturn: 5 }) });
    const res = await request(app)
      .post("/v1/messages/count_tokens")
      .set("x-api-key", "sk-test")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
  });

  it("returns 404 on unknown model", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubBackend({ countTokensReturn: 5 }) });
    const res = await request(app)
      .post("/v1/messages/count_tokens")
      .set("x-api-key", "sk-test")
      .send({
        model: "qwen3-coder-30b",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(404);
  });

  it("delegates to backend.countTokens and returns Anthropic-shaped {input_tokens}", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backend: stubBackend({ countTokensReturn: 42 })
    });
    const res = await request(app)
      .post("/v1/messages/count_tokens")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello world" }]
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ input_tokens: 42 });
  });

  it("rejects out-of-scope content (e.g. image) with 400", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backend: stubBackend({ countTokensReturn: 1 })
    });
    const res = await request(app)
      .post("/v1/messages/count_tokens")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "X" } }
            ]
          }
        ]
      });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/anthropicShim/countTokens.test.ts`
Expected: FAIL — module `src/anthropicShim/countTokens.js` not found.

- [ ] **Step 3: Create `src/anthropicShim/countTokens.ts`**

```ts
import type { Request, RequestHandler, Response } from "express";
import { checkAuth } from "../auth.js";
import type { BackendRegistry } from "../backends/registry.js";
import type { Backend, BackendId } from "../backends/types.js";
import { identifyBackend } from "../modelRouter.js";
import {
  authenticationError,
  internalServerError,
  invalidRequestError,
  notFoundError,
  ShimRequestError
} from "./errors.js";
import { anthropicRequestToNormalized } from "./requestTranslator.js";
import type {
  AnthropicCountTokensResponse,
  AnthropicMessagesRequest
} from "./types.js";

export interface CountTokensHandlerConfig {
  apiKey: string;
  router: { defaultBackend: BackendId };
}

export interface CountTokensHandlerDeps {
  registry: BackendRegistry;
  config: CountTokensHandlerConfig;
}

function resolveBackend(
  registry: BackendRegistry,
  defaultBackend: BackendId,
  requestedModel: string
): Backend | undefined {
  const ident = identifyBackend(requestedModel, defaultBackend);
  if (ident.backend !== null) return registry.get(ident.backend);
  return registry.resolveModel(ident.remainingModel);
}

export function createCountTokensHandler(
  deps: CountTokensHandlerDeps
): RequestHandler {
  return async (req: Request, res: Response) => {
    if (!checkAuth(req, deps.config.apiKey)) {
      res.status(401).json(authenticationError("invalid or missing API key"));
      return;
    }

    const body = req.body as AnthropicMessagesRequest;
    let normalized;
    try {
      normalized = anthropicRequestToNormalized(body);
    } catch (e) {
      if (e instanceof ShimRequestError) {
        res.status(e.status).json(invalidRequestError(e.message));
        return;
      }
      res
        .status(500)
        .json(internalServerError(e instanceof Error ? e.message : String(e)));
      return;
    }

    const backend = resolveBackend(
      deps.registry,
      deps.config.router.defaultBackend,
      normalized.model
    );
    if (!backend) {
      res
        .status(404)
        .json(notFoundError(`model ${normalized.model} not found in any enabled backend`));
      return;
    }

    try {
      const inputTokens = await backend.countTokens(normalized);
      const out: AnthropicCountTokensResponse = { input_tokens: inputTokens };
      res.status(200).json(out);
    } catch (e) {
      res
        .status(500)
        .json(internalServerError(e instanceof Error ? e.message : String(e)));
    }
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/anthropicShim/countTokens.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/anthropicShim/countTokens.ts tests/unit/anthropicShim/countTokens.test.ts
git commit -m "feat(anthropicShim): add /v1/messages/count_tokens handler delegating to backend"
```

---

## Task 7: Models handlers factory

**Files:**
- Create: `src/anthropicShim/models.ts`
- Test: `tests/unit/anthropicShim/models.test.ts`

`GET /v1/models` returns `{data: [...], has_more: false, first_id, last_id}` — Anthropic's unpaginated list shape. Each entry has `{type: "model", id, display_name, created_at}`. Lists models across **all enabled backends**, not just Claude — the Anthropic shim becomes the unified model directory per the spec.

`GET /v1/models/{id}` returns a single entry or 404.

Plan 03 deferrals:
- No pagination (`has_more: false` always).
- `created_at` is a fixed ISO-8601 string per model (curated alongside the catalog).
- No filtering / no search.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/anthropicShim/models.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { BackendRegistry } from "../../../src/backends/registry.js";
import {
  createModelsHandlers
} from "../../../src/anthropicShim/models.js";
import type {
  Backend,
  BackendCapabilities,
  ModelDescriptor,
  NormalizedEvent
} from "../../../src/backends/types.js";

function stubBackend(id: Backend["id"], models: ModelDescriptor[]): Backend {
  const caps: BackendCapabilities = {
    toolUse: false,
    multimodal: false,
    thinking: false,
    cacheControl: "none",
    samplingParams: { temperature: false, topP: false, topK: false },
    stopSequences: "server-side-cut",
    embeddings: false
  };
  return {
    id,
    capabilitiesFor: () => caps,
    listModels: async () => models,
    invoke: async function* (): AsyncIterable<NormalizedEvent> {},
    countTokens: async () => 0
  };
}

async function buildApp(opts: {
  apiKey: string;
  backends: Backend[];
}): Promise<express.Express> {
  const registry = new BackendRegistry({
    claude: 100,
    gemini: 90,
    lmstudio: 50,
    ollama: 40
  });
  for (const b of opts.backends) registry.register(b);
  await registry.probe();

  const handlers = createModelsHandlers({
    registry,
    config: { apiKey: opts.apiKey }
  });
  const app = express();
  app.get("/v1/models", handlers.list);
  app.get("/v1/models/:id", handlers.get);
  return app;
}

describe("GET /v1/models", () => {
  it("returns 401 on missing auth", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend("claude", [{ id: "claude-sonnet-4-6" }])]
    });
    const res = await request(app).get("/v1/models");
    expect(res.status).toBe(401);
  });

  it("returns the Anthropic models list envelope", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend("claude", [
          { id: "claude-opus-4-7" },
          { id: "claude-sonnet-4-6" }
        ])
      ]
    });
    const res = await request(app)
      .get("/v1/models")
      .set("x-api-key", "sk-test");
    expect(res.status).toBe(200);
    expect(res.body.has_more).toBe(false);
    expect(Array.isArray(res.body.data)).toBe(true);
    for (const entry of res.body.data) {
      expect(entry).toMatchObject({
        type: "model",
        id: expect.any(String),
        display_name: expect.any(String),
        created_at: expect.any(String)
      });
    }
  });

  it("first_id and last_id reflect the data array bounds", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend("claude", [
          { id: "claude-opus-4-7" },
          { id: "claude-sonnet-4-6" },
          { id: "claude-haiku-4-5" }
        ])
      ]
    });
    const res = await request(app)
      .get("/v1/models")
      .set("x-api-key", "sk-test");
    expect(res.body.first_id).toBe(res.body.data[0].id);
    expect(res.body.last_id).toBe(res.body.data[res.body.data.length - 1].id);
  });

  it("lists models across all enabled backends", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend("claude", [{ id: "claude-sonnet-4-6" }]),
        stubBackend("ollama", [{ id: "llama-3.3-70b" }])
      ]
    });
    const res = await request(app)
      .get("/v1/models")
      .set("x-api-key", "sk-test");
    const ids = res.body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("llama-3.3-70b");
  });

  it("returns empty data array when no backend has any models", async () => {
    const app = await buildApp({ apiKey: "sk-test", backends: [] });
    const res = await request(app)
      .get("/v1/models")
      .set("x-api-key", "sk-test");
    expect(res.body).toEqual({
      data: [],
      has_more: false,
      first_id: null,
      last_id: null
    });
  });

  it("deduplicates model ids that appear in multiple backends (registry already sorts by priority)", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend("lmstudio", [{ id: "shared" }]),
        stubBackend("ollama", [{ id: "shared" }])
      ]
    });
    const res = await request(app)
      .get("/v1/models")
      .set("x-api-key", "sk-test");
    const sharedCount = res.body.data.filter(
      (m: { id: string }) => m.id === "shared"
    ).length;
    expect(sharedCount).toBe(1);
  });
});

describe("GET /v1/models/:id", () => {
  it("returns 401 on missing auth", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend("claude", [{ id: "claude-sonnet-4-6" }])]
    });
    const res = await request(app).get("/v1/models/claude-sonnet-4-6");
    expect(res.status).toBe(401);
  });

  it("returns the single model entry on hit", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend("claude", [{ id: "claude-sonnet-4-6" }])]
    });
    const res = await request(app)
      .get("/v1/models/claude-sonnet-4-6")
      .set("x-api-key", "sk-test");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "model",
      id: "claude-sonnet-4-6",
      display_name: expect.any(String),
      created_at: expect.any(String)
    });
  });

  it("returns 404 with not_found_error envelope on unknown model", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend("claude", [{ id: "claude-sonnet-4-6" }])]
    });
    const res = await request(app)
      .get("/v1/models/no-such-model")
      .set("x-api-key", "sk-test");
    expect(res.status).toBe(404);
    expect(res.body.error.type).toBe("not_found_error");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/anthropicShim/models.test.ts`
Expected: FAIL — module `src/anthropicShim/models.js` not found.

- [ ] **Step 3: Create `src/anthropicShim/models.ts`**

```ts
import type { Request, RequestHandler, Response } from "express";
import { checkAuth } from "../auth.js";
import type { BackendRegistry } from "../backends/registry.js";
import type { ModelDescriptor } from "../backends/types.js";
import {
  authenticationError,
  internalServerError,
  notFoundError
} from "./errors.js";
import type {
  AnthropicModelEntry,
  AnthropicModelsListResponse
} from "./types.js";

export interface ModelsHandlerConfig {
  apiKey: string;
}

export interface ModelsHandlerDeps {
  registry: BackendRegistry;
  config: ModelsHandlerConfig;
}

/**
 * Single fixed created_at for entries that lack a known release date. The
 * Anthropic shim is required to surface this field, but the platform doesn't
 * have a per-model release-date catalog yet. Plan 09 (when the model registry
 * grows admin endpoints) can backfill real dates.
 */
const PLACEHOLDER_CREATED_AT = "2026-01-01T00:00:00Z";

function descriptorToEntry(desc: ModelDescriptor): AnthropicModelEntry {
  return {
    type: "model",
    id: desc.id,
    display_name: desc.description ?? desc.id,
    created_at: PLACEHOLDER_CREATED_AT
  };
}

async function gatherAllModels(
  registry: BackendRegistry
): Promise<AnthropicModelEntry[]> {
  const seen = new Set<string>();
  const out: AnthropicModelEntry[] = [];
  for (const backend of registry.enabledBackends()) {
    let models: ModelDescriptor[];
    try {
      models = await backend.listModels();
    } catch {
      // A failing backend shouldn't blank out the whole listing.
      continue;
    }
    for (const m of models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(descriptorToEntry(m));
    }
  }
  return out;
}

export interface ModelsHandlers {
  list: RequestHandler;
  get: RequestHandler;
}

export function createModelsHandlers(deps: ModelsHandlerDeps): ModelsHandlers {
  const list: RequestHandler = async (req: Request, res: Response) => {
    if (!checkAuth(req, deps.config.apiKey)) {
      res.status(401).json(authenticationError("invalid or missing API key"));
      return;
    }
    try {
      const entries = await gatherAllModels(deps.registry);
      const body: AnthropicModelsListResponse = {
        data: entries,
        has_more: false,
        first_id: entries[0]?.id ?? null,
        last_id: entries[entries.length - 1]?.id ?? null
      };
      res.status(200).json(body);
    } catch (e) {
      res
        .status(500)
        .json(internalServerError(e instanceof Error ? e.message : String(e)));
    }
  };

  const get: RequestHandler = async (req: Request, res: Response) => {
    if (!checkAuth(req, deps.config.apiKey)) {
      res.status(401).json(authenticationError("invalid or missing API key"));
      return;
    }
    const id = req.params["id"];
    if (typeof id !== "string" || id.length === 0) {
      res.status(404).json(notFoundError("missing model id"));
      return;
    }
    try {
      const entries = await gatherAllModels(deps.registry);
      const found = entries.find((e) => e.id === id);
      if (!found) {
        res.status(404).json(notFoundError(`model ${id} not found`));
        return;
      }
      res.status(200).json(found);
    } catch (e) {
      res
        .status(500)
        .json(internalServerError(e instanceof Error ? e.message : String(e)));
    }
  };

  return { list, get };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/anthropicShim/models.test.ts`
Expected: PASS — all 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/anthropicShim/models.ts tests/unit/anthropicShim/models.test.ts
git commit -m "feat(anthropicShim): add /v1/models list and get handlers (cross-backend)"
```

---

## Task 8: Server bootstrap + CLI entry

**Files:**
- Create: `src/server.ts`
- Create: `src/bin.ts`

Express app assembly. `main(opts)` is the exported entry the CLI calls. `buildApp(deps)` builds and returns the Express app without binding a port — used by the integration test in Task 9. Graceful shutdown stops the periodic probe, closes the archive, and waits for in-flight requests via `http.Server.close()` with a 5-second hard-deadline.

`src/bin.ts` parses `--config <path>` from argv and calls `main()`. Kept tiny so tests never need to spawn it for unit coverage (that's the integration test's job).

- [ ] **Step 1: Create `src/server.ts`**

```ts
import express, { type Express } from "express";
import type { Server } from "node:http";
import { Archive } from "./archive.js";
import { BackendRegistry } from "./backends/registry.js";
import { ClaudeBackend } from "./backends/claudeBackend.js";
import type { Backend, BackendId } from "./backends/types.js";
import { loadConfig, type Config } from "./config.js";
import { createCountTokensHandler } from "./anthropicShim/countTokens.js";
import { createMessagesHandler } from "./anthropicShim/messages.js";
import { createModelsHandlers } from "./anthropicShim/models.js";

export interface ServerDeps {
  config: Config;
  registry: BackendRegistry;
  archive: Archive;
}

/**
 * Build the Express app without binding a port. Exported so unit tests can
 * exercise the full routing surface against supertest without race conditions.
 */
export function buildApp(deps: ServerDeps): Express {
  const app = express();
  app.use(express.json({ limit: "32mb" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // ---- Anthropic shim --------------------------------------------------
  const handlerConfig = {
    apiKey: deps.config.apiKey,
    router: { defaultBackend: deps.config.router.defaultBackend }
  };

  app.post(
    "/v1/messages",
    createMessagesHandler({ registry: deps.registry, config: handlerConfig })
  );
  app.post(
    "/v1/messages/count_tokens",
    createCountTokensHandler({ registry: deps.registry, config: handlerConfig })
  );

  const modelsHandlers = createModelsHandlers({
    registry: deps.registry,
    config: { apiKey: deps.config.apiKey }
  });
  app.get("/v1/models", modelsHandlers.list);
  app.get("/v1/models/:id", modelsHandlers.get);

  return app;
}

/**
 * Build a registry populated with every enabled backend. Plan 03 only knows
 * about ClaudeBackend; later plans add gemini/lmstudio/ollama here.
 */
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
  return registry;
}

export interface MainOptions {
  configPath: string;
  port?: number;
}

export interface RunningServer {
  app: Express;
  http: Server;
  registry: BackendRegistry;
  archive: Archive;
  config: Config;
  shutdown: () => Promise<void>;
}

const DEFAULT_PORT = 3210;

/**
 * Top-level bootstrap. Loads config, constructs the registry + archive,
 * builds the Express app, starts a server on the requested port (or 3210),
 * begins the periodic probe, and wires SIGINT/SIGTERM to graceful shutdown.
 */
export async function main(opts: MainOptions): Promise<RunningServer> {
  const config = loadConfig(opts.configPath);
  const archive = new Archive(config.archive.dbPath);
  const registry = buildRegistry(config);

  const app = buildApp({ config, registry, archive });
  const port = opts.port ?? DEFAULT_PORT;
  const http = app.listen(port);

  await new Promise<void>((resolve, reject) => {
    http.once("listening", () => resolve());
    http.once("error", reject);
  });

  registry.startPeriodicProbe(config.router.localProbeIntervalMs);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    registry.stop();
    archive.close();
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => resolve(), 5000);
      http.close(() => {
        clearTimeout(force);
        resolve();
      });
    });
  };

  const onSignal = (): void => {
    void shutdown();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  // eslint-disable-next-line no-console
  console.log(`ClaudeMCP listening on http://127.0.0.1:${port}`);
  return { app, http, registry, archive, config, shutdown };
}
```

- [ ] **Step 2: Create `src/bin.ts`**

```ts
#!/usr/bin/env node
import { main } from "./server.js";

function parseArgs(argv: string[]): { configPath: string; port?: number } {
  let configPath: string | undefined;
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      configPath = argv[i + 1];
      i++;
    } else if (arg === "--port") {
      const v = argv[i + 1];
      if (v) port = Number.parseInt(v, 10);
      i++;
    }
  }
  if (!configPath) {
    // eslint-disable-next-line no-console
    console.error("usage: claude-mcp --config <path> [--port <n>]");
    process.exit(2);
  }
  return { configPath, ...(port !== undefined ? { port } : {}) };
}

const opts = parseArgs(process.argv.slice(2));
main(opts).catch((err) => {
  // eslint-disable-next-line no-console
  console.error("ClaudeMCP failed to start:", err);
  process.exit(1);
});
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Clean — no errors.

- [ ] **Step 4: Smoke-test the bootstrap (no test file yet — the integration test in Task 9 covers HTTP behavior)**

Run: `npx tsx src/bin.ts --config configs/default.json --port 13210` in one shell.

Expected stdout: `ClaudeMCP listening on http://127.0.0.1:13210`. Hit Ctrl+C; expected: clean exit within ~5 seconds.

If the default config's `apiKey` is still `"CHANGE-ME-BEFORE-USE"`, the server will start but every request returns 401 until the key is replaced or `CLAUDE_MCP_API_KEY` is set. That's expected behavior for the smoke test.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/bin.ts
git commit -m "feat(server): add Express bootstrap and CLI entry for Anthropic shim"
```

---

## Task 9: Integration test — full HTTP stack against mock-claude

**Files:**
- Create: `tests/integration/messages.test.ts`

Spawn `src/bin.ts` as a subprocess against a temp config that points the Claude backend at the mock-claude fixture. Hit it with supertest. Verify the SSE wire shape and the non-streaming response body. This is the only test in Plan 03 that exercises the binding to a real port + the spawn lifecycle of the runner.

- [ ] **Step 1: Write the test**

Create `tests/integration/messages.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const MOCK_CLAUDE_JS = join(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "mock-claude",
  "index.mjs"
);

interface SpawnedServer {
  proc: ChildProcess;
  port: number;
  workDir: string;
}

function pickPort(): number {
  // Fixed range, avoiding common defaults; integration suite uses one port per
  // test run and the OS reclaims on exit.
  return 13210 + Math.floor(Math.random() * 200);
}

async function waitForReady(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject(new Error(`status ${res.statusCode}`));
        });
        req.on("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server did not become ready on port ${port}`);
}

async function startServer(): Promise<SpawnedServer> {
  const workDir = mkdtempSync(join(tmpdir(), "claudemcp-it-"));
  const dbPath = join(workDir, "archive.sqlite");
  const cfgPath = join(workDir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      apiKey: "sk-integration",
      claude: {
        enabled: true,
        // Run mock-claude as a node script — but bin.ts only accepts a single
        // command string or array. Wrap via the array form.
        command: ["node", MOCK_CLAUDE_JS],
        priority: 100,
        timeoutMs: 10000
      },
      gemini: { enabled: false, command: "gemini" },
      lmstudio: { enabled: false, instances: [] },
      ollama: { enabled: false, useNativeApi: false, instances: [] },
      archive: { dbPath, compressionLevel: 3 }
    })
  );

  const port = pickPort();
  const proc = spawn(
    process.execPath,
    [
      // Run TS source via tsx loader so we don't depend on a build step.
      "--import",
      "tsx",
      join(PROJECT_ROOT, "src", "bin.ts"),
      "--config",
      cfgPath,
      "--port",
      String(port)
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    }
  );

  proc.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
  proc.stderr?.on("data", (d) => process.stderr.write(`[server-err] ${d}`));

  await waitForReady(port);
  return { proc, port, workDir };
}

async function stopServer(s: SpawnedServer): Promise<void> {
  return new Promise((resolve) => {
    s.proc.once("exit", () => {
      rmSync(s.workDir, { recursive: true, force: true });
      resolve();
    });
    s.proc.kill("SIGTERM");
    setTimeout(() => {
      if (!s.proc.killed) s.proc.kill("SIGKILL");
    }, 4000);
  });
}

function postJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.length),
          "x-api-key": "sk-integration",
          ...headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers
          })
        );
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function getJson(
  port: number,
  path: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(
        {
          hostname: "127.0.0.1",
          port,
          path,
          headers: { "x-api-key": "sk-integration" }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8")
            })
          );
        }
      )
      .on("error", reject);
  });
}

describe("Anthropic shim — full HTTP stack against mock-claude", () => {
  let server: SpawnedServer;

  beforeAll(async () => {
    server = await startServer();
  }, 30000);

  afterAll(async () => {
    if (server) await stopServer(server);
  });

  it("POST /v1/messages (non-streaming) returns Anthropic-shaped body", async () => {
    const res = await postJson(server.port, "/v1/messages", {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "integration ping" }]
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as {
      type: string;
      content: { type: string; text: string }[];
      stop_reason: string;
    };
    expect(parsed.type).toBe("message");
    expect(parsed.stop_reason).toBe("end_turn");
    expect(parsed.content[0]?.type).toBe("text");
    expect(parsed.content[0]?.text).toContain("echo:");
  });

  it("POST /v1/messages (streaming) yields the documented event sequence", async () => {
    const res = await postJson(server.port, "/v1/messages", {
      model: "claude-sonnet-4-6",
      stream: true,
      messages: [{ role: "user", content: "stream ping" }]
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const eventNames = res.body
      .split("\n\n")
      .filter((b) => b.startsWith("event: "))
      .map((b) => b.split("\n")[0]?.replace(/^event:\s*/, "") ?? "");
    expect(eventNames[0]).toBe("message_start");
    expect(eventNames[eventNames.length - 1]).toBe("message_stop");
    expect(eventNames).toContain("content_block_start");
    expect(eventNames).toContain("content_block_delta");
    expect(eventNames).toContain("content_block_stop");
    expect(eventNames).toContain("message_delta");
  });

  it("POST /v1/messages/count_tokens returns {input_tokens: <n>}", async () => {
    const res = await postJson(server.port, "/v1/messages/count_tokens", {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello world" }]
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { input_tokens: number };
    expect(typeof parsed.input_tokens).toBe("number");
    expect(parsed.input_tokens).toBeGreaterThan(0);
  });

  it("GET /v1/models lists at least the Claude catalog", async () => {
    const res = await getJson(server.port, "/v1/models");
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as {
      data: { id: string }[];
      has_more: boolean;
    };
    expect(parsed.has_more).toBe(false);
    const ids = parsed.data.map((d) => d.id);
    expect(ids).toContain("claude-opus-4-7");
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("claude-haiku-4-5");
  });

  it("GET /v1/models/{id} returns the matching entry", async () => {
    const res = await getJson(server.port, "/v1/models/claude-sonnet-4-6");
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { id: string; type: string };
    expect(parsed.id).toBe("claude-sonnet-4-6");
    expect(parsed.type).toBe("model");
  });

  it("GET /v1/models/{id} returns 404 on unknown id", async () => {
    const res = await getJson(server.port, "/v1/models/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("POST /v1/messages with no auth returns 401 + Anthropic envelope", async () => {
    const res = await postJson(
      server.port,
      "/v1/messages",
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      },
      { "x-api-key": "" }
    );
    expect(res.status).toBe(401);
    const parsed = JSON.parse(res.body) as {
      type: string;
      error: { type: string };
    };
    expect(parsed.type).toBe("error");
    expect(parsed.error.type).toBe("authentication_error");
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run tests/integration/messages.test.ts`
Expected: PASS — all 7 tests green. Initial run may take a few seconds for the subprocess startup; subsequent runs faster.

- [ ] **Step 3: Run the full suite to confirm no regressions**

Run: `npx vitest run`
Expected: All tests green across unit + integration. Total count = Plan 02's count + new tests added in Plan 03.

- [ ] **Step 4: Run TypeScript typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/messages.test.ts
git commit -m "test(anthropicShim): add full-HTTP-stack integration test against mock-claude"
```

---

## Task 10: Plan-03 close-out documentation

**Files:**
- Create: `docs/plan-03-anthropic-shim-readme.md`

A short README documenting what Plan 03 shipped, which routes are live, what's deferred, and what the next plan needs.

- [ ] **Step 1: Write the document**

```markdown
# Plan 03 — Anthropic Shim Core: what shipped

Plan 03 added the first HTTP surface on top of the Plan-01 foundation and the Plan-02 Claude backend. The server is now reachable on `http://127.0.0.1:3210` (or the `--port` value) and speaks Anthropic's Messages API end-to-end for text-only requests.

## Endpoints live

| Method | Path | Status |
|---|---|---|
| POST | `/v1/messages` | streaming + non-streaming, text-only |
| POST | `/v1/messages/count_tokens` | delegates to `backend.countTokens` |
| GET  | `/v1/models` | cross-backend list, Anthropic envelope |
| GET  | `/v1/models/{id}` | single-entry lookup |
| GET  | `/health` | liveness check |

All endpoints accept `x-api-key`, `Authorization: Bearer`, `x-goog-api-key`, or `?key=` (via the Plan-01 `checkAuth`).

## Modules added

| Path | Purpose |
|---|---|
| `src/server.ts` | Express bootstrap; `main()` and `buildApp()` |
| `src/bin.ts` | CLI entry (`--config <path> [--port <n>]`) |
| `src/anthropicShim/types.ts` | Anthropic Messages API shapes |
| `src/anthropicShim/errors.ts` | Error envelope helpers + `ShimRequestError` |
| `src/anthropicShim/requestTranslator.ts` | Anthropic body → `NormalizedRequest` |
| `src/anthropicShim/responseTranslator.ts` | `NormalizedEvent` → Anthropic SSE / buffered body |
| `src/anthropicShim/messages.ts` | `POST /v1/messages` handler factory |
| `src/anthropicShim/countTokens.ts` | `POST /v1/messages/count_tokens` handler factory |
| `src/anthropicShim/models.ts` | `GET /v1/models` + `GET /v1/models/{id}` handlers |
| `src/tokenEstimator.ts` | Char/4 skeleton |

## Test infrastructure added

| Path | Purpose |
|---|---|
| `tests/unit/tokenEstimator.test.ts` | Char/4 estimator coverage |
| `tests/unit/anthropicShim/errors.test.ts` | Envelope shape parity |
| `tests/unit/anthropicShim/requestTranslator.test.ts` | All request shapes + scope rejections |
| `tests/unit/anthropicShim/responseTranslator.test.ts` | SSE sequence + buffered aggregation |
| `tests/unit/anthropicShim/messages.test.ts` | Handler behavior in isolation |
| `tests/unit/anthropicShim/countTokens.test.ts` | Token counting endpoint |
| `tests/unit/anthropicShim/models.test.ts` | Models listing + get |
| `tests/integration/messages.test.ts` | Full HTTP stack against mock-claude |

Run all: `npm test`.

## Plan-03 scope boundary (what does NOT ship here)

The request translator rejects any of these with a 400 `invalid_request_error`:

- `image` and `document` content blocks (lands in Plan 04)
- `tool_use` and `tool_result` content blocks in the request (Plan 04)
- Non-empty `tools` array (Plan 04)
- `tool_choice` field (Plan 04)
- Non-empty `stop_sequences` (Plan 04)
- `thinking` field (Plan 04)
- `cache_control` on any block (Plan 05)

Server-internal deferrals:

- The `Archive` is opened on startup but never written to (Plan 05 wires the writers in).
- No response cache (Plan 05).
- No Files API (Plan 05).
- No admin endpoints (Plan 11).
- Other shims — the OpenAI surface stays on the legacy `dist/` server for now; Gemini shim lands in Plan 06.

## What the next plan (Plan 04 — Native tool_use + multimodal) needs

- Extend `ClaudeBackend.invoke()` to forward `tools`, `tool_choice`, image/document blocks, and `stop_sequences` to the CLI.
- Extend the request translator to accept image/document/tool_use/tool_result blocks instead of rejecting them.
- Extend the response translator to emit `content_block_start/delta/stop` for `tool_use` blocks (with `input_json_delta` deltas).
- Add a `stop_sequence` server-side cut in the Claude runner (rolling-tail buffer + `tree-kill`).
- Add tests for each new content-block shape across both streaming and non-streaming paths.

## Operational notes

- Default port is 3210.
- `CLAUDE_MCP_API_KEY` env var overrides the config's `apiKey` (per Plan 01's `loadConfig`).
- The mock-claude fixture from Plan 02 is the only test backend; Plan 04 can keep using it once it learns to emit tool_use blocks.
```

- [ ] **Step 2: Commit**

```bash
git add docs/plan-03-anthropic-shim-readme.md
git commit -m "docs: add Plan 03 close-out README documenting Anthropic shim scope"
```

---

## Plan 03 — Self-review checklist

Before declaring Plan 03 done, run through this checklist:

- [ ] `npm test` — all tests green, no skips. Expect Plan 02's count + ~75 new tests added here (5 errors + 10 estimator + 21 requestTranslator + 16 responseTranslator + 12 messages + 5 countTokens + 9 models + 7 integration ≈ 85 new).
- [ ] `npx tsc --noEmit` — no type errors.
- [ ] `git status` — clean tree, all changes committed (except pre-existing untracked files like `scripts/configure-agent-zero.sh`).
- [ ] `git log --oneline -15` — commits read sensibly: errors+types, tokenEstimator, requestTranslator, responseTranslator, messages handler, countTokens handler, models handlers, server bootstrap, integration test, README.
- [ ] `src/anthropicShim/` contains exactly 7 files: `types.ts`, `errors.ts`, `requestTranslator.ts`, `responseTranslator.ts`, `messages.ts`, `countTokens.ts`, `models.ts`.
- [ ] `src/server.ts` and `src/bin.ts` exist; `src/bin.ts` has a shebang and exits with code 2 on missing `--config`.
- [ ] Every `src/*` import in this plan uses an explicit `.js` extension (NodeNext).
- [ ] No handler factory reads from module-scoped state — every dep arrives through the factory args.
- [ ] Anthropic SSE chunks emitted by `responseTranslator` start with `event: ` and end with `\n\n` (verified by tests in Task 4).
- [ ] `count_tokens` returns exactly `{input_tokens: <n>}` — no extra fields (verified in Task 6).
- [ ] `/v1/models` returns exactly `{data, has_more, first_id, last_id}` with `has_more: false` (verified in Task 7).
- [ ] Auth failures return the Anthropic-shaped 401 envelope; bad requests return 400; not-found returns 404; backend errors return 500 — all with the `{type: "error", error: {type, message}}` shape.
- [ ] The integration test in Task 9 successfully spawns the server via `tsx`, hits real HTTP, and tears down cleanly.
- [ ] No source file under `src/` exceeds 300 lines (`server.ts` and `messages.ts` are the largest; both should stay under 250).
- [ ] `Archive` is still untouched by writers — `grep -r "archive\." src/anthropicShim/` should return zero hits.

If all check, Plan 03 is shipped. Open a PR to main (or merge directly following the project's docs-only commit pattern); Plan 04 follows.

---

## Open questions

These deserve attention from a human reviewer before or during Plan 03 execution, and may shift later plans:

1. **Anthropic API version header.** The spec mentions Anthropic's `anthropic-version` header in passing but doesn't pin a target version. The handlers in this plan ignore the header entirely (accept any value, including absent). Anthropic's SDK sends `anthropic-version: 2023-06-01` by default; verify this is acceptable behavior or add a validator in Plan 04.

2. **Streaming error envelope.** When `backend.invoke()` throws *after* the SSE headers have flushed (e.g., the CLI dies mid-stream), Plan 03 just calls `res.end()` and leaves the client guessing. Anthropic's published SSE format includes an `error` event type; consider whether Plan 04 should emit `event: error\ndata: {...}\n\n` before closing.

3. **`/v1/models` `display_name`.** Plan 03 uses `ModelDescriptor.description` as the `display_name`. Anthropic's API returns human-readable names like `"Claude Sonnet 4.6"`. The `ClaudeBackend` catalog in Plan 02 doesn't surface display names. Decide whether to extend `ModelDescriptor` with a `displayName` field (preferred) or live with the description-as-display-name shortcut.

4. **`created_at` placeholder.** Every model entry currently reports `2026-01-01T00:00:00Z`. Real release dates land when the model catalog grows admin endpoints in Plan 09 — confirm that's the right home.

5. **Subprocess-based integration test on Windows.** The integration test in Task 9 spawns Node with `--import tsx`. On Windows, `cross-spawn` shell semantics differ — verify the integration test reliably starts the subprocess in Windows CI before declaring the plan green. If it's flaky, fall back to importing `buildApp` directly from `src/server.ts` (skip the subprocess) and accept losing the bin.ts surface coverage there.

6. **JSON body size limit.** Plan 03 sets `express.json({ limit: "32mb" })`. The spec's response cache and files API care about request size; revisit this when Plan 05 lands.

7. **Concurrency under load.** `BackendRegistry.probe()` runs every `localProbeIntervalMs` ms. Plan 03 hasn't measured contention between in-flight `/v1/messages` requests and an active probe. Likely fine because `Backend.listModels()` and `Backend.invoke()` are independent, but Plan 11 (admin/observability) should add a metric to verify.
