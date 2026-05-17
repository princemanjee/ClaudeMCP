# ClaudeMCP

**A multi-backend local gateway for Claude, Gemini, LM Studio, and Ollama.**

One process. One configuration. Four backends. Three API protocols. Pick the model and the protocol your client speaks, and the gateway routes it to whichever LLM you have available locally or via subscription.

ClaudeMCP started as a thin MCP wrapper around the Claude Code CLI so that other agentic tools could use Claude without paying for a separate Anthropic API key on top of an existing Claude Max subscription. The current version generalizes that idea to a full local LLM gateway. The original use case still works (Claude Code CLI usage with no extra API cost), and now sits alongside Gemini CLI usage, local model serving via LM Studio, and Ollama, all addressable through whichever API protocol your client speaks.

## Why this exists

Three problems this is built to solve:

**One.** You pay for Claude Max or a Gemini subscription, and your agentic tools want to charge you again to use the same models via API. Wrapping the CLI in a local server reuses the subscription auth and eliminates the double-billing.

**Two.** You have local models running in Ollama or LM Studio and you want them to be addressable through the same client code that already talks to cloud APIs. Speaking the Anthropic, Gemini, and OpenAI protocols natively means existing client SDKs work unchanged.

**Three.** You want to mix and match. Send the easy stuff to a local Ollama instance for free. Send the hard reasoning to Claude. Send vision tasks to Gemini. Have all of it look like one endpoint to your application.

## Backends

| Backend | Access | Notes |
| --- | --- | --- |
| **Claude** | Via `claude` CLI (Claude Code) | Reuses Claude Max subscription auth on disk. No separate API key required. Supports streaming, tool use, and stateful sessions. |
| **Gemini** | Via `gemini` CLI | Same pattern as Claude. Reuses CLI auth. Streaming-capable. |
| **LM Studio** | HTTP (`OpenAI-compatible`) | Multi-instance support. Default port 1234. Per-instance priority and timeout. |
| **Ollama** | HTTP (native `/api/*` or `/v1/*` OpenAI-compatible) | Multi-instance support. Default port 11434. Configurable per instance. |

LM Studio and Ollama can each be configured with multiple instances. For example, a local Ollama for fast cheap models and a remote Ollama on a workstation across the LAN for larger models. Address them with `ollama:local/llama-3.1-8b` or `ollama:remote-workstation/llama-3.1-70b`.

## API protocols served

Point any of the following kinds of clients at your local ClaudeMCP server and they will work without code changes:

- **Anthropic Messages API.** Clients that hit `/v1/messages` and expect `x-api-key` headers and Claude-style request shapes. The gateway translates to and from the normalized internal model for any backend.
- **Gemini API.** Clients that hit `/v1beta/models/<model>:generateContent` and expect `x-goog-api-key` headers or `?key=` query parameters.
- **OpenAI-compatible Chat Completions.** Clients that hit `/v1/chat/completions` with `Authorization: Bearer <key>`.
- **MCP over SSE.** The original transport. Useful for Agent Zero and other MCP-speaking agents.

The shims (in `src/anthropicShim/`, `src/geminiShim/`, and the OpenAI handling in `src/backends/openaiCompatClient.ts`) translate each protocol's request and response shapes into and out of a single normalized representation.

## Architecture

The architecture is built around two normalized types:

`NormalizedRequest` is a backend-agnostic request shape (system prompt, messages with typed content blocks, tools, tool choice, sampling parameters, stop sequences). It is modeled on the Anthropic Messages API shape so translators can pass content blocks through without renaming.

`NormalizedEvent` is the streaming-event union (message_start, text_delta, thinking_delta, tool_use_start, tool_use_delta, tool_use_stop, message_stop with usage). Backends emit these as async iterables, and the API-specific shims translate them into Anthropic SSE, Gemini SSE, or OpenAI delta formats.

Each backend implements the same interface:

```typescript
interface Backend {
  readonly id: BackendId;
  capabilitiesFor(model: string): BackendCapabilities;
  listModels(): Promise<ModelDescriptor[]>;
  invoke(req: NormalizedRequest): AsyncIterable<NormalizedEvent>;
  countTokens(req: NormalizedRequest): Promise<number>;
  embed?(req: NormalizedEmbeddingRequest): Promise<NormalizedEmbeddingResponse>;
}
```

