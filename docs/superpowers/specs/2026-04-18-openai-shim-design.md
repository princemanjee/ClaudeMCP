# OpenAI-Compatible Shim — Design Spec

**Date:** 2026-04-18
**Status:** Approved for implementation planning
**Owner:** Prince Rehman Manjee
**Builds on:** `docs/superpowers/specs/2026-04-18-claude-mcp-design.md`

## Problem

The ClaudeMCP server currently exposes Claude Code to Agent Zero as two MCP tools (`claude_ask`, `claude_task`). That lets Agent Zero *call* Claude for specialized subtasks, but its planning loop still needs a separate LLM (OpenAI, Ollama, paid Anthropic API, etc.) as its primary reasoning model.

The user wants to use the Claude Max subscription as Agent Zero's brain too — i.e., replace Agent Zero's LLM provider with Claude Code CLI. Agent Zero speaks OpenAI's `POST /v1/chat/completions` protocol (via LiteLLM) and expects `tool_use` responses for its agent loop. Claude Code's headless mode doesn't natively emit caller-addressable tool calls, so we build a translation layer: prompt Claude to emit `<tool_use>` tags, parse them back into OpenAI `tool_calls` format.

## Goals

- Expose `POST /v1/chat/completions` on the existing ClaudeMCP server so Agent Zero (configured with "custom OpenAI endpoint" + base URL + dummy API key) can use Claude Code as its reasoning model.
- Support streaming via OpenAI's SSE chunk format (`stream: true`).
- Support OpenAI-style tool calling (single and parallel) by prompt-engineering Claude to emit `<tool_use>` tags.
- Reuse the existing session store to resume Claude sessions across turns, avoiding full-history re-processing on every call.
- Graceful defensive fallback when Claude's output doesn't match the XML convention (degraded but non-catastrophic).

## Non-goals

- Token-level accuracy of OpenAI chunks. Our "streaming" granularity is whatever Claude Code's stream-json emits, which is semantic (messages) rather than per-token.
- Vision / image inputs, file attachments, computer-use, or any multimodal feature — Claude Code headless doesn't surface these.
- Honoring `temperature`, `top_p`, `max_tokens`, or `model` from the OpenAI request — Claude Code doesn't accept them via headless. We log the requested values and ignore.
- Token usage reporting (Claude Code doesn't expose it in headless mode).
- Multi-tenancy. Single-user, localhost-bound, same as the rest of ClaudeMCP.

## Constraints and assumptions

- The caller is Agent Zero (or equivalently, any LiteLLM client speaking OpenAI-compatible protocol). We don't attempt to match OpenAI's behavior exactly beyond what Agent Zero needs.
- Claude Code CLI is installed, authenticated against Claude Max, and supports `--output-format stream-json`, `--resume`, and `--system`.
- The existing MCP path (`/sse`, `/message`, `claude_ask`, `claude_task`) is unaffected. This feature is strictly additive.
- Reliability depends on Claude following the `<tool_use>` format. This is prompt-engineered, not protocol-enforced; fragility is acknowledged.

## Architecture

The shim is an additive subsystem under `src/openaiShim/`. The only cross-cutting change is a new method on `SessionStore` to look up sessions by an external hash key. Everything MCP-related stays untouched.

```
src/
├── openaiShim/
│   ├── handler.ts          # POST /v1/chat/completions Express handler
│   ├── promptBuilder.ts    # OpenAI messages + tools -> Claude prompt
│   ├── responseParser.ts   # Claude output (non-streaming) -> OpenAI content | tool_calls
│   ├── streamTranslator.ts # Claude stream-json events -> OpenAI SSE chunks, with mode classification
│   └── types.ts            # OpenAI request/response shapes
├── claudeStreamRunner.ts   # NEW: streaming version of runClaude, async-iterable over stream-json events
├── claudeRunner.ts         # UNCHANGED: buffered runner used by MCP tools
├── sessionStore.ts         # MODIFIED: add externalKey field and findByExternalKey method
├── types.ts                # MODIFIED: add externalKey?: string to SessionMeta; add "openai_completion" to LogEntry.tool; add openaiMode/toolCallsEmitted/externalKey fields to LogEntry
├── server.ts               # MODIFIED: mount POST /v1/chat/completions on Express app
└── config.ts               # MODIFIED: add optional openai config block
```

**Isolation principles preserved:**

- `claudeStreamRunner.ts` is the only new file that shells out to `claude -p --output-format stream-json`. The existing `claudeRunner.ts` (used by the MCP tools) is unchanged.
- Everything OpenAI-protocol-specific lives under `src/openaiShim/`. Deleting that folder + 1 import + 1 route in `server.ts` fully removes the feature.
- No changes to `src/tools/` — the MCP path is untouched.

## Request handling flow

For each `POST /v1/chat/completions`:

1. **Optional auth check.** If `config.openai.requireAuthHeader` is configured (e.g., `"Bearer dummy-key"`), validate the `Authorization` header matches. Default: ignore any header that's provided.
2. **Parse OpenAI request.** Extract `messages`, `tools`, `stream`, `tool_choice`. Ignore `model`, `temperature`, `max_tokens`, `top_p`; log them.
3. **Compute external key.** Scan `messages` backwards for the last `role === "assistant"` entry. Hash its `content` + `tool_calls` with SHA-256 over canonical JSON (sorted keys). If no assistant message exists (first turn), external key is `null`.
4. **Resolve session.**
   - Key null → fresh Claude session (no `--resume`).
   - Key non-null and `sessionStore.findByExternalKey(key)` returns an entry → resume with `--resume <claudeSessionId>`.
   - Key non-null but not found in store → fresh session (log a "session miss" warning).
5. **Build Claude prompt** per Section "Prompt template" below. Fresh calls include full history; resume calls include only messages after the last assistant turn.
6. **Spawn Claude via `claudeStreamRunner`.** Flags:
   - `--allowed-tools ""` — Claude must NOT use its own tools; its only job is to reason and emit `<tool_use>` requests for the caller.
   - `--output-format stream-json`
   - `--resume <sid>` when applicable
   - `--system "<system-prompt>"` on fresh calls only (resume inherits the system prompt from the prior session)
   - `cwd` set to the session's `workDir` on resume, or `config.task.defaultWorkDir` on fresh (reusing the task-side default is intentional — a reasoning engine doesn't actually use its cwd since `--allowed-tools ""` disables file tools, but claude still requires a valid cwd)
   - Timeout from `config.openai.timeoutMs` (default 120000 ms)
