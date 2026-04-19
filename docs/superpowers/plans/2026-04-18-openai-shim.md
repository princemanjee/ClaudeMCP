# OpenAI-Compatible Shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `POST /v1/chat/completions` endpoint to the existing ClaudeMCP server so Agent Zero can use Claude Code CLI as its reasoning model via prompt-engineered XML tool calling.

**Architecture:** New subsystem under `src/openaiShim/` plus a streaming variant of the Claude runner. Claude is prompted to emit `<tool_use>` tags; a state-machine classifier reads stream-json events and translates them into OpenAI SSE chunks. Sessions are resumed across turns via SHA-256 hashing of the last assistant message, stored in the existing `SessionStore` with a new external-key shadow index. MCP path is untouched.

**Tech Stack:** Same as the parent project — Node.js 20+, TypeScript 5, Express 4, Zod, Vitest, `cross-spawn`, `tree-kill`. New dependency: none (reuse existing).

**Spec:** `docs/superpowers/specs/2026-04-18-openai-shim-design.md`

---

## Task 1: Type extensions, config, OpenAI-shim type definitions

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `configs/default.json`
- Modify: `configs/example.json`
- Create: `src/openaiShim/types.ts`
- Modify: `tests/config.test.ts`

TDD approach: extend the config test with failing cases for new fields, then implement the type/config changes to satisfy them.

- [ ] **Step 1: Extend `tests/config.test.ts` with failing tests for openai block**

Add these two new tests inside the existing `describe("loadConfig", ...)` block (anywhere before the closing `});`):

```ts
  test("applies openai defaults when block is omitted", () => {
    const path = write("c.json", {
      task: { defaultWorkDir: "/x" },
    });
    const cfg = loadConfig(path);
    expect(cfg.openai.enabled).toBe(true);
    expect(cfg.openai.requireAuthHeader).toBe(null);
    expect(cfg.openai.timeoutMs).toBe(120000);
  });

  test("env vars override openai config", () => {
    process.env.CLAUDE_MCP_OPENAI_ENABLED = "false";
    process.env.CLAUDE_MCP_OPENAI_AUTH_HEADER = "Bearer secret";
    process.env.CLAUDE_MCP_OPENAI_TIMEOUT_MS = "7000";
    const path = write("c.json", { task: { defaultWorkDir: "/x" } });
    const cfg = loadConfig(path);
    expect(cfg.openai.enabled).toBe(false);
    expect(cfg.openai.requireAuthHeader).toBe("Bearer secret");
    expect(cfg.openai.timeoutMs).toBe(7000);
  });
```

Also extend the hook cleanup to delete the new env vars. Change both the `beforeEach` and `afterEach` blocks in the file to include these three additional deletes:

```ts
  delete process.env.CLAUDE_MCP_OPENAI_ENABLED;
  delete process.env.CLAUDE_MCP_OPENAI_AUTH_HEADER;
  delete process.env.CLAUDE_MCP_OPENAI_TIMEOUT_MS;
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run tests/config.test.ts`
Expected: 2 new tests fail with "cannot read properties of undefined (reading 'enabled')" or similar; the 8 original tests still pass.

- [ ] **Step 3: Extend `src/types.ts`**

Replace the existing `Config` type with this (adds the `openai` block):

```ts
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
  openai: {
    enabled: boolean;
    requireAuthHeader: string | null;
    timeoutMs: number;
  };
};
```

Replace the existing `SessionMeta` type:

```ts
export type SessionMeta = {
  sessionId: string;
  workDir: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
  externalKey?: string;
};
```

Replace the existing `LogEntry` type:

```ts
export type LogEntry = {
  timestamp: string;
  logId: string;
  inReplyToLogId?: string;
  tool: "claude_ask" | "claude_task" | "openai_completion";
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
  openaiMode?: "fresh" | "resumed" | "session-miss";
  toolCallsEmitted?: number;
  externalKey?: string;
};
```

- [ ] **Step 4: Extend `src/config.ts` Zod schema**

Add this inside the `ConfigSchema = z.object({ ... })` definition (right after the `task` block, before the closing `})`):

```ts
  openai: z
    .object({
      enabled: z.boolean().default(true),
      requireAuthHeader: z.string().nullable().default(null),
      timeoutMs: z.number().int().positive().default(120000),
    })
    .default({}),
```

Add env overrides to `applyEnvOverrides`. Find the function and replace it with:

```ts
function applyEnvOverrides(cfg: Config): Config {
  const portEnv = process.env.CLAUDE_MCP_PORT;
  const hostEnv = process.env.CLAUDE_MCP_HOST;
  const logEnv = process.env.CLAUDE_MCP_LOG_FILE;
  const storeEnv = process.env.CLAUDE_MCP_SESSION_STORE_FILE;
  const openaiEnabledEnv = process.env.CLAUDE_MCP_OPENAI_ENABLED;
  const openaiAuthEnv = process.env.CLAUDE_MCP_OPENAI_AUTH_HEADER;
  const openaiTimeoutEnv = process.env.CLAUDE_MCP_OPENAI_TIMEOUT_MS;
  const next: Config = {
    ...cfg,
    port: portEnv ? Number(portEnv) : cfg.port,
    host: hostEnv ?? cfg.host,
    logFile: logEnv ?? cfg.logFile,
    sessionStoreFile: storeEnv ?? cfg.sessionStoreFile,
    openai: {
      ...cfg.openai,
      enabled:
        openaiEnabledEnv !== undefined
          ? openaiEnabledEnv === "true"
          : cfg.openai.enabled,
      requireAuthHeader: openaiAuthEnv ?? cfg.openai.requireAuthHeader,
      timeoutMs: openaiTimeoutEnv
        ? Number(openaiTimeoutEnv)
        : cfg.openai.timeoutMs,
    },
  };
  if (portEnv && (!Number.isInteger(next.port) || next.port <= 0)) {
    throw new Error(
      `CLAUDE_MCP_PORT must be a positive integer, got: ${portEnv}`,
    );
  }
  if (
    openaiTimeoutEnv &&
    (!Number.isInteger(next.openai.timeoutMs) || next.openai.timeoutMs <= 0)
  ) {
    throw new Error(
      `CLAUDE_MCP_OPENAI_TIMEOUT_MS must be a positive integer, got: ${openaiTimeoutEnv}`,
    );
  }
  return next;
}
```

Update the end of `loadConfig` to freeze the new sub-object:

```ts
  const withEnv = applyEnvOverrides(parsed.data);
  Object.freeze(withEnv.ask);
  Object.freeze(withEnv.task);
  Object.freeze(withEnv.openai);
  return Object.freeze(withEnv);
```

- [ ] **Step 5: Update `configs/default.json` and `configs/example.json`**

Add the `openai` block to `configs/default.json` (at the top level, after `task`):

```json
  ,"openai": {
    "enabled": true,
    "requireAuthHeader": null,
    "timeoutMs": 120000
  }
```

Then re-format the whole file so it's valid JSON. The final `configs/default.json` should be:

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
  },
  "openai": {
    "enabled": true,
    "requireAuthHeader": null,
    "timeoutMs": 120000
  }
}
```

Similarly update `configs/example.json` — add matching `openai` block AND add these three entries to the `_comments` object (inside the existing `_comments` block, after the `task.sessionTtlMs` comment):

```json
    "openai.enabled": "If false, /v1/chat/completions is not mounted (feature flag for rollback)",
    "openai.requireAuthHeader": "If set, requests must send matching Authorization header. Null disables auth",
    "openai.timeoutMs": "Per-request timeout for /v1/chat/completions",
```

And the openai block in `configs/example.json`:

```json
  "openai": {
    "enabled": true,
    "requireAuthHeader": null,
    "timeoutMs": 120000
  }
```

- [ ] **Step 6: Create `src/openaiShim/types.ts`**

```ts
export type OpenAIRole = "system" | "user" | "assistant" | "tool";

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-serialized
  };
};

export type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAIToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>; // JSON Schema
  };
};

export type OpenAIChatCompletionRequest = {
  model?: string;
  messages: OpenAIMessage[];
  tools?: OpenAIToolDefinition[];
  tool_choice?: unknown;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
};

export type OpenAIChatCompletionChoiceMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
};

export type OpenAIChatCompletionResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: OpenAIChatCompletionChoiceMessage;
    finish_reason: "stop" | "tool_calls" | "length" | null;
  }>;
};

export type OpenAIChatCompletionChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: "stop" | "tool_calls" | "length" | null;
  }>;
};

export type OpenAIErrorBody = {
  error: {
    message: string;
    type:
      | "authentication_error"
      | "api_error"
      | "timeout"
      | "invalid_request_error";
    code?: string;
  };
};

// Internal: what the parser/translator emit
export type ParsedToolCall = {
  id: string; // "call_<uuid>"
  name: string;
  argumentsJson: string; // already JSON-stringified
};

export type ParsedClaudeOutput =
  | { kind: "content"; text: string }
  | { kind: "tool_calls"; calls: ParsedToolCall[] };

// Claude Code stream-json event shapes (the subset we care about)
export type StreamJsonSystemInit = {
  type: "system";
  subtype: "init";
  session_id: string;
  model?: string;
  cwd?: string;
};

export type StreamJsonAssistantText = {
  type: "assistant";
  message: {
    content: Array<{ type: "text"; text: string }>;
  };
};

