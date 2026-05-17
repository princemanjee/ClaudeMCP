# Deployment Guide

Get a fresh machine running the ClaudeMCP server end-to-end. For what to change in `configs/*.json`, see the [Configuration Guide](configuration-guide.md). For running the resulting server, see the [User Manual](user-manual.md).

## Prerequisites

### Node.js 22 or later

The archive subsystem uses the `zstdCompressSync` / `zstdDecompressSync` exports of `node:zlib`, which landed in Node 22. Older Node versions will fail at first archive write.

```bash
node --version
# Should print v22.x.x or higher
```

If you need to install or upgrade Node, use [nvm](https://github.com/nvm-sh/nvm) on macOS/Linux or [nvm-windows](https://github.com/coreybutler/nvm-windows) on Windows. A direct installer from [nodejs.org](https://nodejs.org/) also works.

### At least one backend

ClaudeMCP is useful only with at least one backend reachable. Enable any combination of the four:

- **Claude CLI** — `claude` binary on `PATH`, authenticated to a Claude Max (or any) subscription. Install via [Anthropic's Claude Code docs](https://docs.claude.com/en/docs/claude-code). Verify with `claude --version`. The server reuses your existing login session on disk; no extra API key needed.
- **Gemini CLI** — `gemini` binary on `PATH`, authenticated to a Google account. Install via [Google's gemini-cli docs](https://github.com/google-gemini/gemini-cli). Verify with `gemini --version`. Same auth model as Claude: rides your existing CLI login.
- **LM Studio** — desktop app running with the OpenAI-compatible server enabled. Default port `1234`. Toggle the server from LM Studio's "Local Server" tab. Install from [lmstudio.ai](https://lmstudio.ai/).
- **Ollama** — daemon running on default port `11434`. Install from [ollama.com](https://ollama.com/). Verify with `curl http://127.0.0.1:11434/api/tags`. Both the native `/api/*` and OpenAI-compatible `/v1/*` modes are supported; pick per instance.

You can run the server with only one backend enabled and the others marked `"enabled": false` in config. The registry simply won't try to route to disabled backends.

### Build dependencies (dev only)

For source builds (`npm run build`), TypeScript 5+ is needed but `npm install` pulls it as a devDependency. `better-sqlite3` builds a native module; prebuilt binaries ship for Windows x64, macOS arm64, and Linux x64. If you hit a build error there, ensure you have a working C++ toolchain installed (Visual Studio Build Tools on Windows, Xcode CLT on macOS, `build-essential` on Linux).

## Platforms

| Platform | Status |
| --- | --- |
| Windows 11 (x64) | Supported and tested |
| macOS (Apple Silicon, arm64) | Supported |
| Linux (x64) | Should work — Node and all four CLI/HTTP backends run natively. Not explicitly tested in CI. |

The codebase has no per-OS branches. All native deps ship prebuilts for the three platforms.

## Install

```bash
git clone <repo-url> ClaudeMCP
cd ClaudeMCP
npm install
```

The `npm install` step compiles or downloads a prebuilt of `better-sqlite3` for your platform-arch. If you see a native-module build failure, check the prerequisites note above on the C++ toolchain. The rest of the deps are pure JS / TypeScript.

Optional sanity check after install:

```bash
npm run typecheck
npm test
```

The full test suite (862 tests across 70 files) runs in ~5 seconds on a modern laptop and does not require any backend to be installed — it uses mock fixtures.

## Configure

1. Copy the annotated example into the default location:

   ```bash
   cp configs/example.json configs/default.json
   ```

   (Or place the file anywhere and point at it with `--config <path>` later.)

2. Open `configs/default.json` and edit:

   - **`apiKey`** — replace `"CHANGE-ME-BEFORE-USE"` with a strong random value. Generate one with:

     ```bash
     # macOS / Linux
     openssl rand -hex 32

     # Windows PowerShell
     -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
     ```

     This single key is required on every HTTP call. Clients send it as `x-api-key`, `Authorization: Bearer <key>`, `x-goog-api-key`, or `?key=<key>` — whichever convention the wire format expects.

   - **`claude.enabled`, `gemini.enabled`, `lmstudio.enabled`, `ollama.enabled`** — set `false` for any backend you don't intend to use. Default is `true` for all four.

   - **`lmstudio.instances[].baseUrl`** — confirm it matches your local LM Studio server. Default: `http://127.0.0.1:1234/v1`.

   - **`ollama.instances[].baseUrl`** — confirm it matches your Ollama daemon. Default: `http://127.0.0.1:11434`.

3. Every other field has a sensible default. For the full field reference, see the [Configuration Guide](configuration-guide.md).

## First run

```bash
npx tsx src/bin.ts --config configs/default.json --port 8899
```

This runs the server directly from TypeScript via `tsx`. On success you should see:

```
ClaudeMCP listening on http://127.0.0.1:8899
```

If you omit `--port`, the default is `3210`. For a compiled production-style run, do `npm run build` first and then `node dist/bin.js --config configs/default.json --port 8899`. The `npm start` script wires that up but without the `--port` flag.

The server takes `SIGINT` and `SIGTERM` for graceful shutdown — `Ctrl-C` flushes the file store, closes the SQLite archive, and stops in-flight HTTP cleanly.

## Verify the install

With the server running, in a second shell:

```bash
# 1. Health check — no auth needed
curl http://127.0.0.1:8899/health
# {"status":"ok"}

# 2. Model catalog (OpenAI envelope) — requires the apiKey
curl -H "x-api-key: YOUR-API-KEY" http://127.0.0.1:8899/v1/models
# {"object":"list","data":[ ...one entry per discovered model... ]}

# 3. Same catalog in Anthropic envelope
curl -H "x-api-key: YOUR-API-KEY" http://127.0.0.1:8899/v1/anthropic/models

# 4. Same catalog in Gemini envelope (Google sends the key in a different header)
curl -H "x-goog-api-key: YOUR-API-KEY" http://127.0.0.1:8899/v1beta/models
```

The model lists are populated by probing each enabled backend at startup and then on a `router.localProbeIntervalMs` interval (60 s default). If a list comes back empty, the corresponding backend probe failed — check that the relevant CLI is on `PATH` or the relevant HTTP daemon is reachable.

Then open the admin UI in a browser:

```
http://127.0.0.1:8899/admin/ui
```

Log in with the `apiKey` you set. The Dashboard panel should render with the backend health summary. If you see a 403 instead, the request is being treated as non-localhost — check that you are hitting `127.0.0.1` and not the machine's LAN IP (see the Hardening section for how to expose beyond localhost).

A minimal end-to-end smoke call against the Anthropic surface, assuming the Claude CLI is enabled and authenticated:

```bash
curl -X POST http://127.0.0.1:8899/v1/messages \
  -H "x-api-key: YOUR-API-KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "sonnet",
    "max_tokens": 64,
    "messages": [{"role": "user", "content": "Reply with the single word: ok"}]
  }'
```

Expect a JSON Anthropic Messages response with a `content` array.

## Running as a long-lived service

The server has no built-in daemonization or restart-on-crash. Use the platform's native service manager.

### Windows — NSSM

[NSSM](https://nssm.cc/) wraps any executable as a Windows service. After installing nssm.exe somewhere on `PATH`:

```powershell
# Install — opens a dialog. Set:
#   Path:             C:\Program Files\nodejs\node.exe
#   Startup directory: C:\path\to\ClaudeMCP
#   Arguments:         dist\bin.js --config configs\default.json --port 8899
nssm install ClaudeMCP

# Logs — redirect stdout/stderr to files
nssm set ClaudeMCP AppStdout C:\path\to\ClaudeMCP\logs\stdout.log
nssm set ClaudeMCP AppStderr C:\path\to\ClaudeMCP\logs\stderr.log
nssm set ClaudeMCP AppRotateFiles 1
nssm set ClaudeMCP AppRotateBytes 10485760

# Start
nssm start ClaudeMCP
```

The build step (`npm run build`) must have been run once so `dist/bin.js` exists. Schedule a rebuild whenever you `git pull`.

### Windows — Task Scheduler (no extra deps)

`schtasks` can also run the server on user login or at boot:

```powershell
schtasks /Create /SC ONSTART /RU SYSTEM /TN ClaudeMCP `
  /TR 'cmd /c \"cd /d C:\path\to\ClaudeMCP && node dist\bin.js --config configs\default.json --port 8899 >> logs\stdout.log 2>> logs\stderr.log\"'
```

NSSM is preferred because it handles auto-restart on crash; Task Scheduler does not.

### macOS — launchd

Create `~/Library/LaunchAgents/com.local.claudemcp.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.local.claudemcp</string>
  <key>WorkingDirectory</key>
  <string>/Users/you/code/ClaudeMCP</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>dist/bin.js</string>
    <string>--config</string>
    <string>configs/default.json</string>
    <string>--port</string>
    <string>8899</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/you/code/ClaudeMCP/logs/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/code/ClaudeMCP/logs/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

The `PATH` entry matters — `launchd` does not inherit your shell `PATH`, so `claude` and `gemini` won't be findable unless their install location is listed. On Apple Silicon Homebrew installs to `/opt/homebrew/bin`. Adjust the absolute path to `node` for your install method.

Load and start:

```bash
launchctl load  ~/Library/LaunchAgents/com.local.claudemcp.plist
launchctl start com.local.claudemcp
```

Unload with `launchctl unload <path>`.

### Linux — systemd

Create `/etc/systemd/system/claudemcp.service`:

```ini
[Unit]
Description=ClaudeMCP local LLM gateway
After=network.target

[Service]
Type=simple
User=you
WorkingDirectory=/home/you/code/ClaudeMCP
ExecStart=/usr/bin/node dist/bin.js --config configs/default.json --port 8899
Restart=on-failure
RestartSec=5
# Inherit user PATH so claude / gemini are findable
Environment=PATH=/home/you/.local/bin:/usr/local/bin:/usr/bin:/bin
StandardOutput=append:/home/you/code/ClaudeMCP/logs/stdout.log
StandardError=append:/home/you/code/ClaudeMCP/logs/stderr.log

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claudemcp
sudo systemctl status claudemcp
```

View logs with `journalctl -u claudemcp -f` (in addition to the file paths above).

### Persistent state and backups

Regardless of platform, the server's only on-disk state lives under the configured paths (defaults shown):

| Path | Purpose | Survives restart |
| --- | --- | --- |
| `data/files/` | File store contents (uploads from `/v1/files` and `/v1beta/files`) | Yes (subject to `files.ttlMs` / `files.maxTotalBytes`) |
| `data/response-cache.json` | Response cache (mirror of in-memory) | Yes |
| `data/archive.sqlite` | SQLite archive of request/response pairs | Yes |
| `data/sessions.json` | Admin UI session tokens | Yes (subject to `adminUi.sessionTtlMs`) |
| `logs/` | stdout/stderr if you redirect there | Yes |

Everything is under the project root by default (each path is configurable). If the archive matters for your auditing or debugging, back up `data/archive.sqlite` on whatever schedule you'd back up any SQLite file (`sqlite3 archive.sqlite ".backup '/somewhere/archive-$(date +%F).sqlite'"` is fine since the DB is opened in WAL-friendly mode by `better-sqlite3`).

## Production hardening notes

This server is designed for **personal use or trusted local deployments**. It is explicitly not a multi-tenant or public-internet gateway (see the design spec non-goals). With that scope in mind:

- **API key rotation.** Edit `apiKey` in the config file and restart the process, OR `PATCH /admin/config` via the admin UI (the live-edit path applies to new requests immediately; in-flight requests keep using the old key until they finish). After a config-file edit, restart for clean state.

- **Localhost binding.** `adminUi.bindLocalhost: true` (the default) rejects any admin UI request whose remote address is not `127.0.0.1` / `::1` with a 403. The non-admin HTTP surface (`/v1/*`, `/v1beta/*`) is gated only by the shared `apiKey`. To expose the server beyond localhost:

  1. Set `adminUi.bindLocalhost: false` only if you also intend to expose the admin UI — and only behind a reverse proxy with TLS and additional auth.
  2. Bind the Node process behind a reverse proxy (nginx, Caddy, Cloudflare Tunnel) that terminates TLS. Do not point the process directly at `0.0.0.0` on a public interface.
  3. On Windows, the helper scripts `scripts/setup-lan-access.ps1` and `scripts/remove-lan-access.ps1` configure `netsh portproxy` + a firewall rule for LAN-only exposure on port 8899. They are LAN scope; they are not a substitute for TLS on a public network.

- **What this server does NOT have.** No rate limiting. No per-user quotas. No per-request auth (the apiKey is shared across all clients). No audit log of admin config edits. These are intentional non-goals — adopt accordingly for any deployment beyond your laptop.

## Upgrading

```bash
git pull
npm install
npm run build   # only if you run from dist/
# restart the service
```

Configuration is forward-compatible by convention (new fields land with defaults, old fields keep working). Schema migrations for the SQLite archive are **not** automatic. If a future plan changes the archive schema, the documented escape hatch (per the design spec) is to delete `data/archive.sqlite` and let the server recreate it on next boot. The archive is debug/audit-only — no live request path depends on its contents.

If you run `npm run test` after upgrading and the suite fails on `tests/compat/`, your installed SDK majors may have drifted; `npm install` against the pinned `package-lock.json` should resolve that.
