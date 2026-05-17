# ClaudeMCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCP-over-SSE server that wraps the `claude` CLI so external tools (Agent Zero) can reuse a Claude Max subscription instead of paying for API access.

**Architecture:** One Node.js/TypeScript process running Express + MCP-over-SSE. Two MCP tools (`claude_ask` stateless, `claude_task` stateful) route through one shared `claudeRunner` that spawns `claude -p`. A file-backed session store survives restarts; a JSON-lines logger records every call with reply tracking. One module per responsibility; `claudeRunner.ts` is the only file that touches the CLI.

**Tech Stack:** Node.js 20+, TypeScript 5, `@modelcontextprotocol/sdk`, Express 4, Zod, Vitest, `tree-kill`, `uuid`. Host OS is Windows 11.

**Spec:** `docs/superpowers/specs/2026-04-18-claude-mcp-design.md`

---

## Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claude-mcp",
  "version": "0.1.0",
  "description": "MCP-over-SSE server wrapping the Claude Code CLI",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/bin.ts --config configs/default.json",
    "start": "node dist/bin.js --config configs/default.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.4",
    "cross-spawn": "^7.0.6",
    "express": "^4.21.1",
    "tree-kill": "^1.2.2",
    "uuid": "^11.0.3",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/cross-spawn": "^6.0.6",
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.0",
    "@types/uuid": "^10.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
logs/
data/
*.tmp
.env
.env.local
coverage/
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    hookTimeout: 15000,
    pool: "forks",
    poolOptions: { forks: { singleFork: false } },
  },
});
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: `node_modules/` populated, no error output (warnings about deprecated transitive deps are fine).

- [ ] **Step 6: Verify TypeScript builds empty project**

Run: `npx tsc --noEmit`
Expected: exits 0 with no output. (`src/` is empty so tsc has nothing to compile, which is OK.)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore vitest.config.ts
git commit -m "chore: scaffold Node/TypeScript project with Vitest"
```

---

## Task 2: Shared types

**Files:**
- Create: `src/types.ts`

Types live in one file because they are used across modules and changing them should be a single PR.

- [ ] **Step 1: Create `src/types.ts`**

```ts
export type SessionMode = "stateless" | "session" | "auto-last";

/**
 * Command used to spawn Claude. Either a single binary name that's resolved
 * via PATH (e.g. "claude"), or an array whose first element is the binary
 * and subsequent elements are prefix args (e.g. ["node", "./mock.mjs"]).
 * The array form is required for tests and for launchers that need an
 * interpreter in front of a script.
 */
export type ClaudeCommand = string | string[];

export type Config = {
  port: number;
  host: string;
  logFile: string;
  sessionStoreFile: string;
  claudeCommand: ClaudeCommand;
  ask: {
    timeoutMs: number;
    allowedTools: string;
  };
  task: {
    defaultSessionMode: SessionMode;
    defaultWorkDir: string;
    timeoutMs: number;
    allowedTools: string;
    dangerouslySkipPermissions: boolean;
    sessionTtlMs: number;
  };
};

export type SessionMeta = {
  sessionId: string;
  workDir: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
};

export type ClaudeRunOptions = {
  prompt: string;
  workDir?: string;
  resumeSessionId?: string;
  allowedTools?: string;
  dangerouslySkipPermissions?: boolean;
  timeoutMs: number;
  claudeCommand: ClaudeCommand;
};

export type ClaudeRunResult = {
  text: string;
  sessionId: string | null;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  stderr: string;
};

export type LogEntry = {
  timestamp: string;
  logId: string;
  inReplyToLogId?: string;
  tool: "claude_ask" | "claude_task";
  status: "success" | "error" | "timeout";
  durationMs: number;
  sessionId?: string;
  prompt: string;
  workDir?: string;
  allowedTools?: string;
  sessionMode?: SessionMode;
  output: string;
  outputTruncated?: boolean;
  containsQuestion: boolean;
  exitCode: number;
  error?: string;
};
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared type definitions"
```

---

## Task 3: Config module

**Files:**
- Create: `src/config.ts`
- Create: `configs/default.json`
- Create: `configs/example.json`
- Test: `tests/config.test.ts`

The config loader parses JSON, validates against a Zod schema, applies defaults, overlays env vars, and freezes the result.

- [ ] **Step 1: Write the failing tests**

Create `tests/config.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-mcp-config-"));
  delete process.env.CLAUDE_MCP_PORT;
  delete process.env.CLAUDE_MCP_HOST;
  delete process.env.CLAUDE_MCP_LOG_FILE;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CLAUDE_MCP_PORT;
  delete process.env.CLAUDE_MCP_HOST;
  delete process.env.CLAUDE_MCP_LOG_FILE;
});

function write(name: string, content: unknown): string {
  const path = join(tmpDir, name);
  writeFileSync(path, JSON.stringify(content), "utf8");
  return path;
}