7. **Process stream events** through the translator (see Section "Streaming translation"). On `stream: true`, pipe chunks to the response as SSE. On `stream: false`, accumulate into a single `chat.completion` body.
8. **On completion:**
   - Capture `session_id` from Claude's initial `system/init` stream event.
   - Fresh session: store `{externalKey: hash(ourReply), sessionId: <claude-session-id>, workDir, createdAt, lastUsedAt, turnCount: 0}` via a new `sessionStore.createWithExternalKey(...)`.
   - Resumed session: `sessionStore.update(sessionId)` to bump `lastUsedAt` and `turnCount`, AND update the `externalKey` mapping to point to this turn's hash.
   - Emit one log entry with `tool: "openai_completion"`, including Claude's session ID, whether this was `fresh` or `resumed`, and the full translated response for debugging.

## Session heuristic

**External key = SHA-256(canonicalJSON({content: assistant.content, tool_calls: assistant.tool_calls}))** of the last `role === "assistant"` message in the request's `messages[]`. Canonical JSON sorts keys and uses no extra whitespace.

**First call:** no assistant message → key is null → fresh session. After completion, hash OUR reply and store the mapping `externalKey → claudeSessionId`.

**Subsequent call:** find the last assistant message, compute its hash, look up in `sessionStore`. Hit → resume. Miss → fresh.

**History rewrite / summarization** (Agent Zero sometimes truncates history mid-conversation): the last assistant message changes → hash mismatches → we start a fresh Claude session. Inefficient but correct; we avoid silently threading two conversations together.

**Branching** (user edits and retries): new reply → new hash → new session. Parallel branches run independently.

**Collision risk:** two different conversations producing byte-identical assistant messages is theoretically possible. On collision, both external keys map to the same Claude session — Claude would see interleaved turns from different conversations. In practice, Claude's replies are long enough and stochastic enough that collision probability is effectively zero.