The capability matrix matters because not every model in a backend supports every feature. The gateway queries `capabilitiesFor(model)` to decide whether to advertise tool use, vision, thinking mode, native cache control, native stop sequences, or embeddings support for a given request.

```
ClaudeMCP/
├── src/
│   ├── bin.ts                  # Entry point, CLI argument parsing
│   ├── server.ts               # Express HTTP server, route registration
│   ├── config.ts               # Zod-validated config loader
│   ├── auth.ts                 # Shared API key authentication
│   ├── modelRouter.ts          # Model name to backend identification
│   ├── tokenEstimator.ts       # Heuristic token counting
│   ├── responseCache.ts        # Response caching (in-memory + disk)
│   ├── fileStore.ts            # Multipart file storage with TTL
│   ├── archive.ts              # SQLite archive of requests and responses
│   ├── admin/                  # Admin UI handlers
│   ├── backends/
│   │   ├── types.ts            # Backend interface and normalized types
│   │   ├── registry.ts         # Backend registry and lookup
│   │   ├── claudeBackend.ts    # Claude CLI backend
│   │   ├── geminiBackend.ts    # Gemini CLI backend
│   │   ├── lmstudioBackend.ts  # LM Studio HTTP backend (multi-instance)
│   │   └── openaiCompatClient.ts  # Shared OpenAI-compatible client (used by Ollama too)
│   ├── runners/                # Process spawning for CLI backends
│   │   ├── claudeRunner.ts
│   │   ├── claudeStreamRunner.ts
│   │   ├── geminiRunner.ts
│   │   └── geminiStreamRunner.ts
│   ├── anthropicShim/          # Anthropic Messages API translation
│   │   ├── messages.ts
│   │   ├── countTokens.ts
│   │   ├── files.ts
│   │   ├── models.ts
│   │   ├── requestTranslator.ts
│   │   ├── responseTranslator.ts
│   │   ├── errors.ts
│   │   └── types.ts
│   └── geminiShim/             # Gemini API translation
│       ├── generateContent.ts
│       ├── modelPath.ts
│       ├── countTokens.ts
│       ├── files.ts
│       ├── models.ts
│       ├── requestTranslator.ts
│       ├── responseTranslator.ts
│       ├── errors.ts
│       └── types.ts
├── tests/                      # Vitest test suite
├── configs/
│   ├── default.json
│   └── example.json            # Annotated example with every knob
├── data/                       # Sessions, file store, response cache, archive (gitignored)
├── logs/                       # JSON-lines logs (gitignored)
├── scripts/                    # Setup helpers
├── package.json
└── README.md
```

## Model routing

Clients address models in any of these ways. The router resolves them deterministically.

| Pattern | Example | Routes to |
| --- | --- | --- |
| Prefix override (explicit) | `lmstudio/llama-3.1-70b` | The named backend, that model. |
| Prefix override with instance | `ollama:remote-workstation/mixtral` | A specific instance of a multi-instance backend. |
| Anthropic model ID | `claude-sonnet-4-5` | Claude backend. |
| Google model ID | `gemini-1.5-pro` | Gemini backend. |
| Bare alias for Claude | `opus`, `sonnet`, `haiku` | Claude backend, treated as the latest version. |
| Bare alias for Gemini | `pro`, `flash`, `flash-lite` | Gemini backend, treated as the latest version. |
| CLI sentinel | `claude-code-cli`, `gemini-cli` | The specific CLI invocation, useful when you want CLI behavior rather than API behavior. |
| Sentinel | `auto`, empty string | The configured default backend. |
| Anything else | (any other model name) | Looked up in the registry of discovered local models. |

Local backends (LM Studio, Ollama) are re-probed every `router.localProbeIntervalMs` milliseconds to keep the registry current as you load and unload models.

## Features beyond protocol translation