describe("loadConfig", () => {
  test("parses a valid config and applies defaults for missing fields", () => {
    const path = write("c.json", {
      task: { defaultWorkDir: "C:/Code/scratch" },
    });
    const cfg = loadConfig(path);
    expect(cfg.port).toBe(3000);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.logFile).toBe("logs/activity.log");
    expect(cfg.sessionStoreFile).toBe("data/sessions.json");
    expect(cfg.claudeCommand).toBe("claude");
    expect(cfg.ask.timeoutMs).toBe(60000);
    expect(cfg.ask.allowedTools).toBe("");
    expect(cfg.task.defaultSessionMode).toBe("session");
    expect(cfg.task.defaultWorkDir).toBe("C:/Code/scratch");
    expect(cfg.task.timeoutMs).toBe(600000);
    expect(cfg.task.allowedTools).toBe("Read,Edit,Write,Bash,Glob,Grep");
    expect(cfg.task.dangerouslySkipPermissions).toBe(true);
    expect(cfg.task.sessionTtlMs).toBe(86400000);
  });

  test("honors user-provided values over defaults", () => {
    const path = write("c.json", {
      port: 4000,
      host: "0.0.0.0",
      task: {
        defaultWorkDir: "/tmp/work",
        defaultSessionMode: "stateless",
        dangerouslySkipPermissions: false,
      },
    });
    const cfg = loadConfig(path);
    expect(cfg.port).toBe(4000);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.task.defaultWorkDir).toBe("/tmp/work");
    expect(cfg.task.defaultSessionMode).toBe("stateless");
    expect(cfg.task.dangerouslySkipPermissions).toBe(false);
  });

  test("env vars override config values", () => {
    process.env.CLAUDE_MCP_PORT = "5555";
    process.env.CLAUDE_MCP_HOST = "0.0.0.0";
    process.env.CLAUDE_MCP_LOG_FILE = "/var/log/x.log";
    const path = write("c.json", {
      port: 3000,
      task: { defaultWorkDir: "C:/Code/scratch" },
    });
    const cfg = loadConfig(path);
    expect(cfg.port).toBe(5555);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.logFile).toBe("/var/log/x.log");
  });

  test("rejects invalid types with a clear error", () => {
    const path = write("c.json", { port: "not-a-number" });
    expect(() => loadConfig(path)).toThrow(/port/);
  });

  test("rejects unknown sessionMode", () => {
    const path = write("c.json", {
      task: { defaultSessionMode: "wacky", defaultWorkDir: "/x" },
    });
    expect(() => loadConfig(path)).toThrow();
  });

  test("returned config is frozen", () => {
    const path = write("c.json", {
      task: { defaultWorkDir: "/x" },
    });
    const cfg = loadConfig(path);
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.ask)).toBe(true);
    expect(Object.isFrozen(cfg.task)).toBe(true);
  });

  test("throws a clear error when file does not exist", () => {
    expect(() => loadConfig(join(tmpDir, "nope.json"))).toThrow(/nope\.json/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: All tests fail with errors about `loadConfig` being undefined / module not found.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import type { Config } from "./types.js";

const SessionModeSchema = z.enum(["stateless", "session", "auto-last"]);

const ConfigSchema = z.object({
  port: z.number().int().positive().default(3000),
  host: z.string().default("127.0.0.1"),
  logFile: z.string().default("logs/activity.log"),
  sessionStoreFile: z.string().default("data/sessions.json"),
  claudeCommand: z
    .union([z.string(), z.array(z.string()).nonempty()])
    .default("claude"),
  ask: z
    .object({
      timeoutMs: z.number().int().positive().default(60000),
      allowedTools: z.string().default(""),
    })
    .default({}),
  task: z
    .object({
      defaultSessionMode: SessionModeSchema.default("session"),
      defaultWorkDir: z.string().default("C:/Code/scratch"),
      timeoutMs: z.number().int().positive().default(600000),
      allowedTools: z.string().default("Read,Edit,Write,Bash,Glob,Grep"),
      dangerouslySkipPermissions: z.boolean().default(true),
      sessionTtlMs: z.number().int().positive().default(86400000),
    })
    .default({}),
});

function applyEnvOverrides(cfg: Config): Config {
  const portEnv = process.env.CLAUDE_MCP_PORT;
  const hostEnv = process.env.CLAUDE_MCP_HOST;
  const logEnv = process.env.CLAUDE_MCP_LOG_FILE;
  const storeEnv = process.env.CLAUDE_MCP_SESSION_STORE_FILE;
  const next: Config = {
    ...cfg,
    port: portEnv ? Number(portEnv) : cfg.port,
    host: hostEnv ?? cfg.host,
    logFile: logEnv ?? cfg.logFile,
    sessionStoreFile: storeEnv ?? cfg.sessionStoreFile,
  };
  if (portEnv && !Number.isFinite(next.port)) {
    throw new Error(`CLAUDE_MCP_PORT must be a number, got: ${portEnv}`);
  }
  return next;
}

export function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `Config file ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config at ${path}:\n${issues}`);
  }
  const withEnv = applyEnvOverrides(parsed.data as Config);
  Object.freeze(withEnv.ask);
  Object.freeze(withEnv.task);
  return Object.freeze(withEnv);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: all 7 tests pass.

- [ ] **Step 5: Create `configs/default.json`**

```json
{
  "port": 3000,
  "host": "127.0.0.1",
  "logFile": "logs/activity.log",
  "sessionStoreFile": "data/sessions.json",
  "claudeCommand": "claude",
  "ask": {
    "timeoutMs": 60000,
    "allowedTools": ""
  },
  "task": {
    "defaultSessionMode": "session",
    "defaultWorkDir": "C:/Code/scratch",
    "timeoutMs": 600000,
    "allowedTools": "Read,Edit,Write,Bash,Glob,Grep",
    "dangerouslySkipPermissions": true,
    "sessionTtlMs": 86400000
  }
}
```

- [ ] **Step 6: Create `configs/example.json`**

```json
{
  "_comments": {
    "port": "HTTP port for the SSE server",
    "host": "Bind address. Keep 127.0.0.1 unless you need LAN access",
    "logFile": "JSON-lines activity log path",
    "sessionStoreFile": "Where the file-backed session map is persisted",
    "claudeCommand": "Command used to spawn Claude Code. Override for tests or non-standard installs",
    "ask.timeoutMs": "Per-call timeout for claude_ask",
    "ask.allowedTools": "Comma-separated CLI allowlist. Empty string disables all tools (recommended for ask)",
    "task.defaultSessionMode": "stateless | session | auto-last. Used when caller omits sessionMode",
    "task.defaultWorkDir": "Directory Claude runs in when caller omits workDir",
    "task.timeoutMs": "Per-call timeout for claude_task",
    "task.allowedTools": "Comma-separated CLI allowlist. Ignored when dangerouslySkipPermissions is true",
    "task.dangerouslySkipPermissions": "If true, passes --dangerously-skip-permissions and omits --allowed-tools. MAX BLAST RADIUS",
    "task.sessionTtlMs": "Sessions untouched longer than this are evicted by the background sweeper"
  },
  "port": 3000,
  "host": "127.0.0.1",
  "logFile": "logs/activity.log",
  "sessionStoreFile": "data/sessions.json",
  "claudeCommand": "claude",
  "ask": {
    "timeoutMs": 60000,
    "allowedTools": ""
  },
  "task": {
    "defaultSessionMode": "session",
    "defaultWorkDir": "C:/Code/scratch",
    "timeoutMs": 600000,
    "allowedTools": "Read,Edit,Write,Bash,Glob,Grep",
    "dangerouslySkipPermissions": true,
    "sessionTtlMs": 86400000
  }
}
```

- [ ] **Step 7: Verify shipped default parses cleanly**

Run: `node --input-type=module -e "import('./src/config.ts').catch(()=>import('tsx/cjs').then(()=>require('./src/config.ts')));"` — skip; instead run a quick ad-hoc test:

Run: `npx tsx -e "import { loadConfig } from './src/config.ts'; const c = loadConfig('configs/default.json'); console.log('OK', c.port, c.task.defaultSessionMode);"`
Expected: prints `OK 3000 session`.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts tests/config.test.ts configs/default.json configs/example.json
git commit -m "feat: config loader with Zod validation and env overrides"
```

---

## Task 4: Logger

**Files:**
- Create: `src/logger.ts`
- Test: `tests/logger.test.ts`

The logger appends one JSON object per line to `logFile`. Writes go through an async queue so concurrent callers never interleave bytes. Output is truncated to 10 KB at a UTF-8 character boundary. `containsQuestion` is a heuristic over the output text.

- [ ] **Step 1: Write the failing tests**

Create `tests/logger.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Logger,
  containsQuestionHeuristic,
  truncateUtf8,
} from "../src/logger.js";

