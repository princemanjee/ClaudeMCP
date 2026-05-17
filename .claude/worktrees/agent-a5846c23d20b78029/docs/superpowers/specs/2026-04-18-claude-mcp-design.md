# ClaudeMCP — Design Spec

**Date:** 2026-04-18
**Status:** Approved for implementation planning
**Owner:** Prince Rehman Manjee

## Problem

The user pays $200/month for Claude Max, which includes Claude Code CLI access. Using Claude from other agentic tools (primarily Agent Zero) currently requires a separate paid Anthropic API key, effectively double-charging. Claude Code's headless mode (`claude -p`) already reuses the Max-subscription auth stored by the CLI, so wrapping it as an MCP server exposes that capability to external tools without additional API spend.

## Goals

- Expose Claude Code as an MCP server that Agent Zero (or any MCP-speaking client) can call.
- Reuse the existing Claude Max subscription auth via the installed `claude` CLI — no separate API key.
- Offer two distinct capabilities: a stateless "smart LLM" endpoint and a stateful "sub-agent" endpoint.
- Support conversation continuity across multiple calls via explicit session IDs.
- Structured JSON-lines logging for observability and reply tracking.
- Personal/local use only. Localhost-bound. No multi-user concerns.

## Non-goals

- Redistributing Claude Max access to third parties or exposing the server to the public internet.
- Replicating the full Claude Code interactive TUI (permission prompts, chat history UI, etc.).
- Multi-user auth, quotas, or rate limiting.
- Log rotation (delegated to external tools like `logrotate`).
- Backwards compatibility with any existing client — this is a greenfield project.

## Constraints and assumptions

- Host OS is Windows 11. Claude CLI is installed on PATH and authenticated against a Max subscription.
- Agent Zero typically runs in a Docker container; the MCP server runs on the Windows host. Transport therefore needs to be networked, not stdio.
- Node.js 20+ and TypeScript are the runtime. `@modelcontextprotocol/sdk` is the MCP implementation.
- The user has chosen `--dangerously-skip-permissions` as the shipped default. They accept the blast radius on their own machine.

## Architecture

Single Node.js/TypeScript process. Express HTTP server. MCP-over-SSE transport. Two MCP tools registered. One shared Claude CLI invoker, one JSON-lines logger, one config loader, one file-backed session store.

```
ClaudeMCP/
├── src/
│   ├── server.ts           # entry point: loads config, starts Express + MCP
│   ├── config.ts           # loads and validates config.json via Zod
│   ├── logger.ts           # JSON-lines async logger with write queue
│   ├── claudeRunner.ts     # the only module that spawns `claude`
│   ├── sessionStore.ts     # file-backed Map of sessionId -> metadata
│   └── tools/
│       ├── claudeAsk.ts    # registers claude_ask tool
│       └── claudeTask.ts   # registers claude_task tool
├── configs/
│   ├── default.json        # shipped default config
│   └── example.json        # commented example with every knob
├── data/
│   └── sessions.json       # file-backed session store (gitignored)
├── logs/                   # gitignored; created on first run
├── tests/
│   ├── claudeRunner.test.ts
│   ├── sessionStore.test.ts
│   ├── config.test.ts
│   ├── logger.test.ts
│   └── integration.test.ts # end-to-end with mock `claude` binary on PATH
├── docs/
│   ├── smoke-test.md
│   └── superpowers/specs/2026-04-18-claude-mcp-design.md
├── package.json
├── tsconfig.json
└── README.md
```

**Isolation rule:** `claudeRunner.ts` is the only module that touches the `claude` CLI. If Claude Code changes its CLI flags or output format, that is the single file to edit.

## MCP tools

### `claude_ask` — stateless, no tools

Purpose: Treat Claude as a fast, sandboxed chat-completion endpoint. No file access, no shell, no session memory.

**Input schema:**
```ts
{
  prompt: string,
  inReplyToLogId?: string   // optional; set when this call answers a prior Claude question
}
```

**Output:**
```ts
{
  content: [{ type: "text", text: string }],
  isError?: boolean,
  _meta: {
    logId: string,
    durationMs: number
  }
}
```

**CLI invocation:**
```
claude -p "<prompt>" --output-format json --allowed-tools ""
```

Timeout: `config.ask.timeoutMs` (default 60000 ms). Runs in the server's CWD but cannot touch it because `--allowed-tools ""` disables all tools.

### `claude_task` — stateful, full capability

Purpose: Delegate a real task to Claude Code acting as a sub-agent inside a working directory with full tool access.

**Input schema:**
```ts
{
  prompt: string,
  workDir?: string,                                          // overrides config default
  sessionMode?: "stateless" | "session" | "auto-last",       // overrides config default
  sessionId?: string,                                        // required to resume when sessionMode === "session"
  allowedTools?: string,                                     // overrides config default
  inReplyToLogId?: string                                    // optional; set when this call answers a prior Claude question
}
```

