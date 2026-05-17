# ClaudeMCP Operations Guide

Day-to-day running of a ClaudeMCP server: where state lives, the admin UI,
archive maintenance, discovery, performance considerations, troubleshooting,
and backups.

## Related docs

- [Overview / README](README.md)
- [Deployment Guide](deployment-guide.md)
- [Configuration Guide](configuration-guide.md)
- [User Manual](user-manual.md)
- [API Reference](api-reference.md)
- [Technical Manual](technical-manual.md)
- [Development Guide](development-guide.md)

---

## Where things live

By default ClaudeMCP works out of one directory: `data/`. Every persistent
file is configurable via the [Configuration Guide](configuration-guide.md);
the defaults below assume you started the server with
`--config configs/default.json` from the repo root.

| Thing | Default path | Config field |
| --- | --- | --- |
| Config | `configs/default.json` | `--config <path>` at startup |
| Logs | stdout / stderr | controlled by your supervisor (see below) |
| SQLite archive | `data/archive.sqlite` (+ `-wal`, `-shm` sidecars) | `archive.dbPath` |
| File store (uploads) | `data/files/` | `files.dir` |
| Response cache | `data/response-cache.json` | `cache.file` |
| Legacy sessions | `data/sessions.json` | not configurable; legacy from original ClaudeMCP |
| Admin UI static assets | `src/admin-ui/` (served from disk by Express) | not configurable |
| Theme files | `src/admin-ui/themes/{light,dark}.css` | both loaded unconditionally |

**Logs.** There is no built-in log file. The server writes diagnostics to
stdout/stderr; capture them with your supervisor of choice:

- systemd: redirected by default to journal — `journalctl -u claude-mcp -f`.
- PM2 / Nodemon / Docker: stream `stdout`/`stderr` to your normal log
  pipeline.
- Plain shell: `npm start -- --config configs/default.json > server.log 2>&1`.

**Static admin UI assets.** Served directly from `src/admin-ui/` via
Express. There is no build/compile step — HTML, CSS, and JS are shipped as
authored. Bumping Alpine.js or theme colors is a config-free, code-only
edit; see the inline comment at the top of `src/admin-ui/index.html` for
the SRI hash recompute one-liner.

---

## Admin UI

### URL and login

```
http://127.0.0.1:<port>/admin/ui
```

(Replace `<port>` with whatever you started with — `--port` flag or the
default `3210`.)

Login screen asks for the `apiKey` from your config. The browser POSTs to
`/admin/ui/session`, which issues a 32-byte hex token and sets it as a
cookie:

| Cookie attribute | Value |
| --- | --- |
| Name | `claudemcp_session` |
| HttpOnly | yes (not readable from JS — XSS protection) |
| SameSite | Strict (no cross-origin) |
| Path | `/admin` (sent only to admin endpoints) |
| Max-Age | `floor(adminUi.sessionTtlMs / 1000)` (default 3600s) |

The session store is in-memory only — sessions clear on every server
restart. Re-log-in is mandatory after restart. That's the trade-off the
spec accepts for a localhost-only tool with no persistent secret store.

Logout: `DELETE /admin/ui/session` (the UI has a button); revokes the
token and clears the cookie.

### Five panels

| Panel | What it does |
| --- | --- |
| Dashboard | Backend health pills, recent-hour request count (approximate, capped at 200), startup info |
| Backends | Per-backend cards: list models, last probe time, "Refresh models" button, add-instance modal with `POST /admin/backends/test` connectivity check |
| Router | `defaultBackend` selector, `reasoningEffortMap` editor (claude/gemini/lmstudio/ollama × low/medium/high) |
| General | `apiKey` echo (PATCH-able), `localProbeIntervalMs`, `cache.ttlMs`, `archive.compressionLevel`, `bindLocalhost` toggle (with confirmation modal) |
| Archive | Filtered list (backend, session, model, since/until, status), pagination, substring search, full-entry viewer |

Each panel reads from `/admin/*` JSON endpoints behind the scenes; see
[API Reference](api-reference.md) for the wire formats. The Router and
General panels write back via `PATCH /admin/config` (RFC 7396 JSON merge
patch).

### Theme toggle

Top-right sun/moon button switches between `data-theme="light"` and
`data-theme="dark"`. Persisted to `localStorage["claudemcp-theme"]`.
First-visit default honors `prefers-color-scheme`. An inline script in
`<head>` applies the theme attribute BEFORE any stylesheet rule paints, so
there is no flash-of-unstyled-content.