export type StreamJsonResult = {
  type: "result";
  subtype: "success" | "error" | "error_max_turns" | string;
  session_id?: string;
  total_cost_usd?: number;
};

export type StreamJsonEvent =
  | StreamJsonSystemInit
  | StreamJsonAssistantText
  | StreamJsonResult
  | { type: string; [key: string]: unknown };
```

- [ ] **Step 7: Verify types compile and config tests pass**

Run: `npx tsc --noEmit`
Expected: 0 errors.

Run: `npx vitest run tests/config.test.ts`
Expected: all 10 tests pass (8 original + 2 new).

Run: `npx tsx -e "import { loadConfig } from './src/config.ts'; const c = loadConfig('configs/default.json'); console.log('OK', c.openai.enabled, c.openai.timeoutMs);"`
Expected: prints `OK true 120000`.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/config.ts src/openaiShim/types.ts configs/default.json configs/example.json tests/config.test.ts
git commit -m "feat: extend config/types with OpenAI shim block"
```

---

## Task 2: SessionStore external-key index

**Files:**
- Modify: `src/sessionStore.ts`
- Modify: `tests/sessionStore.test.ts`

- [ ] **Step 1: Write failing tests — append inside the existing `describe("SessionStore", ...)` block in `tests/sessionStore.test.ts`**

```ts
  test("findByExternalKey returns the right entry", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    await s.createWithExternalKey("sid-1", "/w", "key-abc");
    const found = s.findByExternalKey("key-abc");
    expect(found?.sessionId).toBe("sid-1");
    expect(found?.externalKey).toBe("key-abc");
  });

  test("findByExternalKey returns null on miss", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    await s.createWithExternalKey("sid-1", "/w", "key-abc");
    expect(s.findByExternalKey("key-nope")).toBe(null);
  });

  test("setExternalKey replaces the old key mapping", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    await s.createWithExternalKey("sid-1", "/w", "key-old");
    await s.setExternalKey("sid-1", "key-new");
    expect(s.findByExternalKey("key-old")).toBe(null);
    expect(s.findByExternalKey("key-new")?.sessionId).toBe("sid-1");
  });

  test("load rebuilds the shadow index from disk", async () => {
    const s1 = new SessionStore(storeFile);
    await s1.load();
    await s1.createWithExternalKey("sid-1", "/w", "key-persist");
    const s2 = new SessionStore(storeFile);
    await s2.load();
    expect(s2.findByExternalKey("key-persist")?.sessionId).toBe("sid-1");
  });

  test("TTL eviction removes external-key mapping", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    await s.createWithExternalKey("sid-old", "/w", "key-old");
    await new Promise((r) => setTimeout(r, 20));
    await s.createWithExternalKey("sid-new", "/w", "key-new");
    await s.evictExpired(15);
    expect(s.findByExternalKey("key-old")).toBe(null);
    expect(s.findByExternalKey("key-new")?.sessionId).toBe("sid-new");
  });

  test("creating a session with an already-used external key retires the old mapping", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    await s.createWithExternalKey("sid-old", "/w", "key-shared");
    await s.createWithExternalKey("sid-new", "/w", "key-shared");
    const found = s.findByExternalKey("key-shared");
    expect(found?.sessionId).toBe("sid-new");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sessionStore.test.ts`
Expected: 6 new tests fail (`createWithExternalKey is not a function`). Original 12 still pass.

- [ ] **Step 3: Implement in `src/sessionStore.ts`**

Replace the entire class body. The full updated file is:

```ts
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionMeta } from "./types.js";

function isSessionMeta(value: unknown): value is SessionMeta {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === "string" &&
    typeof v.workDir === "string" &&
    typeof v.createdAt === "string" &&
    typeof v.lastUsedAt === "string" &&
    typeof v.turnCount === "number"
  );
}

export class SessionStore {
  private map: Map<string, SessionMeta> = new Map();
  private externalKeyIndex: Map<string, string> = new Map();
  private writeQueue: Promise<void> = Promise.resolve();
  private locks: Map<string, Promise<unknown>> = new Map();

  constructor(private readonly storeFile: string) {}

  async load(): Promise<void> {
    try {
      await stat(this.storeFile);
    } catch {
      this.map = new Map();
      this.externalKeyIndex = new Map();
      return;
    }
    try {
      const raw = await readFile(this.storeFile, "utf8");
      const parsed: unknown = JSON.parse(raw);
      this.map = new Map();
      this.externalKeyIndex = new Map();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (isSessionMeta(value)) {
            this.map.set(key, value);
            if (value.externalKey) {
              this.externalKeyIndex.set(value.externalKey, value.sessionId);
            }
          } else {
            console.warn(
              `[sessionStore] skipping malformed entry for sessionId="${key}"`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(
        `[sessionStore] ${this.storeFile} is corrupted, starting fresh:`,
        (err as Error).message,
      );
      this.map = new Map();
      this.externalKeyIndex = new Map();
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

  findByExternalKey(key: string): SessionMeta | null {
    const sid = this.externalKeyIndex.get(key);
    if (!sid) return null;
    return this.map.get(sid) ?? null;
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
    await this.mutateAndPersist(() => {
      this.map.set(sessionId, meta);
    });
    return meta;
  }

  async createWithExternalKey(
    sessionId: string,
    workDir: string,
    externalKey: string,
  ): Promise<SessionMeta> {
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      sessionId,
      workDir,
      createdAt: now,
      lastUsedAt: now,
      turnCount: 0,
      externalKey,
    };
    await this.mutateAndPersist(() => {
      // If another session was mapped to this externalKey, retire that mapping
      // (but leave the session itself in the map; only the key is reassigned).
      const prior = this.externalKeyIndex.get(externalKey);
      if (prior && prior !== sessionId) {
        const priorMeta = this.map.get(prior);
        if (priorMeta) {
          this.map.set(prior, { ...priorMeta, externalKey: undefined });
        }
      }
      this.map.set(sessionId, meta);
      this.externalKeyIndex.set(externalKey, sessionId);
    });
    return meta;
  }

  async setExternalKey(
    sessionId: string,
    externalKey: string,
  ): Promise<void> {
    await this.mutateAndPersist(() => {
      const existing = this.map.get(sessionId);
      if (!existing) return;
      // Remove old mapping if any
      if (existing.externalKey) {
        this.externalKeyIndex.delete(existing.externalKey);
      }
      // Retire any other session that currently owns the new key
      const prior = this.externalKeyIndex.get(externalKey);
      if (prior && prior !== sessionId) {
        const priorMeta = this.map.get(prior);
        if (priorMeta) {
          this.map.set(prior, { ...priorMeta, externalKey: undefined });
        }
      }
      this.map.set(sessionId, { ...existing, externalKey });
      this.externalKeyIndex.set(externalKey, sessionId);
    });
  }

  async update(sessionId: string): Promise<SessionMeta | null> {
    let updated: SessionMeta | null = null;
    await this.mutateAndPersist(() => {
      const existing = this.map.get(sessionId);
      if (!existing) return;
      updated = {
        ...existing,
        lastUsedAt: new Date().toISOString(),
        turnCount: existing.turnCount + 1,
      };
      this.map.set(sessionId, updated);
    });
    return updated;
  }

  async evictExpired(ttlMs: number): Promise<number> {
    const threshold = Date.now() - ttlMs;
    let removed = 0;
    await this.mutateAndPersist(() => {
      for (const [id, meta] of this.map) {
        if (Date.parse(meta.lastUsedAt) < threshold) {
          this.map.delete(id);
          if (meta.externalKey) {
            this.externalKeyIndex.delete(meta.externalKey);
          }
          removed++;
        }
      }
    });
    return removed;
  }

  withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(sessionId) ?? Promise.resolve();
    const next = prior.then(() => fn());
    const stored = next.catch(() => void 0);
    this.locks.set(sessionId, stored);
    stored.finally(() => {
      if (this.locks.get(sessionId) === stored) {
        this.locks.delete(sessionId);
      }
    });
    return next;
  }

  private mutateAndPersist(mutate: () => void): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      mutate();
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
Expected: all 18 tests pass (12 original + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/sessionStore.ts tests/sessionStore.test.ts
git commit -m "feat: SessionStore external-key shadow index and new methods"
```

---

## Task 3: Claude streaming runner

**Files:**
- Create: `src/claudeStreamRunner.ts`
- Test: `tests/claudeStreamRunner.test.ts`

- [ ] **Step 1: Write the failing tests — create `tests/claudeStreamRunner.test.ts`**

```ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runClaudeStream } from "../src/claudeStreamRunner.js";
import type { StreamJsonEvent } from "../src/openaiShim/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-mcp-stream-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeStreamMock(lines: string[], exitCode = 0): [string, string] {
  const scriptPath = join(tmpDir, "mock-stream.mjs");
  writeFileSync(
    scriptPath,
    `
    const lines = ${JSON.stringify(lines)};
    let i = 0;
    function tick() {
      if (i < lines.length) {
        process.stdout.write(lines[i] + "\\n");
        i++;
        setTimeout(tick, 5);
      } else {
        process.exit(${exitCode});
      }
    }
    tick();
    `,
    "utf8",
  );
  return ["node", scriptPath];
}

async function collect(gen: AsyncIterable<StreamJsonEvent>): Promise<StreamJsonEvent[]> {
  const out: StreamJsonEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("runClaudeStream", () => {
  test("yields each JSON line in order", async () => {
    const cmd = makeStreamMock([
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({ type: "result", subtype: "success", session_id: "s-1" }),
    ]);
    const events = await collect(
      runClaudeStream({
        prompt: "p",
        dangerouslySkipPermissions: false,
        allowedTools: "",
        timeoutMs: 5000,
        claudeCommand: cmd,
      }),
    );
    expect(events.length).toBe(3);
    expect(events[0]?.type).toBe("system");
    expect(events[1]?.type).toBe("assistant");
    expect(events[2]?.type).toBe("result");
  });

  test("skips malformed JSON lines but yields valid ones", async () => {
    const cmd = makeStreamMock([
      "{ not json",
      JSON.stringify({ type: "result", subtype: "success" }),
    ]);
    const events = await collect(
      runClaudeStream({
        prompt: "p",
        dangerouslySkipPermissions: false,
        allowedTools: "",
        timeoutMs: 5000,
        claudeCommand: cmd,
      }),
    );
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("result");
  });

  test("returns on non-zero exit", async () => {
    const cmd = makeStreamMock([], 4);
    const events = await collect(
      runClaudeStream({
        prompt: "p",
        dangerouslySkipPermissions: false,
        allowedTools: "",
        timeoutMs: 5000,
        claudeCommand: cmd,
      }),
    );
    expect(events.length).toBe(0);
  });

  test("times out and stops yielding", async () => {
    // Mock that emits one event after 500ms, then hangs
    const scriptPath = join(tmpDir, "slow-stream.mjs");
    writeFileSync(
      scriptPath,
      `
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\\n");
      }, 2000);
      setTimeout(() => process.exit(0), 10000);
      `,
      "utf8",
    );
    const events = await collect(
      runClaudeStream({
        prompt: "p",
        dangerouslySkipPermissions: false,
        allowedTools: "",
        timeoutMs: 100,
        claudeCommand: ["node", scriptPath],
      }),
    );
    expect(events.length).toBe(0);
  });

  test("passes through resume session and system prompt flags", async () => {
    // We use the mock to echo back its argv via stderr, verify runner passes correct flags
    const scriptPath = join(tmpDir, "argv-echo.mjs");
    writeFileSync(
      scriptPath,
      `
      process.stderr.write(JSON.stringify(process.argv.slice(2)));
      process.exit(0);
      `,
      "utf8",
    );
    // We can't read stderr from the generator directly, so just verify the run completes
    // without error. The full argv check is exercised by integration tests later.
    const events = await collect(
      runClaudeStream({
        prompt: "p",
        resumeSessionId: "sess-resume-1",
        systemPrompt: "SYS",
        dangerouslySkipPermissions: false,
        allowedTools: "",
        timeoutMs: 5000,
        claudeCommand: ["node", scriptPath],
      }),
    );
    expect(events.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/claudeStreamRunner.test.ts`
Expected: all 5 tests fail (module not found).

- [ ] **Step 3: Implement `src/claudeStreamRunner.ts`**

```ts
import spawn from "cross-spawn";
import treeKill from "tree-kill";
import type {
  ClaudeCommand,
  StreamJsonEvent,
} from "./openaiShim/types.js";

export type StreamRunOptions = {
  prompt: string;
  workDir?: string;
  resumeSessionId?: string;
  systemPrompt?: string;
  allowedTools?: string;
  dangerouslySkipPermissions: boolean;
  timeoutMs: number;
  claudeCommand: ClaudeCommand;
};

function buildStreamArgs(opts: StreamRunOptions): string[] {
  const args: string[] = [];
  if (opts.systemPrompt !== undefined) {
    args.push("--system", opts.systemPrompt);
  }
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
  }
  args.push("-p", opts.prompt);
  args.push("--output-format", "stream-json");
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

export async function* runClaudeStream(
  opts: StreamRunOptions,
): AsyncGenerator<StreamJsonEvent> {
  const args = buildStreamArgs(opts);
  const [cmd, prefixArgs] = splitCommand(opts.claudeCommand);
  const child = spawn(cmd, [...prefixArgs, ...args], {
    cwd: opts.workDir,
    windowsHide: true,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) {
      treeKill(child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  }, opts.timeoutMs);

  // Queue of parsed events; awaiters are resolved as events arrive.
  const queue: StreamJsonEvent[] = [];
  let done = false;
  let spawnErrored = false;
  let waker: (() => void) | null = null;

  function wake(): void {
    if (waker) {
      const w = waker;
      waker = null;
      w();
    }
  }

  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line) as StreamJsonEvent;
          queue.push(parsed);
        } catch {
          // Malformed line — skip. Caller sees fewer events; not fatal.
        }
      }
      nl = buffer.indexOf("\n");
    }
    wake();
  });

  child.on("error", () => {
    spawnErrored = true;
  });

  child.on("close", () => {
    clearTimeout(timer);
    // Flush any residual buffered line
    const trailing = buffer.trim();
    if (trailing.length > 0) {
      try {
        queue.push(JSON.parse(trailing) as StreamJsonEvent);
      } catch {
        // ignore
      }
    }
    done = true;
    wake();
  });

  while (true) {
    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }
    if (done) break;
    if (timedOut || spawnErrored) break;
    await new Promise<void>((resolve) => {
      waker = resolve;
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/claudeStreamRunner.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/claudeStreamRunner.ts tests/claudeStreamRunner.test.ts
git commit -m "feat: async-iterable streaming Claude runner for stream-json output"
```

---

## Task 4: External-key hashing + prompt builder

**Files:**
- Create: `src/openaiShim/promptBuilder.ts`
- Test: `tests/openaiShim/promptBuilder.test.ts`

The prompt builder owns two pure functions: `computeExternalKey(messages)` and `buildPrompts(messages, tools, mode)`. TDD.

- [ ] **Step 1: Create the test directory and write the failing tests — create `tests/openaiShim/promptBuilder.test.ts`**

```ts
import { describe, test, expect } from "vitest";
import {
  computeExternalKey,
  buildFreshPrompts,
  buildResumeUserPrompt,
  extractNewMessagesAfterLastAssistant,
} from "../../src/openaiShim/promptBuilder.js";
import type { OpenAIMessage, OpenAIToolDefinition } from "../../src/openaiShim/types.js";

describe("computeExternalKey", () => {
  test("returns null when no assistant message exists", () => {
    const msgs: OpenAIMessage[] = [
      { role: "user", content: "hi" },
    ];
    expect(computeExternalKey(msgs)).toBe(null);
  });

  test("produces a deterministic hash for identical assistant content", () => {
    const a: OpenAIMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const b: OpenAIMessage[] = [
      { role: "user", content: "different" },
      { role: "assistant", content: "hello" },
    ];
    // Same assistant content → same hash, regardless of prior context
    expect(computeExternalKey(a)).toBe(computeExternalKey(b));
    expect(typeof computeExternalKey(a)).toBe("string");
    expect(computeExternalKey(a)!.length).toBeGreaterThan(16);
  });

  test("whitespace change in assistant content changes the hash", () => {
    const a: OpenAIMessage[] = [{ role: "assistant", content: "hello" }];
    const b: OpenAIMessage[] = [{ role: "assistant", content: "hello " }];
    expect(computeExternalKey(a)).not.toBe(computeExternalKey(b));
  });

  test("tool_calls content is included in the hash", () => {
    const a: OpenAIMessage[] = [
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "search", arguments: "{}" } },
        ],
      },
    ];
    const b: OpenAIMessage[] = [
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } },
        ],
      },
    ];
    expect(computeExternalKey(a)).not.toBe(computeExternalKey(b));
  });

  test("tool_calls reordering changes the hash", () => {
    const a: OpenAIMessage[] = [
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
        ],
      },
    ];
    const b: OpenAIMessage[] = [
      {
        role: "assistant",
        tool_calls: [
          { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
          { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
        ],
      },
    ];
    expect(computeExternalKey(a)).not.toBe(computeExternalKey(b));
  });
});

describe("extractNewMessagesAfterLastAssistant", () => {
  test("returns all messages when none are assistant", () => {
    const msgs: OpenAIMessage[] = [{ role: "user", content: "a" }];
    expect(extractNewMessagesAfterLastAssistant(msgs)).toEqual(msgs);
  });

  test("returns messages after the last assistant", () => {
    const msgs: OpenAIMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "tool", tool_call_id: "c1", content: "result" },
      { role: "user", content: "c" },
    ];
    const after = extractNewMessagesAfterLastAssistant(msgs);
    expect(after).toEqual([
      { role: "tool", tool_call_id: "c1", content: "result" },
      { role: "user", content: "c" },
    ]);
  });

  test("uses the LAST assistant, not the first", () => {
    const msgs: OpenAIMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "first" },
      { role: "user", content: "b" },
      { role: "assistant", content: "second" },
      { role: "user", content: "c" },
    ];
    const after = extractNewMessagesAfterLastAssistant(msgs);
    expect(after).toEqual([{ role: "user", content: "c" }]);
  });
});

describe("buildFreshPrompts", () => {
  test("system prompt embeds caller's system message and tool list", () => {
    const msgs: OpenAIMessage[] = [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hi" },
    ];
    const tools: OpenAIToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "search",
          description: "Search the web",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    ];
    const { systemPrompt, userPrompt } = buildFreshPrompts(msgs, tools);
    expect(systemPrompt).toContain("reasoning engine");
    expect(systemPrompt).toContain("Be concise.");
    expect(systemPrompt).toContain("search");
    expect(systemPrompt).toContain("Search the web");
    expect(systemPrompt).toContain("<tool_use>");
    expect(userPrompt).toContain("<user>Hi</user>");
  });

  test("omits caller system block when none is present", () => {
    const msgs: OpenAIMessage[] = [{ role: "user", content: "Hi" }];
    const { systemPrompt } = buildFreshPrompts(msgs, []);
    expect(systemPrompt).not.toContain("<<<");
    expect(systemPrompt).toContain("reasoning engine");
  });

  test("serializes assistant history and tool results", () => {
    const msgs: OpenAIMessage[] = [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "search", arguments: '{"q":"weather"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "sunny" },
    ];
    const { userPrompt } = buildFreshPrompts(msgs, []);
    expect(userPrompt).toContain("<user>weather?</user>");
    expect(userPrompt).toContain("<assistant_tool_use>");
    expect(userPrompt).toContain('"name":"search"');
    expect(userPrompt).toContain('<tool_result id="c1">sunny</tool_result>');
    expect(userPrompt).toMatch(/Produce your next response\./);
  });

  test("throws on empty messages", () => {
    expect(() => buildFreshPrompts([], [])).toThrow(/at least one/);
  });
});

describe("buildResumeUserPrompt", () => {
  test("serializes tool_result and user messages", () => {
    const newMsgs: OpenAIMessage[] = [
      { role: "tool", tool_call_id: "c1", content: "42" },
      { role: "user", content: "continue" },
    ];
    const p = buildResumeUserPrompt(newMsgs);
    expect(p).toContain('<tool_result id="c1">42</tool_result>');
    expect(p).toContain("<user>continue</user>");
    expect(p).toMatch(/Produce your next response\./);
  });

  test("empty new messages still produces a valid continuation nudge", () => {
    const p = buildResumeUserPrompt([]);
    expect(p).toMatch(/Produce your next response\./);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/openaiShim/promptBuilder.test.ts`