## SessionStore extension

Add to `SessionMeta`:

```ts
type SessionMeta = {
  sessionId: string;
  workDir: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
  externalKey?: string; // NEW — optional; set by the OpenAI shim
};
```

Add methods to `SessionStore`:

- `findByExternalKey(key: string): SessionMeta | null` — O(1) via a shadow `Map<externalKey, sessionId>` index.
- `createWithExternalKey(sessionId, workDir, externalKey): Promise<SessionMeta>` — creates an entry with the external key set.
- `setExternalKey(sessionId, externalKey): Promise<void>` — update the external key on an existing session (used on resume to re-point the mapping to the current turn's hash).

The shadow index is built on `load()` by scanning all entries for `externalKey`. It's updated on every mutation that touches `externalKey`. Eviction (TTL) removes from both the main map and the shadow index.

## Prompt template

**System prompt (set via `--system` on fresh calls only):**

```
You are a reasoning engine. A separate agent-orchestration system ("the harness") has delegated decision-making to you. You have NO direct access to files, shell, or the internet. The harness executes tools on your behalf.

[Caller's system message, if any]:
<<<
{messages[0].content when role === "system"}
>>>

AVAILABLE TOOLS:
{foreach tool in tools[]:
  - name: {tool.function.name}
    description: {tool.function.description}
    parameters (JSON Schema): {JSON.stringify(tool.function.parameters)}
}

RESPONSE FORMAT — STRICT:

Your response must be EITHER:

(A) One or more tool requests, each wrapped exactly like this:
<tool_use>
{"name": "tool_name_here", "arguments": {...}}
</tool_use>

For multiple tools in parallel, emit multiple <tool_use> blocks back-to-back with no text between them. The arguments object must be valid JSON matching the tool's parameter schema.

(B) A final plain-text answer to the user's request. No tags, no JSON wrapper, no code fences.

NEVER mix modes in one response. NEVER add commentary before or after <tool_use> blocks. NEVER use any tool not in the list above.

Examples:

  Good — tool request:
<tool_use>
{"name": "search", "arguments": {"query": "claude code pricing"}}
</tool_use>

  Good — parallel tool requests:
<tool_use>
{"name": "search", "arguments": {"query": "weather Paris"}}
</tool_use>
<tool_use>
{"name": "search", "arguments": {"query": "weather London"}}
</tool_use>

  Good — final answer:
The current Claude Max plan is $200/month.

  Bad — do not do this:
Here's what I found: <tool_use>...</tool_use> Let me know if you need more.
```

**Fresh-call user prompt** (the `-p` argument): serialize conversation history after the system message as a tagged transcript. Each message type has a distinct tag:

```
<user>{content}</user>
<assistant>{content}</assistant>
<assistant_tool_use>
<tool_use>{JSON of tool_calls[0]}</tool_use>
<tool_use>{JSON of tool_calls[1]}</tool_use>
</assistant_tool_use>
<tool_result id="{tool_call_id}">{content}</tool_result>

Produce your next response.
```

**Resume-call user prompt**: Claude already has prior context via `--resume`. Send only new messages (those after the last `role === "assistant"` in the request):

```
<tool_result id="{tool_call_id}">{content}</tool_result>
<user>{content}</user>

Produce your next response.
```

## Streaming translation

Claude Code's `--output-format stream-json` emits newline-delimited JSON. We consume events of these types:

- `{type: "system", subtype: "init", session_id, ...}` — captured for session-store writes.
- `{type: "assistant", message: {content: [{type: "text", text: "..."}]}}` — the text stream.
- `{type: "result", subtype: "success" | "error", ...}` — terminal event.

**Mode-classification state machine** (reset per completion):

| State | On new text event | Transition |
|---|---|---|
| `UNKNOWN` | Append to rolling buffer; strip leading whitespace for the check. | If buffer (stripped) starts with `<tool_use>` → `TOOL_BUFFERING` with buffer shifted past opening tag. If buffer has ≥10 non-whitespace chars and doesn't match → `ANSWER` (flush buffer as content delta). Otherwise stay `UNKNOWN`. |
| `ANSWER` | Emit as OpenAI `content` delta. | Stays until `result` event. |
| `TOOL_BUFFERING` | Append to buffer. | If buffer contains `</tool_use>`: parse JSON between tags using brace-balancing, validate `{name: string, arguments: object}`, emit one `tool_calls` delta with `id: "call_<uuid>"`, then → `POST_TOOL` with remaining buffer. |
| `POST_TOOL` | Scan buffer for next `<tool_use>` or `result`. | Next `<tool_use>` → back to `TOOL_BUFFERING` with `tool_calls.index` incremented. Trailing text is discarded. |

**Threshold of 10 non-whitespace chars** is safe because `<tool_use>` is exactly 10 chars; no false positives.

**Emitted chunks** (OpenAI `chat.completion.chunk` shape):

- Stream opens with a `delta: {role: "assistant"}` chunk.
- `ANSWER` mode: `delta: {content: "<text>"}` chunks as text events arrive, then terminal `delta: {}, finish_reason: "stop"`.
- `TOOL_BUFFERING` completion: single chunk with `delta: {tool_calls: [{index, id, type: "function", function: {name, arguments}}]}`. Arguments are emitted as a single complete JSON string (not streamed char-by-char). Terminal `finish_reason: "tool_calls"`.
- Stream closes with `data: [DONE]\n\n` per OpenAI convention.

**Non-streaming (`stream: false`)** uses the same state machine but accumulates output into a single `chat.completion` body. Tool calls collected into `choices[0].message.tool_calls`; text into `choices[0].message.content`. `choices[0].finish_reason` reflects `stop` or `tool_calls`.

## Parsing (non-streaming path)

`responseParser.ts` is used on the buffered `stream: false` path and also for any fallback logic:

1. Strip leading whitespace.
2. If next chars are `<tool_use>`: enter extraction mode. Repeatedly find `<tool_use>...</tool_use>` blocks with brace-balanced JSON parsing. For each: `JSON.parse`, validate that `name` is a non-empty string. `arguments` defaults to `{}` if omitted. Emit as a tool call with generated `call_<uuid>` id.
3. If any block fails to parse as JSON: log the malformed block, skip it, continue. If ALL blocks fail, fall through to (4).
4. Otherwise: treat entire output (stripped) as plain-text content.

## Error handling

| Category | Trigger | Response |
|---|---|---|
| Auth failure (if configured) | Missing/invalid `Authorization` header | HTTP 401 with OpenAI-style error body `{error: {message, type: "authentication_error", code: "invalid_api_key"}}` |
| Claude spawn failure | CLI not found | HTTP 500, error body `{error: {message, type: "api_error"}}` |
| Claude non-zero exit | Real errors from Claude | HTTP 502, error body includes stderr in `error.message` |
| Timeout | Exceeds `config.openai.timeoutMs` | HTTP 504, error body `{error: {message: "Claude timed out after {N}ms", type: "timeout"}}` |
| Malformed XML | Parser cannot find `</tool_use>` closing tag, or all JSON parses fail | Graceful fallback: return the raw text as `content`. This is a degraded result, not an error. Log it so we can improve the prompt. |

No automatic retries. The OpenAI client (Agent Zero) handles retry logic on its side.

## Config schema additions

New optional block in `configs/default.json`:

```jsonc
{
  // ...existing fields...
  "openai": {
    "enabled": true,
    "requireAuthHeader": null,
    "timeoutMs": 120000
  }
}
```

- `enabled`: if false, the handler is not mounted (feature-flag for rollback).
- `requireAuthHeader`: if a string is set, requests must send matching `Authorization` header. If null, auth is ignored.
- `timeoutMs`: per-request timeout (separate from `ask` and `task` timeouts).

Environment overrides: `CLAUDE_MCP_OPENAI_ENABLED` (boolean), `CLAUDE_MCP_OPENAI_AUTH_HEADER` (string), `CLAUDE_MCP_OPENAI_TIMEOUT_MS` (number).

## Logging

Extend `LogEntry.tool` union to include `"openai_completion"`. Log entries for the shim include:

- Existing fields: `timestamp`, `logId`, `durationMs`, `prompt`, `output`, `containsQuestion`, `exitCode`, `sessionId`, `status`, etc.
- New fields:
  - `openaiMode: "fresh" | "resumed" | "session-miss"` — how the session was resolved
  - `toolCallsEmitted: number` — count of tool calls in the response (0 for pure text)
  - `externalKey?: string` — the hash used for session lookup (first 16 chars for readability)
- `workDir`, `sessionMode`, `allowedTools` are omitted (not meaningful for this tool type).

## Testing

Vitest. Hermetic; no real Claude calls.

**Unit tests** (all pure functions / state machine):

- `promptBuilder.test.ts` — fresh with/without tools, fresh with assistant+tool_result history, resume with new messages only, empty messages, edge cases.
- `responseParser.test.ts` — plain text, single tool_use, parallel tool_use, leading whitespace, malformed JSON (fallback), unclosed tag (fallback), mixed prose + tool_use (fallback), code-fenced JSON (fallback), nested braces in arguments.
- `streamTranslator.test.ts` — state machine with synthetic event sequences: answer-only, single tool call, parallel calls, delayed classification (`<` in first short event), 10-char threshold transition, empty result event, malformed stream-json lines (skip and continue).
- `externalKey.test.ts` — hash stability, whitespace-only diff produces different hash, tool_calls reorder produces different hash.
- `sessionStore-externalKey.test.ts` — findByExternalKey hits/misses, shadow index rebuild on load, TTL eviction clears shadow index entries, re-assigning externalKey on resume overwrites old mapping.

**Integration tests** (extend `tests/integration.test.ts` suite or a new `tests/openai-integration.test.ts`):

- Extend `tests/fixtures/mock-claude.mjs` with scenarios:
  - `openai-answer` — emits stream-json events producing plain text
  - `openai-tool-call` — emits events producing a single `<tool_use>` block
  - `openai-parallel` — emits events producing two back-to-back `<tool_use>` blocks
- Tests:
  - `POST /v1/chat/completions` with `stream: false` → returns `chat.completion` body with `content`
  - `POST /v1/chat/completions` with `stream: true` → valid SSE with `role` chunk, `content` chunks, final chunk with `finish_reason: "stop"`, then `[DONE]`
  - Tool-call path: request includes `tools`, scenario `openai-tool-call` → response has `tool_calls[0].function.{name, arguments}` and `finish_reason: "tool_calls"`
  - Parallel: scenario `openai-parallel` → `tool_calls` array has 2 entries with correct `index` values
  - Session continuity: turn 1 builds session, turn 2 carries assistant reply in `messages`, mock verifies `--resume <sid>` in argv (captured via the mock)
  - Session miss: turn 2 with mutated assistant content → mock is invoked without `--resume`
  - Malformed output: scenario emits `<tool_use` without closing → response falls back to text content
  - Error propagation: scenario `nonzero` → response is OpenAI-style error body with HTTP 5xx

**Coverage target:** ~80% lines in `src/openaiShim/`. State machine and pure parsers should trend higher.

**Explicit testing gap:** We cannot hermetically test Claude's actual adherence to the `<tool_use>` convention. That's the largest real-world risk. Defensive parsing (graceful text fallback on any format break) and manual smoke-testing (extend `docs/smoke-test.md` with an OpenAI-client example) bound the damage.

## Open questions / future work

- **Token usage reporting.** Claude Code stream-json may include cost metadata in the `result` event. Worth surfacing as `usage: {prompt_tokens, completion_tokens, total_tokens}` in the OpenAI response if the data is available, even if approximate.
- **Prompt-format drift.** If Claude's adherence to the `<tool_use>` convention is poor in practice, try Anthropic-style nested prompting or few-shot examples drawn from real Agent Zero tool schemas.
- **Multi-client concurrency.** Current design assumes a single Agent Zero instance. Concurrent OpenAI clients on different sessions work fine, but concurrent callers on the SAME session (same `externalKey`) serialize through the existing per-session mutex — likely but untested.
- **`temperature` / `max_tokens` support.** If Claude Code ever exposes these via CLI flags, wire them through. Currently silently ignored.
- **Streaming tool-call arguments.** Real OpenAI streams tool argument JSON character-by-character. We emit the full `arguments` string in one chunk. Agent Zero tolerates this; other clients may not.
