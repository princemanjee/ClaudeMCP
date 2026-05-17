# ClaudeMCP Documentation

## What is ClaudeMCP

ClaudeMCP is a multi-backend local LLM gateway. A single Node.js process exposes three HTTP wire formats — Anthropic Messages, OpenAI Chat Completions + Embeddings, and Google GenerativeAI — and routes requests to one of four backends: the `claude` CLI, the `gemini` CLI, LM Studio (HTTP), or Ollama (HTTP). It runs entirely on your machine, riding existing Claude Max and Google account auth for the CLI backends, so no separate cloud API keys are required to use the subscription-backed providers. Ships with a localhost-bound admin UI, a persistent files API, a response cache, and a SQLite request/response archive.

## Who it's for

- Agentic tools and SDK consumers that want a single local endpoint speaking multiple provider protocols without juggling vendor keys.
- Developers iterating against multiple models without rewriting against three different SDKs.
- Personal-use power users mixing local (Ollama / LM Studio) and subscription (Claude Max, Gemini) models behind one address.

## Quick start

```bash
git clone <repo-url> ClaudeMCP
cd ClaudeMCP
npm install
cp configs/example.json configs/default.json
# Edit configs/default.json — set `apiKey` to a strong random value
npm start
```

The server logs `ClaudeMCP listening on http://127.0.0.1:3210` (or whatever `--port` you pass). Health check at `GET /health`. See the [Deployment Guide](deployment-guide.md) for prerequisites, platform-specific service install, and verification steps.

## Documentation index

Read in roughly this order:

1. [Deployment Guide](deployment-guide.md) — prerequisites, install, first run, running as a long-lived service on Windows / macOS / Linux.
2. [Configuration Guide](configuration-guide.md) — every field in `configs/*.json` explained, with defaults and tuning notes.
3. [User Manual](user-manual.md) — using the admin UI day-to-day, plus end-to-end SDK examples for each wire format.
4. [API Reference](api-reference.md) — every endpoint, every request/response shape, every error.
5. [Operations Guide](operations-guide.md) — logs, the SQLite archive, backups, troubleshooting common failures.
6. [Technical Manual](technical-manual.md) — internal architecture: shims, backend interface, registry, model router, normalized event stream.
7. [Development Guide](development-guide.md) — the TDD pattern this project uses, the 13-plan workflow, and how to add a new backend.

## Architecture at a glance

```
            ┌─────────────────────────────────────────────────┐
            │              HTTP wire formats                   │
            │  /v1/messages     /v1/chat/completions           │
            │  /v1/embeddings   /v1beta/models/:m:generate...  │
            │  /v1/files        /v1beta/files                  │
            └────────┬─────────────┬───────────────┬───────────┘
                     │             │               │
              anthropicShim   openaiShim     geminiShim
                     │             │               │
                     └─────────────┴───────────────┘
                                   │
                  NormalizedRequest / NormalizedEvent
                                   │
                          BackendRegistry
                                   │
            ┌─────────┬────────────┼────────────┬─────────┐
            │         │            │            │         │
        Claude     Gemini      LM Studio     Ollama    (future)
        (CLI)      (CLI)         (HTTP)      (HTTP)
```

Shims translate each wire format into a single normalized request/event model, the registry picks a backend by model name (or `router.defaultBackend`), and the backend streams normalized events back. The same admin process owns the response cache, the SQLite archive, the file store, and the admin UI.

## Project status

v0.2.0 — 13-plan implementation complete on `main`. 862 tests passing across 70 vitest files (4 skipped with documented reasons). Compat suite exercises real `@anthropic-ai/sdk`, `openai`, and `@google/generative-ai` SDKs against all four backends with mock fixtures.