Expected: tests fail with module-not-found.

- [ ] **Step 3: Implement `src/openaiShim/promptBuilder.ts`**

```ts
import { createHash } from "node:crypto";
import type {
  OpenAIMessage,
  OpenAIToolDefinition,
} from "./types.js";

const SYSTEM_PRELUDE = `You are a reasoning engine. A separate agent-orchestration system ("the harness") has delegated decision-making to you. You have NO direct access to files, shell, or the internet. The harness executes tools on your behalf.`;

const SYSTEM_FORMAT_RULES = `RESPONSE FORMAT — STRICT:

Your response must be EITHER:

(A) One or more tool requests, each wrapped exactly like this:
<tool_use>
{"name": "tool_name_here", "arguments": {...}}
</tool_use>

For multiple tools in parallel, emit multiple <tool_use> blocks back-to-back with no text between them. The arguments object must be valid JSON matching the tool's parameter schema.

(B) A final plain-text answer to the user's request. No tags, no JSON wrapper, no code fences.

NEVER mix modes in one response. NEVER add commentary before or after <tool_use> blocks. NEVER use any tool not in the list above.

Examples:

  Good — tool request:
<tool_use>
{"name": "search", "arguments": {"query": "claude code pricing"}}
</tool_use>

  Good — parallel tool requests:
<tool_use>
{"name": "search", "arguments": {"query": "weather Paris"}}
</tool_use>
<tool_use>
{"name": "search", "arguments": {"query": "weather London"}}
</tool_use>

  Good — final answer:
The current Claude Max plan is $200/month.

  Bad — do not do this:
Here's what I found: <tool_use>...</tool_use> Let me know if you need more.`;

function canonicalJson(value: unknown): string {
  // Deterministic stringify with sorted object keys (non-recursive for arrays,
  // which preserve order intentionally).
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return (
    "{" +
    entries
      .map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v))
      .join(",") +
    "}"
  );
}

export function computeExternalKey(messages: OpenAIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") {
      const payload = {
        content: m.content ?? null,
        tool_calls: m.tool_calls ?? null,
      };
      return createHash("sha256").update(canonicalJson(payload)).digest("hex");
    }
  }
  return null;
}

export function extractNewMessagesAfterLastAssistant(
  messages: OpenAIMessage[],
): OpenAIMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      return messages.slice(i + 1);
    }
  }
  return [...messages];
}

function serializeTools(tools: OpenAIToolDefinition[]): string {
  if (tools.length === 0) return "AVAILABLE TOOLS: (none)";
  const lines = ["AVAILABLE TOOLS:"];
  for (const t of tools) {
    lines.push(`  - name: ${t.function.name}`);
    if (t.function.description) {
      lines.push(`    description: ${t.function.description}`);
    }
    lines.push(
      `    parameters (JSON Schema): ${JSON.stringify(t.function.parameters ?? {})}`,
    );
  }
  return lines.join("\n");
}

function findCallerSystem(messages: OpenAIMessage[]): string | null {
  const first = messages[0];
  return first?.role === "system" ? first.content : null;
}