**Output:**
```ts
{
  content: [{ type: "text", text: string }],
  isError?: boolean,
  _meta: {
    sessionId: string | null,    // null for sessionMode === "stateless"; otherwise new or resumed ID
    mode: "stateless" | "fresh" | "resumed",
    durationMs: number,
    exitCode: number,
    logId: string
  }
}
```

**CLI invocation by sessionMode:**

| Mode | Fresh call | Continuation |
|---|---|---|
| `stateless` | `claude -p "<prompt>" --output-format json <permission-flag>` | N/A — no continuation |
| `session` (no `sessionId`) | Same as `stateless`, but capture new session ID from JSON output and persist to store | N/A |
| `session` (with `sessionId`) | N/A | `claude --resume <id> -p "<prompt>" --output-format json <permission-flag>` |
| `auto-last` | If store has a most-recent session, resume it; else start fresh | Always resumes most-recent |

**Permission-flag precedence:** If `config.task.dangerouslySkipPermissions === true`, pass `--dangerously-skip-permissions` and omit `--allowed-tools`. Otherwise pass `--allowed-tools "<csv>"` built from (input `allowedTools` ?? `config.task.allowedTools`). Passing both `dangerouslySkipPermissions: true` and a non-empty `allowedTools` input logs a warning ("allowedTools ignored because dangerouslySkipPermissions is true") and the skip flag wins.

**Unused-field rules:**
- `sessionId` supplied with `sessionMode: "stateless"` or `"auto-last"`: ignored, warning logged.
- `sessionId` omitted with `sessionMode: "session"` on a continuation intent: the server has no way to know it's a continuation; it starts a fresh session and returns the new ID. Caller should treat every `session`-mode call without `sessionId` as a fresh start.

Timeout: `config.task.timeoutMs` (default 600000 ms / 10 min).

## Session management

### Store shape

In-memory `Map<string, SessionMeta>` backed by a single JSON file at `config.sessionStoreFile` (default `data/sessions.json`).

```ts
type SessionMeta = {
  sessionId: string,
  workDir: string,
  createdAt: string,    // ISO timestamp
  lastUsedAt: string,   // ISO timestamp
  turnCount: number
}
```

### Persistence

- Read once on startup into the Map.
- Every mutation atomically rewrites the file: write to `sessions.json.tmp`, fsync, rename over `sessions.json`.
- Corrupted file on load logs a warning and starts fresh (does not crash).
- No migrations; schema changes require manual deletion of the file.

### Mode semantics

- **`stateless`** bypasses the store entirely. No reads, no writes.
- **`session`** with no `sessionId`: parse the session ID from Claude's JSON output, create a new entry.
- **`session`** with `sessionId`: warn in logs if the ID is unknown to the store (Claude may still know it), pass `--resume <id>` regardless since Claude's own storage is authoritative. Update `lastUsedAt` and `turnCount` after the call.
- **`auto-last`**: pick the entry with the most recent `lastUsedAt`. If store is empty, start fresh.

### Concurrency

Different sessions run fully in parallel. Same-session concurrent calls are serialized through a `Map<sessionId, Promise>` mutex so resumed calls don't race.

`auto-last` is documented as intended for sequential callers — concurrent `auto-last` calls will produce first-to-lock-wins ordering.

### TTL / eviction

Background timer every 5 minutes evicts entries whose `lastUsedAt` is older than `config.task.sessionTtlMs` (default 24 hours).

## Config

### Loading

1. CLI: `node dist/server.js --config <path>` (default `configs/default.json`).
2. Parse JSON, validate against Zod schema.
3. Apply defaults for missing fields.
4. Overlay env vars (e.g., `CLAUDE_MCP_PORT` overrides `port`).
5. Freeze. Fail fast with a clear error on validation failure; do not start the server.

### Schema

```jsonc
{
  "port": 3000,
  "host": "127.0.0.1",
  "logFile": "logs/activity.log",
  "sessionStoreFile": "data/sessions.json",
  "ask": {
    "timeoutMs": 60000,
    "allowedTools": ""
  },
  "task": {
    "defaultSessionMode": "session",
    "defaultWorkDir": "C:/Code/scratch",
    "timeoutMs": 600000,
    "allowedTools": "Read,Edit,Write,Bash,Glob,Grep",
    "dangerouslySkipPermissions": true,
    "sessionTtlMs": 86400000
  }
}
```

Shipped `default.json` uses these values. `example.json` mirrors the schema with a sibling `_comments` block documenting each knob (JSON has no native comments).

## Logging

### Format

JSON-lines appended to `config.logFile`. One line per tool call.

