# ClaudeMCP

An MCP (Model Context Protocol) server that exposes the locally installed Claude Code CLI as MCP tools, so any MCP-speaking client (Agent Zero, custom agents, IDE integrations) can call Claude without holding a separate Anthropic API key.

The trick: Claude Code's headless mode (`claude -p`) reuses the Claude Max subscription authentication already stored on disk by the CLI. Wrapping it as an MCP server therefore exposes that subscription to other tools at no additional API cost. If you already pay for Claude Max, this turns one subscription into the engine that powers every agentic tool on your machine.

## What you get

Two MCP tools, designed around the two ways agents actually use a smart LLM:

### `claude_ask` — stateless smart LLM

A fast, sandboxed chat-completion endpoint. No file access, no shell, no session memory. Use this when an agent needs Claude to reason about a prompt and return a structured answer without touching the filesystem.

```ts
{
  prompt: string,
  inReplyToLogId?: string
}
```

Returns text content plus a log ID and duration metadata. Internally invokes `claude -p "<prompt>" --output-format json --allowed-tools ""` so Claude is fully sandboxed.

### `claude_task` — stateful sub-agent

A full-capability delegate. Use this when you want to hand Claude a real task inside a working directory with tool access. Supports three session modes:

- `stateless` (every call is fresh)
- `session` (resume from a specific `sessionId`)
- `auto-last` (continue from wherever the last call left off)

```ts
{
  prompt: string,
  workDir?: string,
  sessionMode?: "stateless" | "session" | "auto-last",
  sessionId?: string,
  allowedTools?: string,
  inReplyToLogId?: string
}
```

Sessions are persisted to a file-backed store (`data/sessions.json`) so continuity survives server restarts.

## Bonus: OpenAI-compatible shim

There is also an OpenAI-compatible API shim (in `dist/openaiShim/`) that translates OpenAI Chat Completions requests into Claude calls and back. Tools and libraries that expect the OpenAI API format can point at this server and use Claude instead, including streaming. This makes ClaudeMCP useful as a drop-in cost reducer for anything that already integrates with `gpt-4` or similar via the OpenAI client SDK.

## Architecture

Single Node.js / TypeScript process. Express HTTP server. MCP-over-SSE transport (chosen because Agent Zero typically runs in Docker while the server runs on the host, so stdio is not enough). JSON-lines async logging with a write queue. Zod-validated configuration.

Isolation rule: `claudeRunner.ts` is the only module that touches the Claude CLI. If Claude Code changes its flags or output format, that is the only file that needs to change.

```
ClaudeMCP/
├── dist/                       # Compiled JavaScript
│   ├── bin.js                  # CLI entry point
│   ├── server.js               # Express + MCP server
│   ├── claudeRunner.js         # Single-source-of-truth wrapper around `claude`
│   ├── claudeStreamRunner.js   # Streaming variant for SSE responses
│   ├── sessionStore.js         # File-backed session persistence
│   ├── config.js               # Zod-validated config loader
│   ├── logger.js               # JSON-lines async logger
│   ├── tools/
│   │   ├── claudeAsk.js        # claude_ask MCP tool
│   │   └── claudeTask.js       # claude_task MCP tool
│   └── openaiShim/             # OpenAI-compatible translation layer
├── data/                       # File-backed session store (gitignored)
├── docs/superpowers/specs/     # Design specifications
├── logs/                       # JSON-lines logs (gitignored)
├── scripts/                    # Helper scripts (Agent Zero config, LAN access)
└── README.md
```

## Scope and non-goals

This is a personal-use tool, intentionally scoped narrow. To be honest about what it is not:

- It is **not** intended to be exposed to the public internet or redistributed to third parties. The MCP server binds to localhost (or LAN if you opt in via `scripts/setup-lan-access.ps1`).
- It is **not** a multi-user system. There is no auth, no quotas, no rate limiting. One user, one machine.
- It does **not** replicate the full Claude Code interactive TUI. No permission prompts, no chat history UI.
- It does **not** rotate logs. Use `logrotate` or equivalent if you care about that.

The default ships with `--dangerously-skip-permissions` enabled. That is a deliberate choice for personal use. Anyone considering broader deployment should re-evaluate that default.

## Prerequisites

- Windows 11, macOS, or Linux host. (Originally developed on Windows 11; the `scripts/` directory has PowerShell helpers.)
- Node.js 20 or later.
- Claude CLI installed on PATH and authenticated to a Claude Max subscription.
- An MCP-speaking client to consume the server (Agent Zero, a custom integration, or anything else that speaks MCP-over-SSE).

## Quickstart

```bash
# Install dependencies
npm install

# Start the server
node dist/bin.js
```

The server starts on `http://localhost:<port>` (configurable). Point your MCP client at the SSE endpoint and the two tools will be available.

The `scripts/configure-agent-zero.sh` helper sets up Agent Zero specifically. The `scripts/setup-lan-access.ps1` (and `remove-lan-access.ps1`) scripts open and close LAN access for cases where your MCP client lives on another machine in your local network.

## Design documentation

The full design spec is at `docs/superpowers/specs/2026-04-18-claude-mcp-design.md`. It covers the goals, non-goals, architectural constraints, tool schemas, session semantics, logging format, and security trade-offs in more depth than this README.

## Related work

Part of a broader toolset for AI engineering workflows:

- **[AIOrchBuilder](https://github.com/princemanjee/AIOrchBuilder)** is the multi-agent orchestration framework that uses MCP servers like this one as components in a larger agent system.
- **[EngineeredPromptLibrary](https://github.com/princemanjee/EngineeredPromptLibrary)** is the prompt and context engineering archive that informed both the tool design and the schema choices here.

## Author

Built and maintained by **P. R. Manjee**. Digital transformation consultant focused on AI adoption, agentic systems, and the practical economics of building with frontier models. MIT Sloan (MS Digital Transformation), MIT (MS Information Systems), Notre Dame (BS Electrical Engineering). [princerehman.com](https://princerehman.com).

## License

Personal-use tool. See LICENSE (if present) or contact the author about other use.