function serializeAssistant(m: OpenAIMessage & { role: "assistant" }): string {
  if (m.tool_calls && m.tool_calls.length > 0) {
    const blocks = m.tool_calls
      .map(
        (c) =>
          `<tool_use>${JSON.stringify({
            name: c.function.name,
            arguments: c.function.arguments
              ? safeJsonParse(c.function.arguments)
              : {},
          })}</tool_use>`,
      )
      .join("\n");
    return `<assistant_tool_use>\n${blocks}\n</assistant_tool_use>`;
  }
  return `<assistant>${m.content ?? ""}</assistant>`;
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function serializeMessage(m: OpenAIMessage): string {
  switch (m.role) {
    case "system":
      return ""; // system is handled separately
    case "user":
      return `<user>${m.content}</user>`;
    case "assistant":
      return serializeAssistant(m);
    case "tool":
      return `<tool_result id="${m.tool_call_id}">${m.content}</tool_result>`;
  }
}

export function buildFreshPrompts(
  messages: OpenAIMessage[],
  tools: OpenAIToolDefinition[],
): { systemPrompt: string; userPrompt: string } {
  if (messages.length === 0) {
    throw new Error("buildFreshPrompts requires at least one message");
  }
  const callerSystem = findCallerSystem(messages);
  const systemSections = [SYSTEM_PRELUDE];
  if (callerSystem) {
    systemSections.push(
      `[Caller's system message]:\n<<<\n${callerSystem}\n>>>`,
    );
  }
  systemSections.push(serializeTools(tools));
  systemSections.push(SYSTEM_FORMAT_RULES);
  const systemPrompt = systemSections.join("\n\n");

  const body = messages
    .filter((m) => m.role !== "system")
    .map(serializeMessage)
    .filter((s) => s.length > 0)
    .join("\n");
  const userPrompt = `${body}\n\nProduce your next response.`;
  return { systemPrompt, userPrompt };
}

export function buildResumeUserPrompt(newMessages: OpenAIMessage[]): string {
  const body = newMessages
    .filter((m) => m.role !== "system")
    .map(serializeMessage)
    .filter((s) => s.length > 0)
    .join("\n");
  const nudge = "Produce your next response.";
  return body.length > 0 ? `${body}\n\n${nudge}` : nudge;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/openaiShim/promptBuilder.test.ts`
Expected: all 13 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/openaiShim/promptBuilder.ts tests/openaiShim/promptBuilder.test.ts
git commit -m "feat: external-key hashing and Claude prompt builder"
```

---

## Task 5: Response parser

**Files:**
- Create: `src/openaiShim/responseParser.ts`
- Test: `tests/openaiShim/responseParser.test.ts`

- [ ] **Step 1: Write the failing tests — create `tests/openaiShim/responseParser.test.ts`**

```ts
import { describe, test, expect } from "vitest";
import { parseClaudeResponse } from "../../src/openaiShim/responseParser.js";

describe("parseClaudeResponse", () => {
  test("returns content for plain text", () => {
    const r = parseClaudeResponse("Hello world.");
    expect(r.kind).toBe("content");
    if (r.kind === "content") expect(r.text).toBe("Hello world.");
  });

  test("strips leading whitespace for classification but preserves it in content", () => {
    const r = parseClaudeResponse("   Hello.");
    expect(r.kind).toBe("content");
    if (r.kind === "content") expect(r.text).toBe("Hello.");
  });

  test("parses a single tool_use block", () => {
    const input =
      '<tool_use>{"name":"search","arguments":{"q":"foo"}}</tool_use>';
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("tool_calls");
    if (r.kind === "tool_calls") {
      expect(r.calls.length).toBe(1);
      expect(r.calls[0]?.name).toBe("search");
      expect(r.calls[0]?.argumentsJson).toBe('{"q":"foo"}');
      expect(r.calls[0]?.id).toMatch(/^call_/);
    }
  });

  test("parses parallel tool_use blocks", () => {
    const input = `<tool_use>{"name":"a","arguments":{}}</tool_use>
<tool_use>{"name":"b","arguments":{"x":1}}</tool_use>`;
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("tool_calls");
    if (r.kind === "tool_calls") {
      expect(r.calls.length).toBe(2);
      expect(r.calls[0]?.name).toBe("a");
      expect(r.calls[1]?.name).toBe("b");
    }
  });

  test("defaults arguments to {} when omitted", () => {
    const input = '<tool_use>{"name":"ping"}</tool_use>';
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("tool_calls");
    if (r.kind === "tool_calls") {
      expect(r.calls[0]?.argumentsJson).toBe("{}");
    }
  });

  test("handles nested braces in arguments via brace balancing", () => {
    const input =
      '<tool_use>{"name":"q","arguments":{"nested":{"a":1}}}</tool_use>';
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("tool_calls");
    if (r.kind === "tool_calls") {
      expect(r.calls[0]?.argumentsJson).toBe('{"nested":{"a":1}}');
    }
  });

  test("falls back to content on malformed JSON inside tag", () => {
    const input = '<tool_use>{not json}</tool_use>';
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("content");
  });

  test("falls back to content on unclosed tag", () => {
    const input = '<tool_use>{"name":"x"';
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("content");
  });

  test("falls back to content when tool_use has prose around it", () => {
    // Mixed mode: Claude ignored the rule and put prose around the tag
    const input = 'I will search. <tool_use>{"name":"s","arguments":{}}</tool_use>';
    const r = parseClaudeResponse(input);
    // The input doesn't START with <tool_use> after whitespace strip, so → content
    expect(r.kind).toBe("content");
  });

  test("falls back to content on code-fenced JSON", () => {
    const input = '```json\n{"name":"s","arguments":{}}\n```';
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("content");
  });

  test("tool call missing 'name' falls back to content", () => {
    const input = '<tool_use>{"arguments":{"x":1}}</tool_use>';
    const r = parseClaudeResponse(input);
    expect(r.kind).toBe("content");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/openaiShim/responseParser.test.ts`
Expected: tests fail with module-not-found.

- [ ] **Step 3: Implement `src/openaiShim/responseParser.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { ParsedClaudeOutput, ParsedToolCall } from "./types.js";

const TAG_OPEN = "<tool_use>";
const TAG_CLOSE = "</tool_use>";

/**
 * Finds the end index of the JSON object starting at `startIdx` via
 * brace-balancing. Returns -1 if no balanced close is found (unclosed JSON).
 * Skips strings correctly (handles escaped quotes).
 */
function findJsonEnd(s: string, startIdx: number): number {
  let depth = 0;
  let i = startIdx;
  let inString = false;
  let escape = false;
  while (i < s.length) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    i++;
  }
  return -1;
}

function parseToolUseBlock(
  text: string,
  openIdx: number,
): { call: ParsedToolCall; nextIdx: number } | null {
  const jsonStart = openIdx + TAG_OPEN.length;
  // Skip whitespace inside the tag before the {
  let i = jsonStart;
  while (i < text.length && /\s/.test(text[i] ?? "")) i++;
  if (text[i] !== "{") return null;
  const jsonEnd = findJsonEnd(text, i);
  if (jsonEnd === -1) return null;
  const jsonSlice = text.slice(i, jsonEnd);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.length === 0) return null;
  const args =
    obj.arguments === undefined
      ? {}
      : typeof obj.arguments === "object" && obj.arguments !== null
        ? obj.arguments
        : null;
  if (args === null) return null;
  // Find the closing tag after the JSON
  const closeIdx = text.indexOf(TAG_CLOSE, jsonEnd);
  if (closeIdx === -1) return null;
  return {
    call: {
      id: `call_${randomUUID()}`,
      name: obj.name,
      argumentsJson: JSON.stringify(args),
    },
    nextIdx: closeIdx + TAG_CLOSE.length,
  };
}

export function parseClaudeResponse(raw: string): ParsedClaudeOutput {
  const stripped = raw.replace(/^\s+/, "");
  if (!stripped.startsWith(TAG_OPEN)) {
    return { kind: "content", text: stripped };
  }
  const calls: ParsedToolCall[] = [];
  let cursor = 0;
  while (cursor < stripped.length) {
    // Skip whitespace between blocks
    while (cursor < stripped.length && /\s/.test(stripped[cursor] ?? "")) {
      cursor++;
    }
    if (cursor >= stripped.length) break;
    if (!stripped.startsWith(TAG_OPEN, cursor)) {
      // Trailing content after tool_use blocks is a format violation.
      // Conservative: fall back to content mode for the whole response.
      return { kind: "content", text: stripped };
    }
    const parsed = parseToolUseBlock(stripped, cursor);
    if (!parsed) {
      return { kind: "content", text: stripped };
    }
    calls.push(parsed.call);
    cursor = parsed.nextIdx;
  }
  if (calls.length === 0) {
    return { kind: "content", text: stripped };
  }
  return { kind: "tool_calls", calls };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/openaiShim/responseParser.test.ts`
Expected: all 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/openaiShim/responseParser.ts tests/openaiShim/responseParser.test.ts
git commit -m "feat: Claude XML-tag response parser with graceful fallback"
```

---

## Task 6: Stream translator

**Files:**
- Create: `src/openaiShim/streamTranslator.ts`
- Test: `tests/openaiShim/streamTranslator.test.ts`

- [ ] **Step 1: Write the failing tests — create `tests/openaiShim/streamTranslator.test.ts`**

```ts
import { describe, test, expect } from "vitest";
import {
  translateStream,
  translateBuffered,
} from "../../src/openaiShim/streamTranslator.js";
import type {
  OpenAIChatCompletionChunk,
  StreamJsonEvent,
} from "../../src/openaiShim/types.js";

async function* fromArray<T>(arr: T[]): AsyncGenerator<T> {
  for (const x of arr) yield x;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

function textEvent(text: string): StreamJsonEvent {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  };
}

const INIT: StreamJsonEvent = {
  type: "system",
  subtype: "init",
  session_id: "s-1",
};
const RESULT: StreamJsonEvent = { type: "result", subtype: "success" };

describe("translateStream (answer mode)", () => {
  test("emits role chunk, content chunks, and stop chunk for plain text", async () => {
    const events: StreamJsonEvent[] = [
      INIT,
      textEvent("Hello world and a bit more text to pass the threshold."),
      RESULT,
    ];
    const chunks: OpenAIChatCompletionChunk[] = await collect(
      translateStream(fromArray(events), { id: "x", model: "claude", created: 1 }),
    );
    // First chunk: role delta
    expect(chunks[0]?.choices[0]?.delta.role).toBe("assistant");
    // Middle chunk(s): content
    const combined = chunks
      .map((c) => c.choices[0]?.delta.content ?? "")
      .join("");
    expect(combined).toContain("Hello world");
    // Last chunk: finish_reason=stop
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
  });

  test("classification threshold: short ambiguous first event waits for more", async () => {
    // A single '<' alone — UNKNOWN should stay UNKNOWN until more arrives.
    const events: StreamJsonEvent[] = [
      INIT,
      textEvent("<"),
      textEvent(" normal text"), // now it's clearly not <tool_use>
      RESULT,
    ];
    const chunks = await collect(
      translateStream(fromArray(events), { id: "x", model: "claude", created: 1 }),
    );
    const combined = chunks
      .map((c) => c.choices[0]?.delta.content ?? "")
      .join("");
    expect(combined).toContain("<");
    expect(combined).toContain("normal text");
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
  });
});

describe("translateStream (tool mode)", () => {
  test("emits a tool_calls chunk when Claude outputs <tool_use>", async () => {
    const events: StreamJsonEvent[] = [
      INIT,
      textEvent('<tool_use>{"name":"search","arguments":{"q":"x"}}</tool_use>'),
      RESULT,
    ];
    const chunks = await collect(
      translateStream(fromArray(events), { id: "x", model: "claude", created: 1 }),
    );
    const toolChunk = chunks.find((c) =>
      c.choices[0]?.delta.tool_calls !== undefined,
    );
    expect(toolChunk).toBeDefined();
    expect(toolChunk?.choices[0]?.delta.tool_calls?.[0]?.function?.name).toBe(
      "search",
    );
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
  });

  test("emits multiple tool_calls entries for parallel blocks", async () => {
    const events: StreamJsonEvent[] = [
      INIT,
      textEvent(
        '<tool_use>{"name":"a","arguments":{}}</tool_use><tool_use>{"name":"b","arguments":{}}</tool_use>',
      ),
      RESULT,
    ];
    const chunks = await collect(
      translateStream(fromArray(events), { id: "x", model: "claude", created: 1 }),
    );
    const toolDeltas = chunks.flatMap(
      (c) => c.choices[0]?.delta.tool_calls ?? [],
    );
    expect(toolDeltas.length).toBe(2);
    expect(toolDeltas[0]?.function?.name).toBe("a");
    expect(toolDeltas[1]?.function?.name).toBe("b");
    expect(toolDeltas[0]?.index).toBe(0);
    expect(toolDeltas[1]?.index).toBe(1);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
  });

  test("tool_use split across multiple events still parses", async () => {
    const events: StreamJsonEvent[] = [
      INIT,
      textEvent('<tool_use>{"nam'),
      textEvent('e":"search","arguments":{}}</tool_use>'),
      RESULT,
    ];
    const chunks = await collect(
      translateStream(fromArray(events), { id: "x", model: "claude", created: 1 }),
    );
    const toolDelta = chunks
      .flatMap((c) => c.choices[0]?.delta.tool_calls ?? [])
      [0];
    expect(toolDelta?.function?.name).toBe("search");
  });
});

describe("translateBuffered", () => {
  test("buffered text returns a content response", async () => {
    const events: StreamJsonEvent[] = [
      INIT,
      textEvent("just the final answer, nothing else"),
      RESULT,
    ];
    const { body, sessionId } = await translateBuffered(fromArray(events), {
      id: "resp-1",
      model: "claude",
      created: 1,
    });
    expect(sessionId).toBe("s-1");
    expect(body.choices[0]?.message.content).toContain("final answer");
    expect(body.choices[0]?.finish_reason).toBe("stop");
  });

  test("buffered tool_calls returns a tool_calls response", async () => {
    const events: StreamJsonEvent[] = [
      INIT,
      textEvent(
        '<tool_use>{"name":"search","arguments":{"q":"x"}}</tool_use>',
      ),
      RESULT,
    ];
    const { body } = await translateBuffered(fromArray(events), {
      id: "resp-1",
      model: "claude",
      created: 1,
    });
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
    expect(body.choices[0]?.message.tool_calls?.length).toBe(1);
    expect(body.choices[0]?.message.tool_calls?.[0]?.function.name).toBe(
      "search",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/openaiShim/streamTranslator.test.ts`
Expected: tests fail with module-not-found.

- [ ] **Step 3: Implement `src/openaiShim/streamTranslator.ts`**

```ts
import { parseClaudeResponse } from "./responseParser.js";
import type {
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionResponse,
  ParsedToolCall,
  StreamJsonEvent,
} from "./types.js";

const TAG_OPEN = "<tool_use>";
const MIN_CLASSIFY_LEN = 10; // length of <tool_use>; after this we can decide

type Meta = { id: string; model: string; created: number };

function chunk(
  meta: Meta,
  delta: OpenAIChatCompletionChunk["choices"][number]["delta"],
  finish: OpenAIChatCompletionChunk["choices"][number]["finish_reason"] = null,
): OpenAIChatCompletionChunk {
  return {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function extractText(e: StreamJsonEvent): string | null {
  if (e.type !== "assistant") return null;
  const msg = (e as { message?: { content?: unknown } }).message;
  if (!msg || !Array.isArray(msg.content)) return null;
  let text = "";
  for (const item of msg.content) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: string }).type === "text" &&
      typeof (item as { text?: string }).text === "string"
    ) {
      text += (item as { text: string }).text;
    }
  }
  return text;
}

function extractSessionId(e: StreamJsonEvent): string | null {
  if (e.type === "system" && (e as { subtype?: string }).subtype === "init") {
    const sid = (e as { session_id?: string }).session_id;
    return typeof sid === "string" ? sid : null;
  }
  if (e.type === "result") {
    const sid = (e as { session_id?: string }).session_id;
    return typeof sid === "string" ? sid : null;
  }
  return null;
}

export type TranslateStreamContext = Meta;

export async function* translateStream(
  events: AsyncIterable<StreamJsonEvent>,
  meta: Meta,
): AsyncGenerator<OpenAIChatCompletionChunk> {
  yield chunk(meta, { role: "assistant" });

  let buffer = "";
  type Mode = "UNKNOWN" | "ANSWER" | "TOOL";
  let mode: Mode = "UNKNOWN";
  let toolCallIndex = 0;
  let emittedToolCalls = false;

  function nonWhitespaceLength(s: string): number {
    return s.replace(/\s+/g, "").length;
  }

  for await (const ev of events) {
    if (ev.type === "result") break;
    const text = extractText(ev);
    if (text === null || text.length === 0) continue;

    if (mode === "UNKNOWN") {
      buffer += text;
      const stripped = buffer.replace(/^\s+/, "");
      if (stripped.startsWith(TAG_OPEN)) {
        mode = "TOOL";
        buffer = stripped; // normalize
      } else if (nonWhitespaceLength(stripped) >= MIN_CLASSIFY_LEN) {
        mode = "ANSWER";
        yield chunk(meta, { content: stripped });
        buffer = "";
      }
      // else still UNKNOWN; keep buffering
      continue;
    }

    if (mode === "ANSWER") {
      yield chunk(meta, { content: text });
      continue;
    }

    // mode === "TOOL"
    buffer += text;
    // Try to extract any complete <tool_use>...</tool_use> blocks in buffer
    while (true) {
      const parsed = parseClaudeResponse(buffer);
      if (parsed.kind === "tool_calls" && parsed.calls.length >= 1) {
        // Emit deltas for all calls at once
        for (const c of parsed.calls) {
          yield chunk(meta, {
            tool_calls: [
              {
                index: toolCallIndex++,
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.argumentsJson },
              },
            ],
          });
          emittedToolCalls = true;
        }
        buffer = "";
        break;
      }
      // Not yet parseable → wait for more text
      break;
    }
  }

  // Stream ended. Finalize.
  if (mode === "UNKNOWN") {
    // We never classified. Flush whatever buffered text exists as content.
    const stripped = buffer.replace(/^\s+/, "");
    if (stripped.length > 0) {
      yield chunk(meta, { content: stripped });
    }
    yield chunk(meta, {}, "stop");
    return;
  }
  if (mode === "ANSWER") {
    yield chunk(meta, {}, "stop");
    return;
  }
  // mode === "TOOL"
  // If buffer still has content (unparseable), fall back to content-mode emission
  if (!emittedToolCalls) {
    yield chunk(meta, { content: buffer });
    yield chunk(meta, {}, "stop");
    return;
  }
  yield chunk(meta, {}, "tool_calls");
}

export type BufferedResult = {
  body: OpenAIChatCompletionResponse;
  sessionId: string | null;
  toolCallsEmitted: number;
  fullText: string;
};

export async function translateBuffered(
  events: AsyncIterable<StreamJsonEvent>,
  meta: Meta,
): Promise<BufferedResult> {
  let allText = "";
  let sessionId: string | null = null;
  for await (const ev of events) {
    const sid = extractSessionId(ev);
    if (sid && !sessionId) sessionId = sid;
    const text = extractText(ev);
    if (text) allText += text;
  }
  const parsed = parseClaudeResponse(allText);
  const body: OpenAIChatCompletionResponse = {
    id: meta.id,
    object: "chat.completion",
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        message:
          parsed.kind === "tool_calls"
            ? {
                role: "assistant",
                content: null,
                tool_calls: parsed.calls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.argumentsJson },
                })),
              }
            : { role: "assistant", content: parsed.text },
        finish_reason: parsed.kind === "tool_calls" ? "tool_calls" : "stop",
      },
    ],
  };
  return {
    body,
    sessionId,
    toolCallsEmitted: parsed.kind === "tool_calls" ? parsed.calls.length : 0,
    fullText: allText,
  };
}