let tmpDir: string;
let logFile: string;
let logger: Logger;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-mcp-log-"));
  logFile = join(tmpDir, "a.log");
  logger = new Logger(logFile);
});

afterEach(async () => {
  await logger.flush();
  rmSync(tmpDir, { recursive: true, force: true });
});

function readLines(): Record<string, unknown>[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("Logger", () => {
  test("writes one JSON-lines entry with all fields", async () => {
    await logger.log({
      timestamp: "2026-04-18T00:00:00.000Z",
      logId: "id-1",
      tool: "claude_ask",
      status: "success",
      durationMs: 100,
      prompt: "hello",
      output: "hi",
      containsQuestion: false,
      exitCode: 0,
    });
    await logger.flush();
    const lines = readLines();
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({
      logId: "id-1",
      tool: "claude_ask",
      output: "hi",
    });
  });

  test("preserves order under concurrent writes", async () => {
    const count = 50;
    await Promise.all(
      Array.from({ length: count }).map((_, i) =>
        logger.log({
          timestamp: new Date().toISOString(),
          logId: `id-${i}`,
          tool: "claude_ask",
          status: "success",
          durationMs: 1,
          prompt: `p-${i}`,
          output: `o-${i}`,
          containsQuestion: false,
          exitCode: 0,
        }),
      ),
    );
    await logger.flush();
    const lines = readLines();
    expect(lines.length).toBe(count);
    for (let i = 0; i < count; i++) {
      expect(lines[i]?.logId).toBe(`id-${i}`);
    }
  });

  test("creates parent directory if missing", async () => {
    const nested = join(tmpDir, "nested", "deep", "a.log");
    const l = new Logger(nested);
    await l.log({
      timestamp: "t",
      logId: "x",
      tool: "claude_ask",
      status: "success",
      durationMs: 0,
      prompt: "",
      output: "",
      containsQuestion: false,
      exitCode: 0,
    });
    await l.flush();
    expect(existsSync(nested)).toBe(true);
  });
});

describe("truncateUtf8", () => {
  test("returns input unchanged when within limit", () => {
    const r = truncateUtf8("hello", 100);
    expect(r.text).toBe("hello");
    expect(r.truncated).toBe(false);
  });

  test("truncates long ascii to requested byte length", () => {
    const input = "a".repeat(5000);
    const r = truncateUtf8(input, 100);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(100);
  });

  test("does not split a multi-byte character", () => {
    // "😀" is 4 bytes in UTF-8. Truncating a 25-char run to 10 bytes
    // must not produce a partial code unit.
    const input = "😀".repeat(25);
    const r = truncateUtf8(input, 10);
    expect(r.truncated).toBe(true);
    // Decoded text must be valid UTF-8 (round-trips cleanly)
    const roundTrip = Buffer.from(r.text, "utf8").toString("utf8");
    expect(roundTrip).toBe(r.text);
    // Must contain only whole emoji characters, no replacement chars
    expect(r.text).not.toContain("\uFFFD");
  });
});

describe("containsQuestionHeuristic", () => {
  test("trimmed output ending with '?' counts as question", () => {
    expect(containsQuestionHeuristic("Which file?  ")).toBe(true);
    expect(containsQuestionHeuristic("done.")).toBe(false);
  });

  test("recognizes documented phrases case-insensitively", () => {
    for (const p of [
      "which do you want to use",
      "Should I proceed.",
      "do you want me to continue",
      "Please clarify what you mean",
      "can you tell me more",
    ]) {
      expect(containsQuestionHeuristic(p)).toBe(true);
    }
  });

  test("ignores question-like phrases inside unrelated sentences", () => {
    expect(containsQuestionHeuristic("Refactored auth module")).toBe(false);
    expect(containsQuestionHeuristic("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/logger.test.ts`
Expected: all tests fail with module-not-found.

- [ ] **Step 3: Implement `src/logger.ts`**

```ts
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogEntry } from "./types.js";

const MAX_OUTPUT_BYTES = 10 * 1024;
const QUESTION_PHRASES = [
  "which do you",
  "should i",
  "do you want",
  "please clarify",
  "can you tell me",
];

export function truncateUtf8(
  input: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(input, "utf8");
  if (buf.byteLength <= maxBytes) {
    return { text: input, truncated: false };
  }
  // Walk back from maxBytes until we land on a code-point boundary.
  // UTF-8 continuation bytes match 10xxxxxx (0x80..0xBF).
  let end = maxBytes;
  while (end > 0 && (buf[end] !== undefined) && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

export function containsQuestionHeuristic(output: string): boolean {
  const trimmed = output.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.endsWith("?")) return true;
  const lower = trimmed.toLowerCase();
  return QUESTION_PHRASES.some((p) => lower.includes(p));
}

export class Logger {
  private queue: Promise<void> = Promise.resolve();
  private dirEnsured = false;

  constructor(private readonly logFile: string) {}

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(dirname(this.logFile), { recursive: true });
    this.dirEnsured = true;
  }

  log(entry: LogEntry): Promise<void> {
    // Truncation happens before enqueue so callers can see the final form
    // in tests via readback. Mutates a copy, not the caller's object.
    const truncated = truncateUtf8(entry.output ?? "", MAX_OUTPUT_BYTES);
    const toWrite: LogEntry = {
      ...entry,
      output: truncated.text,
      ...(truncated.truncated ? { outputTruncated: true } : {}),
    };
    this.queue = this.queue.then(async () => {
      await this.ensureDir();
      await appendFile(this.logFile, JSON.stringify(toWrite) + "\n", "utf8");
    });
    return this.queue;
  }

  flush(): Promise<void> {
    return this.queue;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/logger.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/logger.ts tests/logger.test.ts
git commit -m "feat: JSON-lines logger with write queue and UTF-8-safe truncation"
```

---

## Task 5: Session store

**Files:**
- Create: `src/sessionStore.ts`
- Test: `tests/sessionStore.test.ts`

File-backed `Map<sessionId, SessionMeta>`. Atomic writes. Per-session mutex. TTL eviction.

- [ ] **Step 1: Write the failing tests**

Create `tests/sessionStore.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/sessionStore.js";

let tmpDir: string;
let storeFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-mcp-store-"));
  storeFile = join(tmpDir, "sessions.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  test("starts empty when file does not exist", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    expect(s.getMostRecent()).toBe(null);
    expect(s.size()).toBe(0);
  });

  test("create adds entry and persists to disk", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    await s.create("abc", "/work");
    const persisted = JSON.parse(readFileSync(storeFile, "utf8"));
    expect(persisted.abc).toMatchObject({
      sessionId: "abc",
      workDir: "/work",
      turnCount: 0,
    });
  });

  test("update bumps turnCount and lastUsedAt", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    await s.create("abc", "/work");
    const beforeUpdate = s.get("abc")!.lastUsedAt;
    // Force a clock tick so timestamps differ
    await new Promise((r) => setTimeout(r, 5));
    await s.update("abc");
    const after = s.get("abc")!;
    expect(after.turnCount).toBe(1);
    expect(after.lastUsedAt > beforeUpdate).toBe(true);
  });

  test("getMostRecent returns the entry with the latest lastUsedAt", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    await s.create("a", "/w");
    await new Promise((r) => setTimeout(r, 5));
    await s.create("b", "/w");
    await new Promise((r) => setTimeout(r, 5));
    await s.update("a");
    const latest = s.getMostRecent();
    expect(latest?.sessionId).toBe("a");
  });

  test("evictExpired removes entries older than TTL", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    await s.create("old", "/w");
    await new Promise((r) => setTimeout(r, 20));
    await s.create("new", "/w");
    const evicted = await s.evictExpired(15);
    expect(evicted).toBe(1);
    expect(s.get("old")).toBe(null);
    expect(s.get("new")?.sessionId).toBe("new");
  });

  test("load recovers state across instances", async () => {
    const s1 = new SessionStore(storeFile);
    await s1.load();
    await s1.create("keep", "/w");
    const s2 = new SessionStore(storeFile);
    await s2.load();
    expect(s2.get("keep")?.sessionId).toBe("keep");
  });

  test("load returns empty on corrupted file", async () => {
    writeFileSync(storeFile, "{ this is not json", "utf8");
    const s = new SessionStore(storeFile);
    await s.load();
    expect(s.size()).toBe(0);
  });

  test("load ignores stale tmp file", async () => {
    writeFileSync(storeFile + ".tmp", "stale", "utf8");
    const s = new SessionStore(storeFile);
    await s.load();
    expect(existsSync(storeFile + ".tmp")).toBe(true);
    expect(s.size()).toBe(0);
  });

  test("withLock serializes same-session calls", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    const events: string[] = [];
    const a = s.withLock("id", async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 20));
      events.push("a-end");
      return "a";
    });
    const b = s.withLock("id", async () => {
      events.push("b-start");
      events.push("b-end");
      return "b";
    });
    await Promise.all([a, b]);
    expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  test("withLock runs different sessions in parallel", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    const events: string[] = [];
    const a = s.withLock("a", async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      events.push("a-end");
    });
    const b = s.withLock("b", async () => {
      events.push("b-start");
      await new Promise((r) => setTimeout(r, 5));
      events.push("b-end");
    });
    await Promise.all([a, b]);
    // b should complete before a even though a started first
    expect(events.indexOf("b-end")).toBeLessThan(events.indexOf("a-end"));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sessionStore.test.ts`
Expected: all tests fail with module-not-found.

- [ ] **Step 3: Implement `src/sessionStore.ts`**

```ts
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionMeta } from "./types.js";

export class SessionStore {
  private map: Map<string, SessionMeta> = new Map();
  private writeQueue: Promise<void> = Promise.resolve();
  private locks: Map<string, Promise<unknown>> = new Map();

  constructor(private readonly storeFile: string) {}

  async load(): Promise<void> {
    try {
      await stat(this.storeFile);
    } catch {
      this.map = new Map();
      return;
    }
    try {
      const raw = await readFile(this.storeFile, "utf8");
      const parsed = JSON.parse(raw) as Record<string, SessionMeta>;
      this.map = new Map(Object.entries(parsed));
    } catch (err) {
      console.warn(
        `[sessionStore] ${this.storeFile} is corrupted, starting fresh:`,
        (err as Error).message,
      );
      this.map = new Map();
    }
  }

  size(): number {
    return this.map.size;
  }

  get(sessionId: string): SessionMeta | null {
    return this.map.get(sessionId) ?? null;
  }

  getMostRecent(): SessionMeta | null {
    let best: SessionMeta | null = null;
    for (const v of this.map.values()) {
      if (!best || v.lastUsedAt > best.lastUsedAt) best = v;
    }
    return best;
  }

  async create(sessionId: string, workDir: string): Promise<SessionMeta> {
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      sessionId,
      workDir,
      createdAt: now,
      lastUsedAt: now,
      turnCount: 0,
    };
    this.map.set(sessionId, meta);
    await this.persist();
    return meta;
  }

  async update(sessionId: string): Promise<SessionMeta | null> {
    const existing = this.map.get(sessionId);
    if (!existing) return null;
    const updated: SessionMeta = {
      ...existing,
      lastUsedAt: new Date().toISOString(),
      turnCount: existing.turnCount + 1,
    };
    this.map.set(sessionId, updated);
    await this.persist();
    return updated;
  }

  async evictExpired(ttlMs: number): Promise<number> {
    const threshold = Date.now() - ttlMs;
    let removed = 0;
    for (const [id, meta] of this.map) {
      if (Date.parse(meta.lastUsedAt) < threshold) {
        this.map.delete(id);
        removed++;
      }
    }
    if (removed > 0) await this.persist();
    return removed;
  }

  withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(sessionId) ?? Promise.resolve();
    const next = prior.then(() => fn());
    // Store a swallowed copy so a thrown error doesn't poison subsequent
    // acquisitions on the same key.
    const stored = next.catch(() => void 0);
    this.locks.set(sessionId, stored);
    // Clear the entry once this one settles, unless a newer acquisition
    // has already replaced it.
    stored.finally(() => {
      if (this.locks.get(sessionId) === stored) {
        this.locks.delete(sessionId);
      }
    });
    return next;
  }

  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.storeFile), { recursive: true });
      const asObject: Record<string, SessionMeta> = {};
      for (const [k, v] of this.map) asObject[k] = v;
      const tmp = this.storeFile + ".tmp";
      await writeFile(tmp, JSON.stringify(asObject, null, 2), "utf8");
      await rename(tmp, this.storeFile);
    });
    return this.writeQueue;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sessionStore.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/sessionStore.ts tests/sessionStore.test.ts
git commit -m "feat: file-backed session store with atomic writes and per-session mutex"
```

---

## Task 6: Claude runner

**Files:**
- Create: `src/claudeRunner.ts`
- Test: `tests/claudeRunner.test.ts`

The only module that spawns `claude`. Builds CLI args, captures stdout/stderr, enforces timeout, parses session ID from JSON output.

- [ ] **Step 1: Write the failing tests**

Create `tests/claudeRunner.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { runClaude, buildArgs } from "../src/claudeRunner.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-mcp-runner-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Writes a mock claude script that emits canned output and exits with a
 * given code. Returns the ["node", path] array form of claudeCommand.
 */
function makeMock(
  stdoutJson: string,
  stderr = "",
  exitCode = 0,
  delayMs = 0,
): [string, string] {
  const scriptPath = join(tmpDir, "mock-claude.mjs");
  writeFileSync(
    scriptPath,
    `
    const out = ${JSON.stringify(stdoutJson)};
    const err = ${JSON.stringify(stderr)};
    const delay = ${delayMs};
    setTimeout(() => {
      if (out) process.stdout.write(out);
      if (err) process.stderr.write(err);
      process.exit(${exitCode});
    }, delay);
    `,
    "utf8",
  );
  return ["node", scriptPath];
}

describe("buildArgs", () => {
  test("stateless with skip-permissions", () => {
    const args = buildArgs({
      prompt: "hello",
      dangerouslySkipPermissions: true,
      timeoutMs: 1000,
      claudeCommand: "claude",
    });
    expect(args).toEqual([
      "-p",
      "hello",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ]);
  });

  test("stateless with allowed-tools", () => {
    const args = buildArgs({
      prompt: "hello",
      allowedTools: "Read,Edit",
      dangerouslySkipPermissions: false,
      timeoutMs: 1000,
      claudeCommand: "claude",
    });
    expect(args).toEqual([
      "-p",
      "hello",
      "--output-format",
      "json",
      "--allowed-tools",
      "Read,Edit",
    ]);
  });

  test("resumes a session", () => {
    const args = buildArgs({
      prompt: "keep going",
      resumeSessionId: "sess-1",
      dangerouslySkipPermissions: true,
      timeoutMs: 1000,
      claudeCommand: "claude",
    });
    expect(args).toEqual([
      "--resume",
      "sess-1",
      "-p",
      "keep going",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ]);
  });

  test("empty allowed-tools still emits the flag (ask-style lock-down)", () => {
    const args = buildArgs({
      prompt: "h",
      allowedTools: "",
      dangerouslySkipPermissions: false,
      timeoutMs: 1000,
      claudeCommand: "claude",
    });
    expect(args).toContain("--allowed-tools");
    expect(args[args.indexOf("--allowed-tools") + 1]).toBe("");
  });
});

describe("runClaude", () => {
  test("parses sessionId from JSON output on success", async () => {
    const cmd = makeMock(
      JSON.stringify({ session_id: "sess-abc", result: "done" }),
    );
    const res = await runClaude({
      prompt: "p",
      dangerouslySkipPermissions: true,
      timeoutMs: 5000,
      claudeCommand: cmd,
    });
    expect(res.exitCode).toBe(0);
    expect(res.sessionId).toBe("sess-abc");
    expect(res.timedOut).toBe(false);
    expect(res.text).toContain("done");
  });

  test("prompts containing spaces and quotes survive unchanged", async () => {
    const cmd = makeMock(
      JSON.stringify({ session_id: "sid", result: "ok" }),
    );
    // If spawn's arg escaping is broken, a prompt with a space + quote
    // either explodes the mock's argv parsing or triggers a shell
    // injection. We just want it to run cleanly and exit 0.
    const res = await runClaude({
      prompt: `hello "world" with 'quotes' & pipes`,
      dangerouslySkipPermissions: true,
      timeoutMs: 5000,
      claudeCommand: cmd,
    });
    expect(res.exitCode).toBe(0);
    expect(res.sessionId).toBe("sid");
  });

  test("returns non-zero exit with stderr captured", async () => {
    const cmd = makeMock("", "boom", 7);
    const res = await runClaude({
      prompt: "p",
      dangerouslySkipPermissions: true,
      timeoutMs: 5000,
      claudeCommand: cmd,
    });
    expect(res.exitCode).toBe(7);
    expect(res.stderr).toContain("boom");
    expect(res.sessionId).toBe(null);
  });

  test("times out and kills the process", async () => {
    const cmd = makeMock(
      JSON.stringify({ session_id: "s", result: "late" }),
      "",
      0,
      1500,
    );
    const res = await runClaude({
      prompt: "p",
      dangerouslySkipPermissions: true,
      timeoutMs: 100,
      claudeCommand: cmd,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
  });

  test("reports a failure when the command is missing", async () => {
    const res = await runClaude({
      prompt: "p",
      dangerouslySkipPermissions: true,
      timeoutMs: 1000,
      claudeCommand: "definitely-not-a-real-binary-xyzzy",
    });
    // On Linux cross-spawn emits an 'error' event and runClaude returns
    // exit -1. On Windows a missing binary may return a non-zero exit
    // from the shim layer without the error event. Either counts as a
    // failure — we just need the caller to see something non-zero.
    expect(res.exitCode).not.toBe(0);
  });

  test("falls back to raw stdout when output is not JSON", async () => {
    const cmd = makeMock("plain text, not json");
    const res = await runClaude({
      prompt: "p",
      dangerouslySkipPermissions: true,
      timeoutMs: 5000,
      claudeCommand: cmd,
    });
    expect(res.exitCode).toBe(0);
    expect(res.sessionId).toBe(null);
    expect(res.text).toContain("plain text");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/claudeRunner.test.ts`
Expected: all tests fail with module-not-found.

- [ ] **Step 3: Implement `src/claudeRunner.ts`**

```ts
import spawn from "cross-spawn";
import treeKill from "tree-kill";
import type {
  ClaudeCommand,
  ClaudeRunOptions,
  ClaudeRunResult,
} from "./types.js";

export function buildArgs(opts: ClaudeRunOptions): string[] {
  const args: string[] = [];
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }
  args.push("-p", opts.prompt);
  args.push("--output-format", "json");
  if (opts.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else if (opts.allowedTools !== undefined) {
    args.push("--allowed-tools", opts.allowedTools);
  }
  return args;
}

function splitCommand(cmd: ClaudeCommand): [string, string[]] {
  if (Array.isArray(cmd)) {
    const [head, ...rest] = cmd;
    if (!head) throw new Error("claudeCommand array must be non-empty");
    return [head, rest];
  }
  return [cmd, []];
}

function parseSessionId(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const sid =
        (parsed as Record<string, unknown>).session_id ??
        (parsed as Record<string, unknown>).sessionId;
      return typeof sid === "string" ? sid : null;
    }
  } catch {
    // Not JSON — some error paths emit plain text. Caller handles fallback.
  }
  return null;
}

function extractText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const result = parsed.result ?? parsed.output ?? parsed.text;
    if (typeof result === "string") return result;
    return JSON.stringify(parsed);
  } catch {
    return trimmed;
  }
}

export function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const args = buildArgs(opts);
    const [cmd, prefixArgs] = splitCommand(opts.claudeCommand);
    // cross-spawn handles Windows .cmd/.bat resolution and proper arg
    // escaping without needing shell:true, avoiding the standard spawn
    // quoting bugs when prompts contain spaces or special characters.
    const child = spawn(cmd, [...prefixArgs, ...args], {
      cwd: opts.workDir,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnErrored = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        treeKill(child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs);

    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      spawnErrored = true;
      stderr += `\n[spawn error] ${err.message}`;
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const exitCode = spawnErrored
        ? -1
        : timedOut
          ? (code ?? 124)
          : (code ?? 0);
      resolve({
        text: extractText(stdout),
        sessionId: exitCode === 0 ? parseSessionId(stdout) : null,
        exitCode,
        durationMs,
        timedOut,
        stderr,
      });
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/claudeRunner.test.ts`
Expected: all tests pass. If the timeout test is flaky on a slow machine, bump the mock delay to `2000` and the cutoff to `200`.

- [ ] **Step 5: Commit**

```bash
git add src/claudeRunner.ts tests/claudeRunner.test.ts
git commit -m "feat: claude CLI runner with timeout and JSON output parsing"
```

---

## Task 7: `claude_ask` tool

**Files:**
- Create: `src/tools/claudeAsk.ts`

Thin wrapper: forwards a prompt to `claudeRunner` with empty `allowedTools`, no workDir, no session tracking. Logs and returns.

- [ ] **Step 1: Implement `src/tools/claudeAsk.ts`**

```ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../types.js";
import type { Logger } from "../logger.js";
import { containsQuestionHeuristic } from "../logger.js";
import { runClaude } from "../claudeRunner.js";

export function registerClaudeAsk(
  server: McpServer,
  config: Config,
  logger: Logger,
): void {
  server.tool(
    "claude_ask",
    {
      prompt: z.string().min(1),
      inReplyToLogId: z.string().uuid().optional(),
    },
    async ({ prompt, inReplyToLogId }) => {
      const logId = randomUUID();
      const startIso = new Date().toISOString();
      const result = await runClaude({
        prompt,
        allowedTools: config.ask.allowedTools,
        dangerouslySkipPermissions: false,
        timeoutMs: config.ask.timeoutMs,
        claudeCommand: config.claudeCommand,
      });

      const status = result.timedOut
        ? "timeout"
        : result.exitCode === 0
          ? "success"
          : "error";
      const errorField =
        status === "success" ? undefined : result.stderr || "claude exited non-zero";

      await logger.log({
        timestamp: startIso,
        logId,
        ...(inReplyToLogId ? { inReplyToLogId } : {}),
        tool: "claude_ask",
        status,
        durationMs: result.durationMs,
        prompt,
        output: result.text,
        containsQuestion: containsQuestionHeuristic(result.text),
        exitCode: result.exitCode,
        ...(errorField ? { error: errorField } : {}),
      });

      const responseText =
        status === "success"
          ? result.text
          : `Error: ${errorField ?? "unknown"}`;

      return {
        content: [{ type: "text" as const, text: responseText }],
        ...(status === "success" ? {} : { isError: true }),
        _meta: {
          logId,
          durationMs: result.durationMs,
        },
      };
    },
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/tools/claudeAsk.ts
git commit -m "feat: claude_ask MCP tool registration"
```

---

## Task 8: `claude_task` tool

**Files:**
- Create: `src/tools/claudeTask.ts`

Stateful tool. Resolves `sessionMode`, `sessionId`, `workDir`, `allowedTools`, and permission-flag precedence. Runs under the session mutex when a session ID is known.

- [ ] **Step 1: Implement `src/tools/claudeTask.ts`**

```ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config, SessionMode } from "../types.js";
import type { Logger } from "../logger.js";
import { containsQuestionHeuristic } from "../logger.js";
import type { SessionStore } from "../sessionStore.js";
import { runClaude } from "../claudeRunner.js";

type TaskInput = {
  prompt: string;
  workDir?: string;
  sessionMode?: SessionMode;
  sessionId?: string;
  allowedTools?: string;
  inReplyToLogId?: string;
};

export function registerClaudeTask(
  server: McpServer,
  config: Config,
  logger: Logger,
  store: SessionStore,
): void {
  server.tool(
    "claude_task",
    {
      prompt: z.string().min(1),
      workDir: z.string().optional(),
      sessionMode: z.enum(["stateless", "session", "auto-last"]).optional(),
      sessionId: z.string().optional(),
      allowedTools: z.string().optional(),
      inReplyToLogId: z.string().uuid().optional(),
    },
    async (input: TaskInput) => {
      const logId = randomUUID();
      const startIso = new Date().toISOString();
      const sessionMode: SessionMode =
        input.sessionMode ?? config.task.defaultSessionMode;
      const workDir = input.workDir ?? config.task.defaultWorkDir;

      // Warn on mis-matched sessionId usage (kept in the returned text on error? no,
      // just log it; callers shouldn't be punished for a harmless override)
      const warnings: string[] = [];
      if (
        input.sessionId &&
        (sessionMode === "stateless" || sessionMode === "auto-last")
      ) {
        warnings.push(
          `sessionId ignored because sessionMode is "${sessionMode}"`,
        );
      }

      // Resolve the effective resume ID based on mode
      let resumeSessionId: string | undefined;
      if (sessionMode === "session" && input.sessionId) {
        resumeSessionId = input.sessionId;
        if (!store.get(input.sessionId)) {
          warnings.push(
            `sessionId ${input.sessionId} not in local store; passing to claude anyway`,
          );
        }
      } else if (sessionMode === "auto-last") {
        const latest = store.getMostRecent();
        if (latest) resumeSessionId = latest.sessionId;
      }
      const mode: "stateless" | "fresh" | "resumed" =
        sessionMode === "stateless"
          ? "stateless"
          : resumeSessionId
            ? "resumed"
            : "fresh";

      // Permission flag precedence
      const skipPerms = config.task.dangerouslySkipPermissions;
      const requestedAllowed = input.allowedTools ?? config.task.allowedTools;
      if (skipPerms && input.allowedTools && input.allowedTools.length > 0) {
        warnings.push(
          "allowedTools ignored because dangerouslySkipPermissions is true",
        );
      }

      const lockKey = resumeSessionId ?? `__fresh_${logId}`;
      const result = await store.withLock(lockKey, () =>
        runClaude({
          prompt: input.prompt,
          workDir,
          resumeSessionId,
          allowedTools: skipPerms ? undefined : requestedAllowed,
          dangerouslySkipPermissions: skipPerms,
          timeoutMs: config.task.timeoutMs,
          claudeCommand: config.claudeCommand,
        }),
      );

      // Determine the sessionId to report out and persist
      let reportedSessionId: string | null = null;
      if (sessionMode !== "stateless") {
        if (resumeSessionId) {
          reportedSessionId = resumeSessionId;
          if (result.exitCode === 0) await store.update(resumeSessionId);
        } else if (result.sessionId && result.exitCode === 0) {
          reportedSessionId = result.sessionId;
          await store.create(result.sessionId, workDir);
        }
      }

      const status = result.timedOut
        ? "timeout"
        : result.exitCode === 0
          ? "success"
          : "error";
      const errorField =
        status === "success"
          ? undefined
          : [result.stderr, ...warnings].filter(Boolean).join("\n").trim() ||
            "claude exited non-zero";

      await logger.log({
        timestamp: startIso,
        logId,
        ...(input.inReplyToLogId ? { inReplyToLogId: input.inReplyToLogId } : {}),
        tool: "claude_task",
        status,
        durationMs: result.durationMs,
        ...(reportedSessionId ? { sessionId: reportedSessionId } : {}),
        prompt: input.prompt,
        workDir,
        allowedTools: skipPerms ? undefined : requestedAllowed,
        sessionMode,
        output: result.text,
        containsQuestion: containsQuestionHeuristic(result.text),
        exitCode: result.exitCode,
        ...(errorField ? { error: errorField } : {}),
      });

      const responseText =
        status === "success"
          ? result.text
          : `Error: ${errorField ?? "unknown"}`;

      return {
        content: [{ type: "text" as const, text: responseText }],
        ...(status === "success" ? {} : { isError: true }),
        _meta: {
          sessionId: reportedSessionId,
          mode,
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          logId,
        },
      };
    },
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/tools/claudeTask.ts
git commit -m "feat: claude_task MCP tool with session mode and permission precedence"
```

---

## Task 9: Server entry point

**Files:**
- Create: `src/server.ts`
- Create: `src/bin.ts`

`server.ts` exports the factory (`main()`) that wires everything. `bin.ts` is the direct-invocation shell: calls `main()`, installs signal handlers. Tests import `main` from `server.ts` so they never trip on the bin-level invocation path.

- [ ] **Step 1: Implement `src/server.ts`**

```ts
import express from "express";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { SessionStore } from "./sessionStore.js";
import { registerClaudeAsk } from "./tools/claudeAsk.js";
import { registerClaudeTask } from "./tools/claudeTask.js";

const TTL_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function parseConfigPath(argv: string[]): string {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string", short: "c", default: "configs/default.json" },
    },
    allowPositionals: true,
  });
  return values.config ?? "configs/default.json";
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<{
  close: () => Promise<void>;
  port: number;
}> {
  const configPath = parseConfigPath(argv);
  const config = loadConfig(configPath);
  const logger = new Logger(config.logFile);
  const store = new SessionStore(config.sessionStoreFile);
  await store.load();

  const mcp = new McpServer({ name: "ClaudeMCP", version: "0.1.0" });
  registerClaudeAsk(mcp, config, logger);
  registerClaudeTask(mcp, config, logger, store);

  const app = express();
  let transport: SSEServerTransport | null = null;

  app.get("/sse", async (_req: Request, res: Response) => {
    transport = new SSEServerTransport("/message", res);
    await mcp.connect(transport);
  });

  app.post("/message", express.json(), async (req: Request, res: Response) => {
    if (!transport) {
      res.status(400).json({ error: "No active SSE connection" });
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, sessions: store.size() });
  });

  const sweepTimer = setInterval(() => {
    store
      .evictExpired(config.task.sessionTtlMs)
      .catch((err: Error) =>
        console.error("[sweep] eviction failed:", err.message),
      );
  }, TTL_SWEEP_INTERVAL_MS);

  const httpServer = await new Promise<ReturnType<typeof app.listen>>(
    (resolve) => {
      const s = app.listen(config.port, config.host, () => {
        console.log(
          `[ClaudeMCP] listening at http://${config.host}:${config.port}/sse`,
        );
        console.log(`[ClaudeMCP] log: ${config.logFile}`);
        console.log(`[ClaudeMCP] sessions: ${config.sessionStoreFile}`);
        resolve(s);
      });
    },
  );

  async function close(): Promise<void> {
    clearInterval(sweepTimer);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await logger.flush();
  }

  return { close, port: config.port };
}
```

- [ ] **Step 2: Implement `src/bin.ts`**

```ts
import { main } from "./server.js";

main()
  .then(({ close }) => {
    let closing = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (closing) return;
      closing = true;
      console.log(`\n[ClaudeMCP] ${signal} received, shutting down...`);
      try {
        await close();
        process.exit(0);
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  })
  .catch((err) => {
    console.error("[ClaudeMCP] startup failed:", err);
    process.exit(1);
  });
```

- [ ] **Step 3: Verify everything compiles**

Run: `npx tsc --noEmit`
Expected: exits 0.

- [ ] **Step 4: Smoke-verify the server starts and health-checks**

Run (in one shell): `npx tsx src/bin.ts --config configs/default.json`
In another shell: `curl http://127.0.0.1:3000/health`
Expected: `{"ok":true,"sessions":0}`
Then kill the first shell with Ctrl-C. Expected: clean `[ClaudeMCP] SIGINT received, shutting down...` and exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/bin.ts
git commit -m "feat: server entry with Express+SSE, TTL sweep, and graceful shutdown"
```

---

## Task 10: Mock claude binary + integration test

**Files:**
- Create: `tests/fixtures/mock-claude.mjs`
- Create: `tests/integration.test.ts`

The mock is a Node script the integration test points `claudeCommand` at. It reads argv, emits canned JSON, and tracks call state via an env var.

- [ ] **Step 1: Create `tests/fixtures/mock-claude.mjs`**

```js
#!/usr/bin/env node
// Mock `claude` CLI for integration tests. Emits JSON matching what
// Claude Code's --output-format json produces for our purposes.
// Behavior is controlled via MOCK_CLAUDE_SCENARIO:
//   "success"     -> success with a generated session_id
//   "resume"      -> success that echoes the --resume value as session_id
//   "nonzero"     -> exit 3 with stderr
//   "slow"        -> sleeps 5s then succeeds (used to trigger timeouts)
//   default       -> same as "success"

const scenario = process.env.MOCK_CLAUDE_SCENARIO ?? "success";
const args = process.argv.slice(2);
const resumeIdx = args.indexOf("--resume");
const resumeId = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
const promptIdx = args.indexOf("-p");
const prompt = promptIdx >= 0 ? args[promptIdx + 1] : "";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function run() {
  if (scenario === "nonzero") {
    process.stderr.write("mock failure");
    process.exit(3);
  }
  if (scenario === "slow") {
    setTimeout(() => {
      emit({ session_id: "late-id", result: `late reply to: ${prompt}` });
      process.exit(0);
    }, 5000);
    return;
  }
  const sid = resumeId ?? `mock-${Math.random().toString(36).slice(2, 10)}`;
  emit({ session_id: sid, result: `mock reply to: ${prompt}` });
  process.exit(0);
}

run();
```

- [ ] **Step 2: Write the failing integration test**

Create `tests/integration.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const MOCK = resolve("tests/fixtures/mock-claude.mjs");

let tmpDir: string;
let configPath: string;
let logFile: string;
let storeFile: string;
let close: (() => Promise<void>) | null = null;
let port = 0;

async function startServer(
  overrides: Record<string, unknown> = {},
): Promise<void> {
  port = 30000 + Math.floor(Math.random() * 1000);
  const config = {
    port,
    host: "127.0.0.1",
    logFile,
    sessionStoreFile: storeFile,
    claudeCommand: ["node", MOCK],
    ask: { timeoutMs: 5000, allowedTools: "" },
    task: {
      defaultSessionMode: "session" as const,
      defaultWorkDir: tmpDir,
      timeoutMs: 5000,
      allowedTools: "Read",
      dangerouslySkipPermissions: true,
      sessionTtlMs: 60_000,
    },
    ...overrides,
  };
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  const started = await main(["--config", configPath]);
  close = started.close;
}

async function mkClient(): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  const transport = new SSEClientTransport(
    new URL(`http://127.0.0.1:${port}/sse`),
  );
  await client.connect(transport);
  return client;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-mcp-int-"));
  configPath = join(tmpDir, "config.json");
  logFile = join(tmpDir, "activity.log");
  storeFile = join(tmpDir, "sessions.json");
  delete process.env.MOCK_CLAUDE_SCENARIO;
});

