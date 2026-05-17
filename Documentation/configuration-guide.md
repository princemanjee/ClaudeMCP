# ClaudeMCP Configuration Guide

Reference doc for every field in the ClaudeMCP config file. Each section
covers a top-level block: what it controls, the Zod-enforced schema, the
default value, and worked examples.

The authoritative schema lives at `src/config.ts`. If you find a discrepancy
between this doc and the code, the code wins — file a fix.

## Related docs

- [Overview / README](README.md)
- [Deployment Guide](deployment-guide.md)
- [User Manual](user-manual.md)
- [API Reference](api-reference.md)
- [Operations Guide](operations-guide.md)
- [Technical Manual](technical-manual.md)
- [Development Guide](development-guide.md)

---

## Config file location

| What | Value |
| --- | --- |
| Default file | `configs/default.json` |
| Example file with comments | `configs/example.json` |
| Override at startup | `--config <path>` to the bin entry |
| Format | JSON, Zod-validated |
| Override at runtime | `PATCH /admin/config` or the admin UI (see [Operations Guide](operations-guide.md#admin-ui)) |
| In-flight requests | Keep their original snapshot. New requests see the new snapshot |
| Disk write semantics | Atomic write-then-rename via `ConfigSnapshotStore` |

A bad config fails fast at startup with a Zod error message printed to
stderr. Examples of validation failures:

- Missing `apiKey` (`apiKey: required`).
- A `priority` field set to a non-integer (`gemini.priority: Expected integer`).
- Two LM Studio instances with the same `name` (caught by the
  schema's `superRefine` pass).
- A `compressionLevel` outside `1..22`.

Starting the server:

```bash
# Dev (TypeScript via tsx)
npm run dev -- --config configs/default.json --port 3210

# Production (built dist)
npm run build
npm start -- --config /etc/claude-mcp/config.json --port 8899
```

The `--port` flag overrides the default `3210`.

---

## Environment variable overrides

Env vars are applied AFTER Zod validation, so they can not put the config
into an invalid state — they only override already-validated fields.

| Variable | Overrides | Notes |
| --- | --- | --- |
| `CLAUDE_MCP_API_KEY` | `apiKey` | Useful for keeping the API key out of disk files (Docker secrets, systemd `EnvironmentFile=`, etc.) |

If `CLAUDE_MCP_API_KEY` is set, it replaces whatever `apiKey` came from the
JSON config. Other env vars are NOT consulted by the loader — keep the rest
of the config in the JSON file.

---

## Top-level fields

### `apiKey` (required)

The shared bearer token for ALL clients. ClaudeMCP accepts it via any of
these four carriers (see `src/auth.ts`):

| Carrier | Header / param |
| --- | --- |
| Anthropic style | `x-api-key: <key>` |
| Google style | `x-goog-api-key: <key>` |
| OpenAI / generic | `Authorization: Bearer <key>` |
| Google query string | `?key=<key>` |

Comparison is constant-time via `node:crypto.timingSafeEqual`.

**Type:** `string` (minimum length 1)
**Default:** none — required
**Constraint:** `z.string().min(1)`

```json
{ "apiKey": "sk-mcp-3f6c1e2a4b8d9c5e..." }
```

The admin UI redacts this field to `"***"` in `GET /admin/config` responses;
PUT/PATCH bodies containing literal `"***"` are rejected with a clear error
to prevent the UI from accidentally clobbering the real key on round-trip
saves.

---

### `claude` block

The local Claude CLI backend. Spawned per-request via `cross-spawn`.

| Field | Type | Default | Constraint |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | — |
| `command` | `string` or `string[]` | `"claude"` | non-empty string OR non-empty array |
| `priority` | `int` | `100` | — |
| `timeoutMs` | `int` | `600000` (10 min) | `> 0` |

**`command` flexibility.** Pass a bare `"claude"` to spawn the executable on
`PATH`. Pass an array form like `["wsl", "claude"]` to spawn `wsl` with
`claude` as the first arg — useful for Windows hosts that run the CLI inside
WSL. The runner inserts the request-specific args after this prefix.

**`priority`.** Used by `BackendRegistry.rebuildModelMap` to break model-id
ties when two backends report the same model id. Higher wins. Defaults
intentionally rank the cloud CLIs above the local backends:

| Backend | Default priority |
| --- | --- |
| `claude` | 100 |
| `gemini` | 90 |
| `lmstudio` (backend-level) | 50 |
| `ollama` (backend-level) | 40 |

**`timeoutMs`.** Kills the spawned process and surfaces a 504 if the CLI
hasn't produced a final response within this many ms. 10 minutes is the
default because the Claude CLI can take a while on long tool-use loops.

**Disable Claude entirely:**

```json
{ "claude": { "enabled": false } }
```

**Run Claude via WSL on a Windows host:**

```json
{ "claude": { "command": ["wsl", "claude"] } }
```

---

### `gemini` block

Same shape as `claude`. Spawns the `gemini` CLI per-request.

| Field | Type | Default | Constraint |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | — |
| `command` | `string` or `string[]` | `"gemini"` | non-empty |
| `priority` | `int` | `90` | — |
| `timeoutMs` | `int` | `600000` | `> 0` |

```json
{ "gemini": { "command": "/opt/google/gemini-cli/bin/gemini" } }
```

---

### `lmstudio` block

The first HTTP-client backend. Talks to LM Studio's OpenAI-compatible
server (typically `http://127.0.0.1:1234/v1`).

| Field | Type | Default | Constraint |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | — |
| `instances` | `InstanceConfig[]` | `[]` | per-instance `name` must be unique |

**`InstanceConfig` shape** (shared with `ollama.instances`):

| Field | Type | Default | Constraint |
| --- | --- | --- | --- |
| `name` | `string` | none — required | min length 1 |
| `baseUrl` | `string` (URL) | none — required | must parse as URL |
| `apiKey` | `string` | `""` | — |
| `priority` | `int` | `50` | — |
| `timeoutMs` | `int` | `300000` (5 min) | `> 0` |
| `useNativeApi` | `boolean` or `null` | `null` | — (only meaningful for Ollama) |

For LM Studio, `useNativeApi` is parsed but unused — LM Studio only speaks
the OpenAI-compat protocol.

**Server registration rule.** The LM Studio backend is registered at startup
only when `lmstudio.enabled && lmstudio.instances.length > 0`. If you enable
the block but leave `instances` empty, no backend is registered and the
config still validates — useful for keeping the block "enabled" in CI while
you flip individual instances on and off.

**Implicit vs prefix-override routing.** With multiple instances, an
incoming `model: "qwen3-coder-30b"` resolves to the highest-priority instance
that reported the model. To force an instance, prefix the model:

```
lmstudio:work-server/qwen3-coder-30b
```

This bypasses the priority map and routes directly to `work-server`.

**Single LM Studio instance (default):**

```json
{
  "lmstudio": {
    "enabled": true,
    "instances": [
      {
        "name": "local",
        "baseUrl": "http://127.0.0.1:1234/v1",
        "apiKey": "",
        "priority": 50,
        "timeoutMs": 300000
      }
    ]
  }
}
```

**Two LM Studio boxes (laptop + workstation):**

```json
{
  "lmstudio": {
    "enabled": true,
    "instances": [
      {
        "name": "laptop",
        "baseUrl": "http://127.0.0.1:1234/v1",
        "priority": 30
      },
      {
        "name": "workstation",
        "baseUrl": "http://192.168.1.42:1234/v1",
        "apiKey": "lm-studio",
        "priority": 70,
        "timeoutMs": 600000
      }
    ]
  }
}
```

The workstation has higher priority so any model both boxes report routes
there. Users can still pin the laptop with `lmstudio:laptop/<model>`.

---

### `ollama` block

Same multi-instance dispatch model as LM Studio, with an extra wrinkle:
Ollama exposes BOTH an OpenAI-compatible surface (`/v1/*`) and its own
native API (`/api/*`). The native mode supports keep-alive, JSON mode, and
embeddings via `/api/embed`.

| Field | Type | Default | Constraint |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | — |
| `useNativeApi` | `boolean` | `false` | backend-level default |
| `instances` | `InstanceConfig[]` | `[]` | per-instance `name` must be unique |

**Mode resolution (per-instance overrides backend default).** For each
instance, the effective mode is:

```
native = (instance.useNativeApi === null) ? backend.useNativeApi : instance.useNativeApi
```

Truth table:

| Backend default | Instance flag | Effective mode |
| --- | --- | --- |
| `false` | `null` | compat |
| `false` | `true` | native |
| `false` | `false` | compat |
| `true` | `null` | native |
| `true` | `true` | native |
| `true` | `false` | compat |

Resolution happens once at constructor time — flipping the mode at runtime
requires a server restart.

**Server registration rule.** Same as LM Studio: only registered when
`ollama.enabled && ollama.instances.length > 0`.

**Default port.** Ollama listens on `11434`. The native API uses `/api/*`;
the compat API uses `/v1/*`. Both are exposed by the same daemon, so the
`baseUrl` doesn't need a `/v1` suffix when running in native mode.

**Default: one local instance in compat mode:**

```json
{
  "ollama": {
    "enabled": true,
    "useNativeApi": false,
    "instances": [
      {
        "name": "local",
        "baseUrl": "http://127.0.0.1:11434",
        "priority": 40,
        "timeoutMs": 300000,
        "useNativeApi": null
      }
    ]
  }
}
```

**All instances in native mode:**

```json
{
  "ollama": {
    "enabled": true,
    "useNativeApi": true,
    "instances": [
      { "name": "local", "baseUrl": "http://127.0.0.1:11434", "useNativeApi": null }
    ]
  }
}
```

**Mixed mode (one compat, one native):**

```json
{
  "ollama": {
    "enabled": true,
    "useNativeApi": false,
    "instances": [
      {
        "name": "local-compat",
        "baseUrl": "http://127.0.0.1:11434",
        "useNativeApi": null
      },
      {
        "name": "remote-native",
        "baseUrl": "http://10.0.0.50:11434",
        "useNativeApi": true,
        "priority": 60
      }
    ]
  }
}
```

The local instance inherits the backend default (compat); the remote one
overrides to native.

---

### `router` block

Cross-backend routing knobs.

| Field | Type | Default |
| --- | --- | --- |
| `defaultBackend` | enum | `"claude"` |
| `localProbeIntervalMs` | `int` | `60000` (60 s) |
| `thresholds.opusPromptTokens` | `int` | `50000` |
| `thresholds.opusToolCount` | `int` | `5` |
| `thresholds.sonnetPromptTokens` | `int` | `5000` |
| `reasoningEffortMap.claude` | `{ low, medium, high } -> model id` | `haiku-4-5 / sonnet-4-6 / opus-4-7` |
| `reasoningEffortMap.gemini` | same | `flash-lite / flash / pro` |
| `reasoningEffortMap.lmstudio` | same | `{}` |
| `reasoningEffortMap.ollama` | same | `{}` |

**`defaultBackend`.** Used when the request has no `model` field or the
model is the `"auto"` sentinel. Allowed values: `"claude"`, `"gemini"`,
`"lmstudio"`, `"ollama"`.

**`localProbeIntervalMs`.** Local backends (LM Studio, Ollama) are re-probed
on this cadence so models loaded at runtime show up in `/admin/backends`
without a server restart. Cloud CLIs (Claude, Gemini) are probed once at
startup.

The current implementation has no re-entrancy guard. 60s is comfortable;
setting this much lower without changing the probe code can cause
overlapping probes (the later one wins). See [Operations Guide /
Performance considerations](operations-guide.md#performance-considerations).

**`thresholds`.** Reserved for the heuristic auto-pick path (Plan 13). Not
all shims use these today — they're written so that future router work has
a stable place to read from.

**`reasoningEffortMap`.** When a client sends a request with a
`reasoning_effort` hint of `low | medium | high`, the router looks up the
model id in `reasoningEffortMap[backend][effort]`. Empty record means the
hint is ignored and the request's literal `model` field is used. The
defaults give Claude and Gemini sensible fallbacks; LM Studio and Ollama
are empty because operator-loaded models have no canonical names.

```json
{
  "router": {
    "defaultBackend": "claude",
    "localProbeIntervalMs": 60000,
    "thresholds": {
      "opusPromptTokens": 50000,
      "opusToolCount": 5,
      "sonnetPromptTokens": 5000
    },
    "reasoningEffortMap": {
      "claude": {
        "low": "claude-haiku-4-5",
        "medium": "claude-sonnet-4-6",
        "high": "claude-opus-4-7"
      },
      "gemini": {
        "low": "gemini-flash-lite",
        "medium": "gemini-flash",
        "high": "gemini-pro"
      },
      "lmstudio": {
        "low": "qwen3-coder-1.5b",
        "medium": "qwen3-coder-7b",
        "high": "qwen3-coder-30b"
      },
      "ollama": {}
    }
  }
}
```

---

### `files` block

Content-addressed file store backing `/v1/files/*` (Anthropic) and
`/v1beta/files` (Gemini). Files are de-duped by SHA-256 — two uploads of
the same bytes land at the same id.

| Field | Type | Default | Constraint |
| --- | --- | --- | --- |
| `dir` | `string` | `"data/files"` | any writable path |
| `ttlMs` | `int` | `604800000` (7 days) | `> 0` |
| `maxTotalBytes` | `int` | `5368709120` (5 GiB) | `> 0` |

**`dir`.** A directory the server can `mkdir -p` on startup. Relative
paths are relative to `process.cwd()`, not the config file. Use absolute
paths in production.

**`ttlMs`.** Time-since-last-access window. A file is eligible for eviction
when `Date.now() - lastAccessedAt > ttlMs`.

**`maxTotalBytes`.** After the TTL sweep, if the total bytes on disk still
exceed this, the store evicts LRU until it's under cap. Sweeps run every
5 minutes (hard-coded; configurable via the FileStore option but not via
config).

```json
{
  "files": {
    "dir": "/var/lib/claude-mcp/files",
    "ttlMs": 2592000000,
    "maxTotalBytes": 10737418240
  }
}
```

(30-day TTL, 10 GiB cap)

---

### `cache` block

Response cache for prompts marked with `cache_control: {type: "ephemeral"}`
on the Anthropic shim. Keyed by a canonicalized hash of
`{backendId, resolvedModel, system, cacheablePrefix, tail, tools, toolChoice}`.

| Field | Type | Default | Constraint |
| --- | --- | --- | --- |
| `file` | `string` | `"data/response-cache.json"` | any writable path |
| `ttlMs` | `int` | `3600000` (1 h) | `> 0` |
| `maxEntries` | `int` | `500` | `> 0` |

**`file`.** A JSON file (one entry per line, atomically rewritten on every
write). Disk-backed so cache survives server restarts. The directory is
created on first write.

**`ttlMs`.** Per-entry creation lifetime; expired entries are dropped
lazily on the next `get`.

**`maxEntries`.** LRU eviction triggers when `entries.size > maxEntries`.
Eviction sorts by `lastAccessedAt` ascending.

```json
{
  "cache": {
    "file": "data/response-cache.json",
    "ttlMs": 86400000,
    "maxEntries": 2000
  }
}
```

(24-hour TTL, 2000 entries)

---

### `archive` block

SQLite store of every completed request/response. Bodies are zstd-compressed.

| Field | Type | Default | Constraint |
| --- | --- | --- | --- |
| `dbPath` | `string` | `"data/archive.sqlite"` | any writable path |
| `compressionLevel` | `int` | `3` | `1 <= x <= 22` |

**`dbPath`.** The SQLite file. Created on startup if absent; uses WAL
journaling. Two sidecar files (`-wal`, `-shm`) appear next to it.

**`compressionLevel`.** zstd level. Higher = smaller bodies, more CPU per
write. Default `3` matches zstd's own default. Range `1..22`. Until the
deferred-items fix sprint, this field was parsed but ignored — every entry
was written at the node:zlib zstd default regardless of config. Now it's
honored end-to-end.

```json
{
  "archive": {
    "dbPath": "/var/lib/claude-mcp/archive.sqlite",
    "compressionLevel": 9
  }
}
```

(Higher compression — useful when archive size is a concern.)

---

### `embeddings` block

Legacy escape hatch for the original ClaudeMCP's OpenAI-proxy embeddings.
When `legacyBackendUrl` is non-empty, `/v1/embeddings` bypasses the backend
registry entirely and forwards the request body to the legacy URL.

| Field | Type | Default | Constraint |
| --- | --- | --- | --- |
| `legacyBackendUrl` | `string` | `""` | — |
| `legacyApiKey` | `string` | `""` | — |
| `legacyTimeoutMs` | `int` | `30000` (30 s) | `> 0` |

**`legacyBackendUrl`.** Full URL to an OpenAI-compat server's root (no
`/v1` suffix — the handler appends `/v1/embeddings`). When empty, the
embeddings handler resolves a backend via the registry as normal.

**`legacyApiKey`.** Sent as `Authorization: Bearer <key>` to the legacy
backend. Empty string = no auth header.

**`legacyTimeoutMs`.** Wraps the upstream fetch in `AbortSignal.timeout`.
On timeout the handler returns 504.

```json
{
  "embeddings": {
    "legacyBackendUrl": "http://127.0.0.1:1234",
    "legacyApiKey": "sk-legacy-...",
    "legacyTimeoutMs": 60000
  }
}
```

Set all three fields back to defaults (`""` / `""` / `30000`) to disable
the legacy proxy and let the OpenAI-shim embeddings handler use the
registry like every other endpoint.

---

### `adminUi` block

Local web admin SPA (Plan 12) and its session cookie.

| Field | Type | Default | Constraint |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | — |
| `bindLocalhost` | `boolean` | `true` | — |
| `sessionTtlMs` | `int` | `3600000` (1 h) | `> 0` |

**`enabled`.** When `false`, the `/admin/ui/*` static-asset routes are not
mounted. JSON `/admin/*` endpoints still work — only the SPA is hidden.

**`bindLocalhost`.** When `true`, every `/admin/*` request (UI assets,
JSON endpoints, archive viewer) is rejected with HTTP 403 unless its
`req.ip` is `127.0.0.1`, `::1`, or `::ffff:127.0.0.1`. This is the default
and SHOULD stay enabled unless you're putting a TLS+auth proxy in front.

If you're behind a reverse proxy, you also need
`app.set("trust proxy", true)` for `req.ip` to reflect the original
client. The default bootstrap does NOT enable trust-proxy. See
[Operations Guide / Troubleshooting](operations-guide.md#troubleshooting).

**`sessionTtlMs`.** Cookie lifetime. Set on the cookie's `Max-Age`
attribute as `Math.floor(sessionTtlMs / 1000)`. Sweeper runs every 60s
(hard-coded) to evict expired tokens from the in-process map.

```json
{
  "adminUi": {
    "enabled": true,
    "bindLocalhost": true,
    "sessionTtlMs": 86400000
  }
}
```

(24-hour session — convenient for daily ops use without re-login.)

**Exposing the admin UI beyond localhost.** Don't do this without TLS +
upstream auth. If you must:

```json
{ "adminUi": { "enabled": true, "bindLocalhost": false } }
```

The server prints a startup warning when `bindLocalhost` is `false`:

```
[startup] WARNING: config.adminUi.bindLocalhost=false; the admin UI accepts
requests from any IP. This is a security concession — confirm intentional.
```

Run an SSH tunnel (`ssh -L 8899:127.0.0.1:8899 user@host`) and leave
`bindLocalhost: true` — that's the right answer for almost every case.

---

## Worked examples

### "I only want Claude"

Disable every other backend; the Claude CLI handles everything via the
Anthropic shim.

```json
{
  "apiKey": "sk-mcp-...",
  "claude": { "enabled": true },
  "gemini": { "enabled": false },
  "lmstudio": { "enabled": false },
  "ollama": { "enabled": false },
  "router": { "defaultBackend": "claude" }
}
```

Embeddings will return 404 — there's no embedding-capable backend
registered. If you need embeddings, point `embeddings.legacyBackendUrl`
at any OpenAI-compatible embedding server.

---

### "I have LM Studio on two boxes"

```json
{
  "apiKey": "sk-mcp-...",
  "lmstudio": {
    "enabled": true,
    "instances": [
      { "name": "local", "baseUrl": "http://127.0.0.1:1234/v1", "priority": 30 },
      { "name": "workstation", "baseUrl": "http://10.0.0.5:1234/v1", "priority": 70 }
    ]
  }
}
```

Higher-priority `workstation` wins for any model both boxes report. Client
can pin either with `lmstudio:local/<model>` or `lmstudio:workstation/<model>`.

---

### "I want Ollama in native mode"

Backend-level switch (every instance defaults to native):

```json
{
  "ollama": {
    "enabled": true,
    "useNativeApi": true,
    "instances": [
      { "name": "local", "baseUrl": "http://127.0.0.1:11434", "useNativeApi": null }
    ]
  }
}
```

Per-instance override (only the one instance is native):

```json
{
  "ollama": {
    "enabled": true,
    "useNativeApi": false,
    "instances": [
      { "name": "local", "baseUrl": "http://127.0.0.1:11434", "useNativeApi": true }
    ]
  }
}
```

Native mode enables `keep_alive` (hard-coded to `"5m"`), JSON mode via
`metadata.format = "json"`, and uses `/api/embed` (with a `/api/embeddings`
fallback) for embeddings.

---

### "I want to expose the admin UI beyond localhost"

```json
{
  "adminUi": { "enabled": true, "bindLocalhost": false }
}
```

DON'T do this directly — at minimum put TLS + an auth proxy in front
(Caddy, nginx, Cloudflare Access). The startup warning is a feature, not a
nag; it's the only thing reminding you that you've opened the panel up.

The better answer 95% of the time: leave `bindLocalhost: true` and use an
SSH tunnel:

```bash
ssh -L 8899:127.0.0.1:8899 user@your-server
# Then open http://127.0.0.1:8899/admin/ui in your local browser.
```

---

### "I'm migrating from the legacy OpenAI proxy"

If you had a legacy ClaudeMCP that proxied `/v1/embeddings` to an external
OpenAI-compatible server and you want to keep that path working unchanged:

```json
{
  "embeddings": {
    "legacyBackendUrl": "http://127.0.0.1:5000",
    "legacyApiKey": "sk-legacy-...",
    "legacyTimeoutMs": 60000
  }
}
```

The OpenAI-shim embeddings handler will forward every request body to
`http://127.0.0.1:5000/v1/embeddings` with the legacy bearer auth. To
switch to the registry-routed path later, set `legacyBackendUrl: ""` —
the field's emptiness is the toggle.

---

### "I want to allow LAN access from another machine"

Two parts: open the listening interface AND disable the localhost-only
guard. The first is a startup option; the second is config.

```bash
# Bind to all interfaces (see scripts/setup-lan-access.ps1 for the
# Windows firewall + bind-IP details).
npm start -- --config configs/default.json --port 8899
```

```json
{
  "apiKey": "sk-mcp-...",
  "adminUi": { "enabled": true, "bindLocalhost": false }
}
```

Again — put TLS + upstream auth in front, or use an SSH tunnel.

---

### "I want longer-lived archive entries and tighter compression"

```json
{
  "archive": {
    "dbPath": "/var/lib/claude-mcp/archive.sqlite",
    "compressionLevel": 19
  }
}
```

`compressionLevel: 19` is slow on writes but produces noticeably smaller
blobs. Pruning is a separate operator concern — see the archive-prune
script in [Operations Guide / Archive](operations-guide.md#archive).

---

## Follow-ups

- The `reprobe?instance=<id>` admin endpoint accepts a per-instance query
  param, validates it, and then reports `_meta.reprobeScope: "all"` — the
  underlying registry probe is still backend-level. Slated for promotion
  to a real per-instance probe in a follow-on plan.
- Two `archive` request-hash schemes exist in the codebase: the Anthropic
  shim uses a cache-key-derived hash; the OpenAI and Gemini shims use a
  SHA-256 of the canonicalized request via `src/admin/recordCompletion.ts`.
  Unification flagged for a future cleanup.
- The `responseCache` cap is `maxEntries`-only; there is no bytes cap on
  the persisted JSON file. Large cached payloads (long completions) can
  bloat `data/response-cache.json` past comfort. A bytes cap is a
  reasonable follow-on if your workload triggers it.
- `localProbeIntervalMs` has no re-entrancy guard. Don't set it lower
  than the time a probe takes; rapid overlapping probes will rebuild the
  model map non-deterministically.
- LM Studio and Ollama backends are registered ONLY when their
  `instances[]` array is non-empty AND `enabled: true`. Documented above
  but worth restating: an empty array means "no backend at all" even when
  `enabled: true`.