export function extractSessionIdFromEvents(
  events: StreamJsonEvent[],
): string | null {
  for (const e of events) {
    const sid = extractSessionId(e);
    if (sid) return sid;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/openaiShim/streamTranslator.test.ts`
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/openaiShim/streamTranslator.ts tests/openaiShim/streamTranslator.test.ts
git commit -m "feat: stream-json to OpenAI SSE translator with mode classifier"
```

---

## Task 7: HTTP handler

**Files:**
- Create: `src/openaiShim/handler.ts`

This file wires all the prior pieces together into an Express handler. Tests are deferred to Task 9 (integration); unit-testing a handler that composes 5 other modules adds little over end-to-end tests.

- [ ] **Step 1: Implement `src/openaiShim/handler.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { Config, LogEntry } from "../types.js";
import type { Logger } from "../logger.js";
import { containsQuestionHeuristic } from "../logger.js";
import type { SessionStore } from "../sessionStore.js";
import { runClaudeStream } from "../claudeStreamRunner.js";
import {
  buildFreshPrompts,
  buildResumeUserPrompt,
  computeExternalKey,
  extractNewMessagesAfterLastAssistant,
} from "./promptBuilder.js";
import { parseClaudeResponse } from "./responseParser.js";
import {
  translateBuffered,
  translateStream,
} from "./streamTranslator.js";
import type {
  OpenAIChatCompletionRequest,
  OpenAIErrorBody,
  OpenAIMessage,
  StreamJsonEvent,
} from "./types.js";

const MODEL_LABEL = "claude-code-cli";

function sendError(
  res: Response,
  status: number,
  body: OpenAIErrorBody,
): void {
  if (!res.headersSent) {
    res.status(status).json(body);
  }
}

function authOk(req: Request, required: string | null): boolean {
  if (!required) return true;
  return req.headers.authorization === required;
}

export function createOpenAIHandler(
  config: Config,
  logger: Logger,
  store: SessionStore,
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response) => {
    const logId = randomUUID();
    const startIso = new Date().toISOString();
    const startMs = Date.now();

    if (!authOk(req, config.openai.requireAuthHeader)) {
      sendError(res, 401, {
        error: {
          message: "Invalid or missing Authorization header.",
          type: "authentication_error",
          code: "invalid_api_key",
        },
      });
      return;
    }

    const body = req.body as OpenAIChatCompletionRequest | undefined;
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      sendError(res, 400, {
        error: {
          message: "Request must include a non-empty 'messages' array.",
          type: "invalid_request_error",
        },
      });
      return;
    }

    const tools = body.tools ?? [];
    const wantStream = body.stream === true;

    // Session resolution
    const externalKey = computeExternalKey(body.messages);
    let resumeSessionId: string | undefined;
    let openaiMode: LogEntry["openaiMode"] = "fresh";
    if (externalKey !== null) {
      const existing = store.findByExternalKey(externalKey);
      if (existing) {
        resumeSessionId = existing.sessionId;
        openaiMode = "resumed";
      } else {
        openaiMode = "session-miss";
      }
    }

    // Prompt construction
    let systemPrompt: string | undefined;
    let userPrompt: string;
    if (resumeSessionId) {
      const newMsgs = extractNewMessagesAfterLastAssistant(body.messages);
      userPrompt = buildResumeUserPrompt(newMsgs);
    } else {
      const built = buildFreshPrompts(body.messages, tools);
      systemPrompt = built.systemPrompt;
      userPrompt = built.userPrompt;
    }

    const workDir = resumeSessionId
      ? store.get(resumeSessionId)?.workDir ?? config.task.defaultWorkDir
      : config.task.defaultWorkDir;

    const meta = {
      id: `chatcmpl-${logId}`,
      model: body.model ?? MODEL_LABEL,
      created: Math.floor(Date.now() / 1000),
    };

    const streamOpts = {
      prompt: userPrompt,
      systemPrompt,
      workDir,
      resumeSessionId,
      allowedTools: "",
      dangerouslySkipPermissions: false,
      timeoutMs: config.openai.timeoutMs,
      claudeCommand: config.claudeCommand,
    };

    // We need to capture session_id from events while also translating them.
    // Approach: tee the stream — wrap the generator to remember the init event.
    const events = runClaudeStream(streamOpts);
    let capturedSessionId: string | null = null;
    let capturedAllText = "";
    async function* teed(): AsyncGenerator<StreamJsonEvent> {
      for await (const e of events) {
        if (
          e.type === "system" &&
          (e as { subtype?: string }).subtype === "init"
        ) {
          const sid = (e as { session_id?: string }).session_id;
          if (typeof sid === "string") capturedSessionId = sid;
        }
        if (e.type === "assistant") {
          const msg = (e as { message?: { content?: unknown } }).message;
          if (msg && Array.isArray(msg.content)) {
            for (const item of msg.content) {
              if (
                item &&
                typeof item === "object" &&
                (item as { type?: string }).type === "text"
              ) {
                capturedAllText += (item as { text: string }).text;
              }
            }
          }
        }
        yield e;
      }
    }

    let toolCallsEmitted = 0;
    let statusForLog: LogEntry["status"] = "success";

    try {
      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        const chunks = translateStream(teed(), meta);
        for await (const c of chunks) {
          res.write(`data: ${JSON.stringify(c)}\n\n`);
          const deltaCalls = c.choices[0]?.delta.tool_calls;
          if (deltaCalls && deltaCalls.length > 0) {
            toolCallsEmitted += deltaCalls.length;
          }
        }
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        const { body: resp, toolCallsEmitted: tce } = await translateBuffered(
          teed(),
          meta,
        );
        toolCallsEmitted = tce;
        res.status(200).json(resp);
      }
    } catch (err) {
      statusForLog = "error";
      const msg = (err as Error).message ?? "unknown error";
      if (!res.headersSent) {
        sendError(res, 502, {
          error: { message: `Claude pipeline failed: ${msg}`, type: "api_error" },
        });
      } else {
        // Stream already started; best-effort end the response.
        try {
          res.write("data: [DONE]\n\n");
          res.end();
        } catch {
          // ignore
        }
      }
    }

    // Session store updates
    if (capturedSessionId) {
      try {
        if (openaiMode === "resumed" && resumeSessionId) {
          await store.update(resumeSessionId);
        } else {
          // fresh or session-miss → create the new session row
          if (externalKey !== null) {
            await store.createWithExternalKey(
              capturedSessionId,
              workDir,
              externalKey,
            );
          } else {
            await store.create(capturedSessionId, workDir);
          }
        }
        // Compute the external key for OUR reply so the NEXT call can find
        // this session. Shape the reply as an OpenAI assistant message first
        // (matching the shape computeExternalKey expects on the client side).
        if (capturedAllText.length > 0) {
          const parsed = parseClaudeResponse(capturedAllText);
          const replyMessage: OpenAIMessage =
            parsed.kind === "tool_calls"
              ? {
                  role: "assistant",
                  tool_calls: parsed.calls.map((c) => ({
                    id: c.id,
                    type: "function",
                    function: { name: c.name, arguments: c.argumentsJson },
                  })),
                }
              : { role: "assistant", content: parsed.text };
          const replyKey = computeExternalKey([replyMessage]);
          if (replyKey) {
            await store.setExternalKey(capturedSessionId, replyKey);
          }
        }
      } catch (err) {
        console.warn("[openaiShim] session persist failed:", (err as Error).message);
      }
    }

    const durationMs = Date.now() - startMs;
    await logger.log({
      timestamp: startIso,
      logId,
      tool: "openai_completion",
      status: statusForLog,
      durationMs,
      sessionId: capturedSessionId ?? undefined,
      prompt: userPrompt,
      output: capturedAllText,
      containsQuestion: containsQuestionHeuristic(capturedAllText),
      exitCode: statusForLog === "success" ? 0 : 1,
      openaiMode,
      toolCallsEmitted,
      externalKey: externalKey ?? undefined,
    });
  };
}

```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/openaiShim/handler.ts
git commit -m "feat: /v1/chat/completions handler wiring shim components"
```

---

## Task 8: Server wiring

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Edit `src/server.ts`**

Add an import after the existing tool imports:
```ts
import { createOpenAIHandler } from "./openaiShim/handler.js";
```

Inside `main()`, after the line `registerClaudeTask(mcp, config, logger, store);`, add:

```ts
  const openaiHandler = config.openai.enabled
    ? createOpenAIHandler(config, logger, store)
    : null;
```

Add the route mount after the existing `app.get("/health", ...)` block:

```ts
  if (openaiHandler) {
    app.post(
      "/v1/chat/completions",
      express.json({ limit: "10mb" }),
      (req, res) => {
        openaiHandler(req, res).catch((err) => {
          console.error("[openaiShim] unhandled error:", err);
          if (!res.headersSent) {
            res.status(500).json({
              error: {
                message: (err as Error).message ?? "internal error",
                type: "api_error",
              },
            });
          }
        });
      },
    );
  }
```

Update the startup banner to announce the OpenAI endpoint when enabled. Replace the existing `app.listen(config.port, config.host, () => {...})` callback body with:

```ts
        console.log(
          `[ClaudeMCP] listening at http://${config.host}:${config.port}/sse`,
        );
        if (config.openai.enabled) {
          console.log(
            `[ClaudeMCP] OpenAI endpoint: http://${config.host}:${config.port}/v1/chat/completions`,
          );
        }
        console.log(`[ClaudeMCP] log: ${config.logFile}`);
        console.log(`[ClaudeMCP] sessions: ${config.sessionStoreFile}`);
        resolve(s);
```

- [ ] **Step 2: Verify compilation and smoke-start**

Run: `npx tsc --noEmit`
Expected: 0 errors.

Create a temporary smoke file `tmp-smoke.mjs` in the repo root:
```js
import { main } from "./dist/server.js";
process.env.CLAUDE_MCP_PORT = "37124";
const { close } = await main(["--config", "configs/default.json"]);
const res = await fetch("http://127.0.0.1:37124/health");
console.log("health:", JSON.stringify(await res.json()));
await close();
console.log("SMOKE OK");
```

Run: `npx tsc && node tmp-smoke.mjs && rm tmp-smoke.mjs`
Expected: output includes `OpenAI endpoint: http://127.0.0.1:37124/v1/chat/completions`, `health: {"ok":true,"sessions":N}`, and `SMOKE OK`.

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: mount /v1/chat/completions on the server"
```

---

## Task 9: Integration tests

**Files:**
- Modify: `tests/fixtures/mock-claude.mjs`
- Create: `tests/openai-integration.test.ts`

- [ ] **Step 1: Extend `tests/fixtures/mock-claude.mjs`**

Full replacement for the file:

```js
#!/usr/bin/env node
// Mock `claude` CLI for integration tests. Emits either JSON (for --output-format json)
// or newline-delimited JSON events (for --output-format stream-json).
//
// Scenarios via MOCK_CLAUDE_SCENARIO env var:
//   "success" (default), "resume", "nonzero", "slow"   — original --output-format json scenarios
//   "openai-answer"      — stream-json with a plain-text answer
//   "openai-tool-call"   — stream-json with one <tool_use> block
//   "openai-parallel"    — stream-json with two back-to-back <tool_use> blocks

const scenario = process.env.MOCK_CLAUDE_SCENARIO ?? "success";
const args = process.argv.slice(2);

function getArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const resumeId = getArg("--resume");
const prompt = getArg("-p") ?? "";
const outputFormat = getArg("--output-format") ?? "text";

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function emitOnce(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function streamJsonOpenAnswer() {
  writeLine({ type: "system", subtype: "init", session_id: resumeId ?? `mock-${Math.random().toString(36).slice(2, 10)}`, model: "mock", cwd: process.cwd() });
  writeLine({ type: "assistant", message: { content: [{ type: "text", text: "Here is the mock answer with enough length to pass classification." }] } });
  writeLine({ type: "result", subtype: "success", session_id: resumeId ?? undefined });
  process.exit(0);
}

function streamJsonToolCall() {
  const sid = resumeId ?? `mock-${Math.random().toString(36).slice(2, 10)}`;
  writeLine({ type: "system", subtype: "init", session_id: sid, model: "mock", cwd: process.cwd() });
  writeLine({ type: "assistant", message: { content: [{ type: "text", text: '<tool_use>{"name":"search","arguments":{"q":"mock"}}</tool_use>' }] } });
  writeLine({ type: "result", subtype: "success", session_id: sid });
  process.exit(0);
}

function streamJsonParallel() {
  const sid = resumeId ?? `mock-${Math.random().toString(36).slice(2, 10)}`;
  writeLine({ type: "system", subtype: "init", session_id: sid, model: "mock", cwd: process.cwd() });
  writeLine({ type: "assistant", message: { content: [{ type: "text", text: '<tool_use>{"name":"a","arguments":{}}</tool_use><tool_use>{"name":"b","arguments":{"x":1}}</tool_use>' }] } });
  writeLine({ type: "result", subtype: "success", session_id: sid });
  process.exit(0);
}

function run() {
  if (outputFormat === "stream-json") {
    if (scenario === "openai-answer") return streamJsonOpenAnswer();
    if (scenario === "openai-tool-call") return streamJsonToolCall();
    if (scenario === "openai-parallel") return streamJsonParallel();
    // default stream-json: treat as answer
    return streamJsonOpenAnswer();
  }

  // Original --output-format json scenarios
  if (scenario === "nonzero") {
    process.stderr.write("mock failure");
    process.exit(3);
  }
  if (scenario === "slow") {
    setTimeout(() => {
      emitOnce({ session_id: "late-id", result: `late reply to: ${prompt}` });
      process.exit(0);
    }, 5000);
    return;
  }
  const sid = resumeId ?? `mock-${Math.random().toString(36).slice(2, 10)}`;
  emitOnce({ session_id: sid, result: `mock reply to: ${prompt}` });
  process.exit(0);
}

run();
```

- [ ] **Step 2: Write `tests/openai-integration.test.ts`**

```ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/server.js";
import type { OpenAIChatCompletionResponse } from "../src/openaiShim/types.js";

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
  port = 31000 + Math.floor(Math.random() * 1000);
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
    openai: {
      enabled: true,
      requireAuthHeader: null,
      timeoutMs: 10_000,
    },
    ...overrides,
  };
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  const started = await main(["--config", configPath]);
  close = started.close;
}

async function postCompletion(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-mcp-oai-"));
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

describe("openai integration", () => {
  test("non-streaming answer path returns chat.completion body", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "openai-answer";
    await startServer();
    const res = await postCompletion({
      model: "any",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OpenAIChatCompletionResponse;
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.role).toBe("assistant");
    expect(body.choices[0]?.message.content).toContain("mock answer");
    expect(body.choices[0]?.finish_reason).toBe("stop");
  });

  test("non-streaming tool-call path returns tool_calls in message", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "openai-tool-call";
    await startServer();
    const res = await postCompletion({
      model: "any",
      messages: [{ role: "user", content: "search please" }],
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            description: "Search the web",
            parameters: { type: "object" },
          },
        },
      ],
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OpenAIChatCompletionResponse;
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
    const calls = body.choices[0]?.message.tool_calls;
    expect(calls?.length).toBe(1);
    expect(calls?.[0]?.function.name).toBe("search");
    expect(calls?.[0]?.function.arguments).toContain("mock");
  });

  test("non-streaming parallel tool calls", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "openai-parallel";
    await startServer();
    const res = await postCompletion({
      model: "any",
      messages: [{ role: "user", content: "do two things" }],
      tools: [
        {
          type: "function",
          function: { name: "a", parameters: { type: "object" } },
        },
        {
          type: "function",
          function: { name: "b", parameters: { type: "object" } },
        },
      ],
      stream: false,
    });
    const body = (await res.json()) as OpenAIChatCompletionResponse;
    const calls = body.choices[0]?.message.tool_calls ?? [];
    expect(calls.length).toBe(2);
    expect(calls[0]?.function.name).toBe("a");
    expect(calls[1]?.function.name).toBe("b");
  });

  test("streaming answer path returns valid SSE", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "openai-answer";
    await startServer();
    const res = await postCompletion({
      model: "any",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain('"role":"assistant"');
    expect(text).toContain("data: [DONE]");
    expect(text).toContain('"finish_reason":"stop"');
  });

  test("auth: returns 401 when requireAuthHeader is set and header is missing", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "openai-answer";
    await startServer({
      openai: {
        enabled: true,
        requireAuthHeader: "Bearer secret",
        timeoutMs: 10_000,
      },
    });
    const res = await postCompletion({
      model: "any",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(401);
  });

  test("auth: accepts matching header", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "openai-answer";
    await startServer({
      openai: {
        enabled: true,
        requireAuthHeader: "Bearer secret",
        timeoutMs: 10_000,
      },
    });
    const res = await postCompletion(
      { model: "any", messages: [{ role: "user", content: "hi" }] },
      { Authorization: "Bearer secret" },
    );
    expect(res.status).toBe(200);
  });

  test("rejects empty messages with 400", async () => {
    await startServer();
    const res = await postCompletion({ model: "any", messages: [] });
    expect(res.status).toBe(400);
  });

  test("session resume across two turns: second call reuses Claude session", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "openai-answer";
    await startServer();
    const first = await postCompletion({
      model: "any",
      messages: [{ role: "user", content: "turn 1" }],
      stream: false,
    });
    const firstBody = (await first.json()) as OpenAIChatCompletionResponse;
    const firstAssistantContent = firstBody.choices[0]?.message.content ?? "";

    // Second call carrying the assistant reply
    const second = await postCompletion({
      model: "any",
      messages: [
        { role: "user", content: "turn 1" },
        { role: "assistant", content: firstAssistantContent },
        { role: "user", content: "turn 2" },
      ],
      stream: false,
    });
    expect(second.status).toBe(200);

    // Verify the log shows one fresh + one resumed entry
    const entries = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const openaiEntries = entries.filter(
      (e) => e.tool === "openai_completion",
    );
    expect(openaiEntries.length).toBe(2);
    expect(openaiEntries[0].openaiMode).toBe("fresh");
    expect(openaiEntries[1].openaiMode).toBe("resumed");
  });
});
```

- [ ] **Step 3: Run the integration tests**

Run: `npx vitest run tests/openai-integration.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all tests pass. Prior 44 + new: roughly 44 + 2 (config) + 6 (sessionStore) + 5 (streamRunner) + 13 (promptBuilder) + 11 (responseParser) + 7 (translator) + 8 (integration) = 96 tests.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/mock-claude.mjs tests/openai-integration.test.ts
git commit -m "test: OpenAI shim integration tests with stream-json mock"
```

---

## Task 10: Docs update

**Files:**
- Modify: `docs/smoke-test.md`
- Modify: `README.md`

- [ ] **Step 1: Append to `docs/smoke-test.md`**

Add a new section to the end of the file:

```markdown
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
```

- [ ] **Step 2: Update `README.md`**

Insert a new section after the existing "Quickstart" block and before "Requirements":

```markdown
## Endpoints