- **API key auth.** A shared key for all clients. Sent via `x-api-key`, `Authorization: Bearer`, `x-goog-api-key`, or `?key=` query parameter, depending on which protocol the client speaks. One auth, four header conventions.
- **Response cache.** In-memory plus disk-backed. Configurable TTL and entry count.
- **Archive.** SQLite-backed archive of requests and responses with zstd compression at a configurable level. Useful for debugging, auditing, and downstream analysis.
- **File store.** Multipart file uploads handled via Busboy, persisted with TTL and a configurable total-size budget. Eviction kicks in when the file store exceeds the budget after a TTL pass.
- **Embeddings.** Supported for backends that implement them; a legacy direct-passthrough config knob exists for cases where you want to bypass the registry.
- **Admin UI.** Localhost-bound by default with session TTL. Toggle off in config if you do not want it exposed even to localhost.
- **Tests.** Vitest setup with HTTP integration tests via supertest.

## Configuration

`configs/example.json` is the annotated reference. Every knob has a comment in the `_comments` block. The main top-level sections are:

- `apiKey` (required, shared across all clients)
- `claude`, `gemini` (enabled flag, CLI command, priority, timeout)
- `lmstudio`, `ollama` (enabled flag, list of instances, native API toggle for Ollama)
- `router` (default backend, local probe interval)
- `files`, `cache`, `archive` (TTLs, size limits, paths)
- `embeddings` (legacy passthrough config)
- `adminUi` (enabled, bindLocalhost, session TTL)

Each backend has a `priority` value. Default backend is whatever is set in `router.defaultBackend`; priorities are used in fallback and selection logic.

## Prerequisites

- Node.js 20 or later.
- For Claude backend: Claude CLI on PATH, authenticated to your Claude Max subscription.
- For Gemini backend: Gemini CLI on PATH, authenticated.
- For LM Studio backend: LM Studio running with the OpenAI-compatible server enabled (default port 1234).
- For Ollama backend: Ollama running (default port 11434). Native or OpenAI-compatible mode supported.

Any backend can be disabled in config if you do not have it available.

## Quickstart

```bash
# Install
npm install

# Copy example config and edit
cp configs/example.json configs/default.json
# Edit configs/default.json to set apiKey and enable the backends you have

# Run in dev mode (TypeScript directly via tsx)
npm run dev

# Or build and run compiled
npm run build
npm start

# Tests
npm test
```

The server starts on the configured port. Point your client at it using whichever protocol it already speaks.

### Compatibility test suite

`tests/compat/` exercises the real first-party SDKs (`@anthropic-ai/sdk`, `openai`, `@google/generative-ai`) against the running server with mock backends. These are the highest-signal "1:1 replacement" checks — if a wire envelope drifts, the SDK's own parser throws.

Default `npm test` includes them. For faster iteration on a specific feature, run `npm run test:nocompat` (or `npm test -- --exclude 'tests/compat/**'`). The compat suite alone runs via `npm run test:compat`.

The mock backends fulfill every request, so no real Anthropic / Google / LM Studio / Ollama installation is required.

## Scope notes

This is designed for **personal use or trusted small-team local deployments**. It now has API key authentication, which means it can reasonably sit behind a reverse proxy on your LAN if that fits your use case. It still does not aim to be a multi-tenant SaaS gateway, and it does not implement rate limiting, quotas, or per-user accounting.

The default Claude CLI invocation can be configured to include `--dangerously-skip-permissions`. That is the user's choice for personal-use convenience. Anyone considering broader deployment should re-evaluate that default and the rest of the security posture (auth, network exposure, logging discipline) for their context.

## Related work

Part of a broader toolset for AI engineering workflows:

- **[AIOrchBuilder](https://github.com/princemanjee/AIOrchBuilder)** is the multi-agent orchestration framework that uses gateways like this one as components.
- **[EngineeredPromptLibrary](https://github.com/princemanjee/EngineeredPromptLibrary)** is the prompt and context engineering archive that informed the schema and routing decisions here.

## Author

Built and maintained by **P. R. Manjee**. Digital transformation consultant focused on AI adoption, agentic systems, and the practical economics of building with frontier models. MIT Sloan (MS Digital Transformation), MIT (MS Information Systems), Notre Dame (BS Electrical Engineering). [princerehman.com](https://princerehman.com).

## License

Personal-use tool. See LICENSE (if present) or contact the author about other use.
