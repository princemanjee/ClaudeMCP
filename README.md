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

The server listens at `http://127.0.0.1:3000/sse` with two MCP tools:

- **`claude_ask(prompt)`** — stateless, no file access. Use as a chat endpoint.
- **`claude_task(prompt, workDir?, sessionMode?, sessionId?, allowedTools?)`** — full Claude Code agent with session continuity.

See `configs/example.json` for every knob, and `docs/superpowers/specs/2026-04-18-claude-mcp-design.md` for the full design.

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

## License

Personal use. Do not redistribute.