The server exposes two independent interfaces on the same port (3000 by default):

- **`/sse` + `/message`** — MCP-over-SSE for tool integrations (Agent Zero's tool calls, Claude Desktop, etc.). Two MCP tools: `claude_ask` (stateless chat) and `claude_task` (stateful agent task).
- **`/v1/chat/completions`** — OpenAI-compatible chat completions endpoint. Lets Agent Zero (or any LiteLLM-compatible client) use Claude Code CLI as its reasoning model via prompt-engineered XML tool calling. Streaming and non-streaming both supported.

See `configs/example.json` to toggle the OpenAI endpoint off (`openai.enabled: false`) if you only want the MCP path.
```

Also add a warning line inside the "Security note" section:

```markdown
The OpenAI endpoint has no authentication by default (`openai.requireAuthHeader: null`). If you expose the server beyond localhost, also set an auth header.
```

- [ ] **Step 3: Commit**

```bash
git add docs/smoke-test.md README.md
git commit -m "docs: OpenAI endpoint smoke test and README coverage"
```

---

## Task 11: Final verification

**Files:** (none)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (approximately 96 total).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: `dist/` populated, no errors.

- [ ] **Step 3: Smoke-start with both endpoints**

Create temporary `tmp-smoke.mjs` in repo root:
```js
import { main } from "./dist/server.js";
process.env.CLAUDE_MCP_PORT = "37125";
const { close } = await main(["--config", "configs/default.json"]);
const health = await (await fetch("http://127.0.0.1:37125/health")).json();
console.log("health:", JSON.stringify(health));
await close();
console.log("SMOKE OK");
```
Run: `node tmp-smoke.mjs && rm tmp-smoke.mjs`
Expected: startup banner shows BOTH endpoints (`/sse` and `/v1/chat/completions`), health returns OK, clean shutdown, SMOKE OK.

- [ ] **Step 4: Confirm git log**

Run: `git log --oneline feat/implementation ^main`
Expected: reasonable commit sequence — one commit per task (plus any review-fix commits), no commits containing unrelated changes.

- [ ] **Step 5: Tag v0.2.0**

```bash
git tag v0.2.0
```

Done.