Both theme stylesheets (`themes/light.css` and `themes/dark.css`) are
loaded unconditionally on every page — each wraps its custom-property
declarations in an attribute selector, so only one matches at any given
moment. Customizing: edit one of the two theme files, no rebuild needed.

### Access patterns

**Local only (default).** With `adminUi.bindLocalhost: true`, the admin UI
rejects any `req.ip` other than `127.0.0.1` / `::1` / `::ffff:127.0.0.1`
with HTTP 403. To use it from another machine, run an SSH tunnel:

```bash
ssh -L 8899:127.0.0.1:8899 user@your-server
# Then open http://127.0.0.1:8899/admin/ui locally.
```

**Beyond localhost.** Set `adminUi.bindLocalhost: false` (see [Configuration
Guide / adminUi](configuration-guide.md#adminui-block)) and PUT TLS + an
auth proxy in front. The server prints a `[startup] WARNING` line when
bindLocalhost is false — that's intentional.

**Reverse proxy gotcha.** Express's `req.ip` only reflects the original
client when `app.set("trust proxy", true)` is set. The default bootstrap
does NOT set this. If your nginx/Caddy forwards via `X-Forwarded-For` and
the admin UI starts rejecting every request, that's the cause; either
enable trust-proxy in your bootstrap OR set `bindLocalhost: false` and
delegate auth to the proxy.

---

## Archive

### What gets archived

Every successful, errored, and timed-out request to these endpoints lands
a row in `data/archive.sqlite`:

| Shim | Endpoint | Notes |
| --- | --- | --- |
| Anthropic | `POST /v1/messages` | Plan 05; uses cache-key-derived `request_hash` |
| Anthropic | `POST /v1/messages/count_tokens` | also archived |
| OpenAI | `POST /v1/chat/completions` | added in deferred-items fix sprint; SHA-256 hash |
| OpenAI | `POST /v1/embeddings` | added in deferred-items fix sprint; SHA-256 hash |
| Gemini | `POST /v1beta/models/<id>:generateContent` | added in deferred-items fix sprint; endpoint string includes action suffix |
| Gemini | `POST /v1beta/models/<id>:streamGenerateContent` | same |
| Gemini | `POST /v1beta/models/<id>:countTokens` | same |

**Streaming endpoints.** The aggregated final response is archived, not
the SSE chunks. Both OpenAI `chat/completions` and Gemini `generateContent`
tee their normalized event iterator so the archived body matches what a
buffered call would have returned.

**Request hash.** Two schemes coexist (flagged for unification — see
follow-ups at the bottom):

- Anthropic shim: cache-key-derived (canonical JSON of
  `{backendId, resolvedModel, system, cacheablePrefix, tail, tools,
  toolChoice}`) — same key the response cache uses.
- OpenAI + Gemini shims: SHA-256 of canonical JSON of
  `{endpoint, backend, modelResolved, requestBody}` via
  `src/admin/recordCompletion.ts`.

This is OK for observability but means cross-shim dedup on hash equality
won't work. Treat the hash as a per-shim opaque id.

### Schema

Defined in `src/archive.ts`. One table, four indexes, schema version 1:

```sql
CREATE TABLE entries (
  id              INTEGER PRIMARY KEY,
  request_hash    TEXT NOT NULL,
  log_id          TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  backend         TEXT NOT NULL,
  model_resolved  TEXT,
  session_id      TEXT,
  timestamp       TEXT NOT NULL,
  status          TEXT NOT NULL,        -- 'ok' | 'error' | 'timeout'
  duration_ms     INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  request_body    BLOB NOT NULL,        -- zstd-compressed JSON
  response_body   BLOB NOT NULL         -- zstd-compressed JSON
);
```

Bodies are zstd-compressed at `archive.compressionLevel` (default 3,
range 1..22). The level is honored end-to-end as of the deferred-items
fix sprint — earlier versions silently ignored it.

**No automatic migrations.** Adding a column to the schema requires
deleting `data/archive.sqlite` and letting the next process recreate it.
Plan ahead before upgrading: dump anything you want first.

### Querying

Two HTTP routes (mounted at `/admin/archive*`, gated by the admin auth
fence — see [API Reference](api-reference.md#admin-archive)). They're also
the foundation of the UI's Archive panel.

**List with filters:**

```bash
curl -H "x-api-key: $API_KEY" \
  "http://127.0.0.1:3210/admin/archive?backend=claude&limit=50&since=2026-05-01T00:00:00Z"
```

Supported query params:

| Param | Type | Example | Notes |
| --- | --- | --- | --- |
| `limit` | int | `50` | default 20, max 200 |
| `offset` | int | `100` | default 0 |
| `backend` | string | `claude` | exact match |
| `session` | string | `sess_abc123` | exact match on `session_id` |
| `model` | string | `claude-opus-4-7` | exact match on `model_resolved` |
| `since` | ISO-8601 | `2026-05-01T00:00:00Z` | inclusive lower bound on `timestamp` |
| `until` | ISO-8601 | `2026-05-17T00:00:00Z` | exclusive upper bound on `timestamp` |
| `status` | enum | `ok` / `error` / `timeout` | exact match |

Response envelope: `{ data: StoredArchiveEntry[], has_more: boolean }`.
Pagination uses the over-fetch-by-one trick — there is no `totalCount`.

**Substring search across request bodies:**

```bash
curl -H "x-api-key: $API_KEY" \
  "http://127.0.0.1:3210/admin/archive/search?q=tool_use&limit=10"
```

The search decompresses every entry in memory and runs `String.includes`.
Fine under ~10k entries; will become a hot spot beyond that. FTS5 swap-in
is flagged.

**Get one entry by id:**

```bash
curl -H "x-api-key: $API_KEY" \
  http://127.0.0.1:3210/admin/archive/4217
```

Returns the row with `requestBody` + `responseBody` decompressed and
JSON-parsed.

### Pruning

The repo ships `scripts/archive-prune.ts`. Run with `npx tsx`:

```bash
# Delete entries older than 2026-04-01.
npx tsx scripts/archive-prune.ts --config configs/default.json --before 2026-04-01

# Delete entries belonging to one session.
npx tsx scripts/archive-prune.ts --config configs/default.json --session sess_abc123

# Both filters at once (additive — entries matching EITHER are dropped).
npx tsx scripts/archive-prune.ts \
  --config configs/default.json \
  --before 2026-04-01 \
  --session sess_abc123
```

`--before` accepts `YYYY-MM-DD` only and pads to start-of-day UTC. Prints
`archive-prune: removed N entries` on success. Operates on the SQLite file
directly via the typed `deleteOlderThan` / `deleteBySession` methods; no
HTTP round-trip.

After a big prune, consider a manual SQLite `VACUUM` to reclaim disk
space — the SQLite file does NOT auto-shrink:

```bash
sqlite3 data/archive.sqlite "VACUUM;"
```

VACUUM rewrites the file; you'll see disk usage drop. Run when the server
is stopped or while you can tolerate a brief write pause (VACUUM takes a
write lock for its duration).

### Failure semantics

Archive writes are fire-and-forget (`setImmediate` deferred). If
`recordEntry` throws — disk full, sidecar permission error, schema drift —
the warning lands on stderr:

```
archive.recordEntry failed: <error message>
```

…and the request response is unaffected. Archive is observability, not a
hard dependency on the request path.

---

## Discovery and probing

### What gets probed

Local backends (LM Studio, Ollama) are re-probed every
`router.localProbeIntervalMs` (default 60s) so models the operator loads
at runtime show up in `/admin/backends` without a server restart. Cloud
backends (Claude, Gemini) probe once at startup — the CLI tool doesn't
expose a model-list endpoint we can poll cheaply.

The probe is `BackendRegistry.probe()` — `Promise.all` across every
registered backend's `listModels()`. A failure on one backend does not
block the others; failed backends just report empty model lists until the
next probe succeeds.

### Forcing a re-probe

The Backends panel's "Refresh models" button calls:

```bash
curl -X POST -H "x-api-key: $API_KEY" \
  http://127.0.0.1:3210/admin/backends/reprobe
```

Response: `{ data: [...], _meta: { reprobeScope: "all" } }`. The handler
runs `registry.probe()` and returns the freshly listed backends in one
round-trip.

### Per-instance re-probe (currently a no-op)

The handler accepts a `?instance=<id>` query parameter and validates it
against known backend ids (or the `lmstudio:work-server` style). When
provided, the response includes `_meta.requestedInstance: <id>` in
addition to `reprobeScope: "all"` — but the underlying probe is still
all-or-nothing. The registry doesn't have a per-instance probe today.
The API surface is shipped for future use; calling it works, but the
"only this instance" guarantee isn't enforced yet. Flagged.

### Probe status

`GET /admin/backends` returns each backend's `lastProbe` field:

```json
{
  "id": "ollama",
  "models": [...],
  "capabilities": {...},
  "lastProbe": { "ok": true, "at": "2026-05-17T14:23:11.041Z" },
  "reachable": true
}
```

A failed probe surfaces as `{ ok: false, at: "...", error: "<message>" }`
and `reachable: false`. The admin UI Dashboard uses this for its
red/yellow/green health pills.

---

## Performance considerations

The defaults are tuned for an operator with a few clients hammering the
server, not a production-grade SaaS. The following are the known
hot-spots:

### Archive writes are fire-and-forget

`recordCompletion` queues the SQL insert via `setImmediate` so the
response path never blocks on the archive. If your disk is slow or
SQLite is contended, you'll see warnings on stderr but no latency hit on
the response. Trade-off: archive entries are not guaranteed durable at
the moment the response returns. WAL fsync still happens; you can lose
the most recent few writes on a hard crash.

### Response cache fragments on sampling param differences

The cache key includes `tools`, `toolChoice`, and the full canonicalized
prompt, BUT also includes the resolved model and the backend id. Different
sampling params (temperature, top_p) DON'T currently fragment the key
because they're not part of the cache-key shape — but the cache only
records hits when the request body shape matches the cache-key inputs.
In practice this means the cache works well for "same prompt, same model,
same tools" replays and poorly for "tweak temperature and retry" loops.

### Streaming archive writes buffer the full event list

Both the OpenAI shim's `chat/completions` and the Gemini shim's
`generateContent` tee the normalized event iterator into a buffer so the
archived body matches the buffered shape. Memory cost is the full
response body per in-flight streaming request. Fine at current scale; if
you're seeing the server eat memory under heavy streaming load, this is
the first place to look.

### Periodic probe is not re-entrancy-guarded

`startPeriodicProbe(intervalMs)` runs `probe()` every `intervalMs` ms via
`setInterval` with no flag for "a probe is already in flight." For a 60s
interval against a healthy local backend, probe completes in tens of ms
and you'll never see overlap. If you set `localProbeIntervalMs` to
something like 1000 AND your Ollama daemon is slow, you can wedge two
probes into the same `rebuildModelMap` call. The second one wins
non-deterministically. Recommendation: leave the default; if you need
fresher data, hit `POST /admin/backends/reprobe` manually.

### `Archive.searchText` is O(n) per query

The substring search decompresses every entry and runs `String.includes`.
Acceptable under ~10k entries; will become slow beyond that. FTS5 swap-in
is on the open-questions list. Until then, prefer the filtered list
(`/admin/archive?backend=…&since=…`) when possible — those filters are
SQL-indexed.

### Cookie sweeper

`SessionStore.sweep()` runs every 60s (hard-coded in `server.ts`) to
evict expired sessions from the in-memory map. Cost is O(n) over live
sessions; in normal use, n is tiny. The sweep interval is not configurable.

### File store sweep

`FileStore` runs an eviction sweep every 5 minutes (hard-coded). Drops
files older than `files.ttlMs` since last access, then LRU-evicts down
to `files.maxTotalBytes`. Sweep cost is proportional to file count, not
file size.

---

## Troubleshooting

### `Invalid api_key` or HTTP 401

**Cause.** The carrier (header or query) doesn't match `apiKey` from
config, or the request is missing it entirely.

**Fix.** Verify which carrier you're using. The server accepts any of:

- `x-api-key: <key>` (Anthropic)
- `Authorization: Bearer <key>` (OpenAI, generic)
- `x-goog-api-key: <key>` (Google)
- `?key=<key>` (Google query)

`curl -v` to see the actual request. Comparison is constant-time and
case-sensitive; a trailing newline on copy-paste will break it. Check
that `CLAUDE_MCP_API_KEY` (the env override) isn't quietly replacing the
config value.

### HTTP 503 / "backend not configured"

**Cause.** The backend the request needs is either disabled
(`<backend>.enabled: false`), unregistered (LM Studio / Ollama with
empty `instances[]`), or hasn't been probed yet (startup race).

**Fix.** `GET /admin/backends` to see what's actually registered.
Add an instance to `<backend>.instances[]` and PATCH the config, or
restart with the corrected JSON.

### HTTP 400 / "model not found"

**Cause.** The requested model is not in any registered backend's
discovered catalog AND has no prefix override.

**Fix.**

1. `GET /admin/backends` — see what models each backend reports.
2. If the model SHOULD be available, force a probe:
   `POST /admin/backends/reprobe`. If it still doesn't appear, the
   backend itself doesn't have the model loaded (LM Studio: load it in
   the GUI; Ollama: `ollama pull <model>`).
3. If the model is on a specific instance, use the prefix override:
   `lmstudio:work-server/<model>` or `ollama:remote/<model>`.

### CLI spawn failure (Claude or Gemini)

**Cause.** The configured `command` is not on PATH, not executable, or
the CLI itself isn't authenticated.

**Fix.** Run the CLI by hand from the same shell as the server:

```bash
claude --version
gemini --version
```

If they fail with a "not found" or "permission denied," your config's
`command` field is wrong. Use the array form to point at an absolute
path:

```json
{ "claude": { "command": ["/opt/claude/bin/claude"] } }
```

If the binaries work standalone but spawn-from-Node fails with an auth
error, the CLI's per-user credential store isn't accessible to the user
the server is running as. On Linux: check the user's home dir
permissions and that the server process has the right `HOME` env var.

### LM Studio probe fails / 0 models

**Cause.** LM Studio daemon isn't running, OR its OpenAI server isn't
enabled.

**Fix.** Open LM Studio's Developer panel and toggle "Local Server" on.
The default port is 1234; verify by hand:

```bash
curl http://127.0.0.1:1234/v1/models
```

If the curl works but the probe doesn't, check `baseUrl` in your config
includes the `/v1` suffix:

```json
{ "instances": [{ "baseUrl": "http://127.0.0.1:1234/v1" }] }
```

### Ollama probe fails

**Cause.** Daemon not running, OR port 11434 blocked, OR `baseUrl` has
the `/v1` suffix added when it shouldn't be.

**Fix.**

```bash
# Verify the daemon.
curl http://127.0.0.1:11434/api/tags

# Or for compat mode:
curl http://127.0.0.1:11434/v1/models
```

The Ollama `baseUrl` should NOT include `/v1` — the backend appends the
right path based on the mode (native or compat).

```json
{ "instances": [{ "baseUrl": "http://127.0.0.1:11434" }] }
```

### Tests fail with `Cannot find module 'busboy'`

**Cause.** `busboy` was added as a runtime dep in Plan 05 (for multipart
file upload parsing). Old `node_modules`.

**Fix.** `npm install`.

### `bindLocalhost` rejects every request

**Cause.** Behind a reverse proxy without `app.set("trust proxy", true)`,
Express's `req.ip` is the proxy's address (typically `::1` or the
proxy's container IP), not the original client. With bindLocalhost on,
the guard rejects anything that isn't loopback — and the proxy's
container IP usually isn't loopback either.

**Fix.** Two options:

1. Set `bindLocalhost: false` and delegate auth + TLS to the proxy.
   Recommended for any real deployment.
2. Patch the bootstrap to call `app.set("trust proxy", true)` so the
   `X-Forwarded-For` header is honored. This means the loopback guard
   passes when the original client is loopback (typically not what you
   want behind a proxy).

The startup `[startup] WARNING` log line about bindLocalhost is your
clue that you've chosen option 1.

### "Schema-change errors" after upgrading

**Cause.** Archive schema is versioned at 1 with no automatic migrations.
Adding a column requires manual intervention.

**Fix.** Stop the server, back up `data/archive.sqlite` if you want the
history, delete the file + the `-wal` + `-shm` sidecars, restart. The
next process startup recreates the schema fresh.

```bash
mv data/archive.sqlite data/archive.sqlite.bak
rm -f data/archive.sqlite-wal data/archive.sqlite-shm
npm start -- --config configs/default.json
```

### Admin UI shows "Failed to load backends"

**Cause.** Usually the cookie expired (`adminUi.sessionTtlMs`), the
server restarted (in-memory session store cleared), or the apiKey was
PUT'd to a new value while you held an old cookie.

**Fix.** Log out (`DELETE /admin/ui/session`, or click the button), then
log back in with the current apiKey. If the UI is unresponsive, clear
the `claudemcp_session` cookie via the browser's devtools.

### Streaming response stalls or times out

**Cause.** The backend (Claude CLI, Gemini CLI, LM Studio, Ollama) hung
on its own. ClaudeMCP doesn't impose a streaming-deadline beyond the
backend's `timeoutMs` (default 5–10 minutes).

**Fix.**

1. Check the supervisor logs for a `child process timed out` line.
2. Lower the backend's `timeoutMs` if you want to bail earlier.
3. Test the backend directly (run the CLI by hand or curl LM Studio /
   Ollama directly) to confirm it's not a backend-side hang.

---

## Backups

### What to back up

The whole `data/` directory is the persistent state. A nightly tar / zip
is enough for most setups:

```bash
# Pause writes if you can — see the SQLite WAL note below.
tar czf /backup/claude-mcp-$(date +%F).tar.gz \
  data/archive.sqlite \
  data/archive.sqlite-wal \
  data/archive.sqlite-shm \
  data/files \
  data/response-cache.json \
  configs/default.json
```

If you're space-constrained, the priority order is:

1. `configs/default.json` (your config, including the apiKey)
2. `data/archive.sqlite` + sidecars (full request history)
3. `data/files/` (uploaded user assets — irreplaceable)
4. `data/response-cache.json` (regenerable from traffic)

### SQLite WAL caveat

ClaudeMCP runs SQLite in WAL mode (`PRAGMA journal_mode = WAL`). The
database file alone is NOT a complete snapshot — the WAL and shared-mem
sidecars (`data/archive.sqlite-wal`, `data/archive.sqlite-shm`) carry
in-flight commits. Two safe options:

**Option A: include the sidecars.** Back up all three files. On restore,
SQLite will replay the WAL on first open. Easiest; works for a hot
backup as long as you don't tear during the copy (use `tar` with
`--atime-preserve` or rsync; don't `cp -a` a single file mid-write).

**Option B: checkpoint first.** Force a WAL checkpoint so the main
database file is up to date, then back up just the main file:

```bash
sqlite3 data/archive.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"
cp data/archive.sqlite /backup/archive-$(date +%F).sqlite
```

`TRUNCATE` shrinks the WAL to zero bytes. After the checkpoint, the main
file is a complete snapshot.

The server can be running during either approach — SQLite handles
concurrent readers fine.

### Config secrets

`configs/default.json` contains your `apiKey` in plaintext. If you back
up this file, treat the backup like a credential. Better: keep `apiKey`
out of the JSON entirely and set it via the env override
(`CLAUDE_MCP_API_KEY`), so the backup never carries the secret.

### Restore drill

To restore:

1. Stop the running server.
2. Replace `data/` with the backup.
3. Restore `configs/default.json` to wherever your bootstrap expects it.
4. Restart.

A test restore once per quarter is cheaper than learning your backups
were broken during a real incident.

---

## Follow-ups

- **Per-instance reprobe is a no-op.** The `?instance=<id>` query
  parameter is validated but the underlying probe is backend-level. UI
  surfaces the parameter today; a follow-on plan should promote the
  registry to per-instance probes.
- **Two archive request-hash schemes coexist** — Anthropic shim uses a
  cache-key-derived hash; OpenAI and Gemini shims use a SHA-256 of the
  canonicalized request. Cross-shim dedup on hash won't work; flagged
  for unification.
- **`Archive.searchText` is O(n) per query** (decompress every row,
  String.includes). Acceptable under ~10k entries; FTS5 swap-in is on
  the spec's open-questions list.
- **No automatic archive schema migration.** Schema changes require
  manually deleting `data/archive.sqlite`. A `schema_version` table +
  migration runner would be a reasonable Plan-14.
- **Periodic probe is not re-entrancy-guarded.** Safe at 60s default;
  tighten if you set `localProbeIntervalMs` very low or if probes
  start taking longer than the interval.
- **Streaming archive writes buffer the full event list in memory**
  before writing. Fine at current scale; flag if response sizes grow.
- **Sessions are in-memory only.** Every server restart logs every UI
  operator out. Acceptable for a localhost-only tool; a persistent
  session store (signed cookie or DB-backed) is the obvious upgrade if
  the tool ever serves shared infra.
- **Cookie sweeper interval is hard-coded** at 60s in `server.ts`.
  Promote to config if anyone ever cares.
- **Archive size doesn't auto-shrink.** After a big prune, run
  `sqlite3 data/archive.sqlite "VACUUM;"` to reclaim disk space — or
  add it to your maintenance crontab.
- **Visual regression baselines not committed.** Playwright baselines
  under `tests/integration/adminUi.visual.baseline/` are intentionally
  not in git initially. Operators running `npm run test:visual` will
  get a baseline-mismatch error until baselines are generated locally
  and committed by whoever owns release.
