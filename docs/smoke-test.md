# Smoke Test

The automated tests use a mock `claude` binary. Run these manual steps after
config changes or Claude Code updates to verify the real CLI still works.

## Prerequisites

- `claude` on PATH, authenticated against your Claude Max subscription.
  Verify: `claude -p "say hi" --output-format json` prints a JSON line
  containing `session_id` and `result`.

## 1. Build and start the server

```
npm run build
npm start
```

Expected: `[ClaudeMCP] listening at http://127.0.0.1:3000/sse` in the console.

## 2. Health check

```
curl http://127.0.0.1:3000/health
```

Expected: `{"ok":true,"sessions":N}` where N is your current session count.

## 3. Ask smoke

Use a small Python or Node script to exercise the MCP SSE endpoint. Simplest
quick check: open `http://127.0.0.1:3000/sse` in a browser — you should see
an SSE stream start (a blank page that stays open). Do not leave this open
during a real call; it claims the single active transport slot.

Full check: run the integration test against a live `claude` binary by
editing `tests/integration.test.ts` to omit the `claudeCommand` override,
temporarily. Rerun `npm test`.

## 4. Task smoke

Use Agent Zero (or any MCP client configured for SSE) to call `claude_task`
with a tiny prompt pointed at a scratch directory:

- Tool: `claude_task`
- Arguments: `{ "prompt": "list the files in this directory", "workDir": "C:/Code/scratch", "sessionMode": "session" }`

Expected: the tool returns a text response describing the directory and
`_meta.sessionId` is populated. A new line is appended to
`logs/activity.log`.

## 5. Session resume

Call `claude_task` again with the `sessionId` from step 4 and a follow-up
prompt. The response should reference the prior turn. Verify
`data/sessions.json` shows `turnCount: 1`.

## 6. OpenAI-compat endpoint (for Agent Zero brain use)

Start the server as usual, then verify `POST /v1/chat/completions` works:

```
curl -s -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude","messages":[{"role":"user","content":"say hi briefly"}]}'
```

Expected: JSON response with `choices[0].message.content` containing Claude's greeting. A new line should appear in `logs/activity.log` with `tool: "openai_completion"` and `openaiMode: "fresh"`.

Run a second call that includes the first assistant reply to verify session resume:

```
curl -s -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude","messages":[
    {"role":"user","content":"say hi briefly"},
    {"role":"assistant","content":"<content from first reply>"},
    {"role":"user","content":"in french now"}
  ]}'
```

The log entry should show `openaiMode: "resumed"`. Check `data/sessions.json` — one entry with `externalKey` set and `turnCount: 1`.

### Agent Zero setup (brain mode)

In Agent Zero's settings, configure a "Custom OpenAI-compatible endpoint" provider:

- **Base URL:** `http://host.docker.internal:3000/v1`
- **API key:** any non-empty string (e.g., `sk-unused`)
- **Model name:** anything (ignored — Claude Code uses whatever the Max plan ships)

Agent Zero will call `POST /v1/chat/completions` with its full message+tool payload. Watch `logs/activity.log` for `openai_completion` entries to see what's happening.

**Fragility note:** Claude is trained to use tools, not to emit XML requests for a caller to execute. Expect occasional format deviations (ambiguous replies, tool-use tags with surrounding prose). The parser falls back to plain-text content in those cases, which Agent Zero may then retry. If you see frequent fallbacks, consider reverting to MCP-mode usage (where Claude IS the agent, not the brain).
