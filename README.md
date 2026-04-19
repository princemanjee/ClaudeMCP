# ClaudeMCP

An MCP-over-SSE server that wraps the `claude` CLI so external tools
(Agent Zero, Claude Desktop, custom orchestrators) can drive Claude Code
using your existing Claude Max subscription — no separate API key.

Runs locally on Windows. Binds to `127.0.0.1` by default.

## Quickstart

```
npm install
npm run build
npm start
```

## Endpoints

The server exposes two independent interfaces on the same port (8899 by default):

- **`/sse` + `/message`** — MCP-over-SSE for tool integrations (Agent Zero's tool calls, Claude Desktop, etc.). Two MCP tools: `claude_ask` (stateless chat) and `claude_task` (stateful agent task).
- **`/v1/chat/completions`** — OpenAI-compatible chat completions endpoint. Lets Agent Zero (or any LiteLLM-compatible client) use Claude Code CLI as its reasoning model via prompt-engineered XML tool calling. Streaming and non-streaming both supported.

See `configs/example.json` for every knob, and the design specs under `docs/superpowers/specs/` for details. Toggle the OpenAI endpoint off via `openai.enabled: false` if you only want the MCP path.

## Requirements

- Node.js 20+
- `claude` CLI on PATH, authenticated against your Max subscription
- Windows 11 (other platforms likely work; only Windows is tested)

## Development

```
npm run dev       # run in watch mode
npm test          # run all unit + integration tests
npm run typecheck # type-only build
```

## Logs and sessions

- Activity log: `logs/activity.log` (JSON lines, one per tool call)
- Session store: `data/sessions.json` (file-backed; survives restarts)

Every MCP response includes `_meta.logId`. If a response contains a question
Claude wants answered, pass that `logId` as `inReplyToLogId` on your
follow-up call to build a linked conversation trail in the log.

## Security note

The shipped `configs/default.json` sets `dangerouslySkipPermissions: true`.
Claude runs with full tool access — any shell command, any file write. This
is intentional for personal use but do not expose the server beyond
`127.0.0.1` without also flipping this to `false` and setting a tool
allowlist.

The OpenAI endpoint has no authentication by default (`openai.requireAuthHeader: null`).
If you expose the server beyond localhost, also set an auth header.

## License

Personal use. Do not redistribute.
