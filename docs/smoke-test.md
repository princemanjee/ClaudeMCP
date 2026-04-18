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