```json
{
  "timestamp": "2026-04-18T15:42:01.234Z",
  "logId": "<uuid-v4>",
  "inReplyToLogId": "<uuid-v4>",
  "tool": "claude_ask" | "claude_task",
  "status": "success" | "error" | "timeout",
  "durationMs": 12345,
  "sessionId": "...",
  "prompt": "...",
  "workDir": "...",
  "allowedTools": "...",
  "sessionMode": "session",
  "output": "...",
  "containsQuestion": true,
  "exitCode": 0,
  "error": "..."
}
```

Fields omitted when not applicable: `sessionId`, `workDir`, `allowedTools`, `sessionMode` are omitted for `claude_ask` entries; `error` is omitted on success; `inReplyToLogId` is omitted when not supplied.

### Reply tracking

- `inReplyToLogId`: supplied by the caller (Agent Zero) when its call is a response to a question in a prior tool output. Persisted verbatim.
- `containsQuestion`: auto-computed from the tool output using a simple heuristic — trimmed output ends with `?`, or contains one of the phrases `which do you`, `should I`, `do you want`, `please clarify`, `can you tell me`. Case-insensitive. Best-effort flag for later human review; not authoritative.

A linked conversation can be reconstructed by joining entries on `inReplyToLogId -> logId`.

### Truncation and concurrency

- `output` truncated to 10 KB at a UTF-8 character boundary (full output stays in Claude's own session storage). Truncated entries set `outputTruncated: true` on the log record.
- Writes go through an async queue so concurrent calls don't interleave bytes.
- Log rotation is out of scope; use an external tool.

### Log ID exposure

The `logId` is included in every MCP response `_meta` so Agent Zero can correlate a response with its log entry and supply `inReplyToLogId` on follow-up calls.

## Error handling

All failures log the full context and return `isError: true` to the MCP client. No automatic retries — Claude calls are often non-idempotent (file edits).

| Category | Trigger | Response |
|---|---|---|
| Spawn failure | `claude` not on PATH, not executable | `isError: true`, exit code `-1`, human-readable stderr message |
| Non-zero exit | Claude itself errors | `isError: true`, include stderr content |
| Timeout | Runtime exceeds `timeoutMs` | `isError: true`, `status: "timeout"`, kill process tree via `tree-kill` (Windows-reliable), return partial stdout |

## Transport and server lifecycle

- Express listens on `config.host:config.port` (default `127.0.0.1:3000`).
- `GET /sse` upgrades to an SSE connection and binds a `SSEServerTransport` to the MCP server.
- `POST /message` receives MCP JSON-RPC messages over HTTP.
- Single active transport for v1 (mirrors reference example). Multi-client SSE support deferred.
- Graceful shutdown on SIGINT/SIGTERM: close transport, flush log queue, flush session store, exit 0.

## Testing

Vitest runner.

**Unit tests** (mock child_process, temp directories):

- `claudeRunner.test.ts` — correct CLI args per `sessionMode`, JSON session-ID parsing, timeout kills process, stderr surfaces correctly.
- `sessionStore.test.ts` — create/update/evict, atomic-write crash survival (simulated kill between tmp write and rename), TTL eviction, same-session mutex serializes.
- `config.test.ts` — valid configs parse, missing required fields error clearly, env vars override, Zod rejects bad types.
- `logger.test.ts` — valid JSONL output, 10 KB truncation, write queue preserves order under concurrency, `containsQuestion` heuristic covers documented phrases.

**Integration test** (`integration.test.ts`):

Spawns server as a subprocess against a test config. Connects as MCP client over SSE. Uses a mock `claude` binary on PATH (a small shell script echoing fake JSON output) — keeps tests hermetic, fast, and CI-friendly without Max auth. Verifies end-to-end wire format, log file contents, and session store state.

**Manual smoke test** (`docs/smoke-test.md`):

~5 commands to run the real server against the real Claude CLI and hit it with `curl` or a small Python script. The "does my Max subscription still work" check after config changes or Claude Code updates.

**Coverage target:** ~80% line coverage in CI. Not chasing 100% — Windows process-tree-killing and session-expiry edges have enough OS quirks that the last 20% isn't worth the mocking cost.

## Open questions / future work

- **Multiple concurrent MCP clients.** v1 supports one active SSE transport at a time. If Agent Zero plus another MCP client need simultaneous access, upgrade to per-client transport management.
- **Log rotation.** Out of scope; external tool expected.
- **Log viewer CLI.** A `npm run log:threads` command to walk `inReplyToLogId` and print conversation threads. Schema supports it; implementation deferred.
- **Session store compaction.** If the session file grows large despite TTL eviction (unlikely at personal-use scale), add compaction.
- **stdio transport.** Deferred. Adding it later is straightforward because tool logic is transport-agnostic.