afterEach(async () => {
  if (close) {
    await close();
    close = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MOCK_CLAUDE_SCENARIO;
});

describe("integration", () => {
  test("claude_ask returns the mock output and writes a log entry", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "success";
    await startServer();
    const client = await mkClient();
    const res = await client.callTool({
      name: "claude_ask",
      arguments: { prompt: "hello" },
    });
    const first = res.content[0];
    expect(first).toMatchObject({ type: "text" });
    if (first.type === "text") {
      expect(first.text).toContain("mock reply to: hello");
    }
    expect(existsSync(logFile)).toBe(true);
    const entries = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({
      tool: "claude_ask",
      status: "success",
      prompt: "hello",
    });
    await client.close();
  });

  test("claude_task stores sessionId and resumes it on next call", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "success";
    await startServer();
    const client = await mkClient();
    const first = await client.callTool({
      name: "claude_task",
      arguments: { prompt: "start", sessionMode: "session" },
    });
    const firstMeta = (first as unknown as { _meta?: { sessionId?: string } })
      ._meta;
    const sid = firstMeta?.sessionId;
    expect(sid).toBeTruthy();
    expect(existsSync(storeFile)).toBe(true);
    const stored = JSON.parse(readFileSync(storeFile, "utf8"));
    expect(stored[sid!]).toMatchObject({ sessionId: sid, turnCount: 0 });

    const second = await client.callTool({
      name: "claude_task",
      arguments: { prompt: "continue", sessionMode: "session", sessionId: sid },
    });
    const secondMeta = (second as unknown as { _meta?: { sessionId?: string; mode?: string } })
      ._meta;
    expect(secondMeta?.sessionId).toBe(sid);
    expect(secondMeta?.mode).toBe("resumed");
    const storedAfter = JSON.parse(readFileSync(storeFile, "utf8"));
    expect(storedAfter[sid!].turnCount).toBe(1);
    await client.close();
  });

  test("claude_task returns isError on non-zero exit", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "nonzero";
    await startServer();
    const client = await mkClient();
    const res = await client.callTool({
      name: "claude_task",
      arguments: { prompt: "fail", sessionMode: "stateless" },
    });
    expect(res.isError).toBe(true);
    const entries = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries[0]).toMatchObject({ status: "error", exitCode: 3 });
    await client.close();
  });

  test("timeout is reported as status=timeout", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "slow";
    await startServer({
      task: {
        defaultSessionMode: "stateless",
        defaultWorkDir: tmpDir,
        timeoutMs: 300,
        allowedTools: "Read",
        dangerouslySkipPermissions: true,
        sessionTtlMs: 60_000,
      },
    });
    const client = await mkClient();
    const res = await client.callTool({
      name: "claude_task",
      arguments: { prompt: "zzz", sessionMode: "stateless" },
    });
    expect(res.isError).toBe(true);
    const entries = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries[0]?.status).toBe("timeout");
    await client.close();
  }, 10000);

  test("auto-last picks the most recent session", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "success";
    await startServer();
    const client = await mkClient();
    const first = await client.callTool({
      name: "claude_task",
      arguments: { prompt: "a", sessionMode: "session" },
    });
    const firstSid =
      (first as unknown as { _meta?: { sessionId?: string } })._meta?.sessionId;
    const second = await client.callTool({
      name: "claude_task",
      arguments: { prompt: "b", sessionMode: "auto-last" },
    });
    const secondMeta =
      (second as unknown as { _meta?: { sessionId?: string; mode?: string } })
        ._meta;
    expect(secondMeta?.sessionId).toBe(firstSid);
    expect(secondMeta?.mode).toBe("resumed");
    await client.close();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/integration.test.ts`
Expected: tests fail — either on MCP SDK client import errors (confirm it's installed and the import paths match the installed version), or on the "server started" step. Sanity-check imports against `node_modules/@modelcontextprotocol/sdk/dist/esm/client/` before assuming real failure.

- [ ] **Step 4: Adjust imports if needed**

If the `@modelcontextprotocol/sdk/client/index.js` or `client/sse.js` paths don't resolve, check the installed version's `package.json` `exports` map and use whatever it exposes (the SDK has rearranged client exports between versions). The test must import a real `Client` class and an SSE client transport — if names differ, update the imports; do not work around by spawning a subprocess.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/integration.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all unit and integration tests pass.

- [ ] **Step 7: Commit**

```bash
git add tests/fixtures/mock-claude.mjs tests/integration.test.ts
git commit -m "test: end-to-end integration suite with mock claude binary"
```

---

## Task 11: Smoke test doc and README

**Files:**
- Create: `docs/smoke-test.md`
- Create: `README.md`

- [ ] **Step 1: Create `docs/smoke-test.md`**

```markdown
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
```

- [ ] **Step 2: Create `README.md`**

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
git add docs/smoke-test.md README.md
git commit -m "docs: smoke test guide and README"
```

---

## Task 12: Final verification

**Files:** (none)

Last sanity check before shipping.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, coverage roughly ~80% on src/.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: `dist/` populated, no errors.

- [ ] **Step 3: Start the built server**

Run: `npm start`
Expected: `[ClaudeMCP] listening at http://127.0.0.1:3000/sse`. Hit Ctrl-C, expect clean shutdown.

- [ ] **Step 4: Confirm git log looks right**

Run: `git log --oneline`
Expected: a series of small commits — one for scaffolding, one for types, one per module + tests, one for each tool, server, integration, docs. No commits containing unrelated changes.

- [ ] **Step 5: Tag v0.1.0**

```bash
git tag v0.1.0
```

Done.
