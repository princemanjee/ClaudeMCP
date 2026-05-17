# Plan 01: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the foundation modules every subsequent plan depends on — the `Backend` interface and normalized types, a multi-scheme `auth` utility, a Zod-validated config loader spanning four backends, an SQLite archive schema with connection management, a backend-identification model router, and a registry skeleton that will host backends once they exist.

**Architecture:** TypeScript modules under `src/`, ESM, no public HTTP surface yet. Every module is independently unit-testable with Vitest. No backend implementations land in this plan — only the contracts and shared infrastructure they will plug into. The committed `dist/` from the previous ClaudeMCP iteration stays untouched; Plan 02 will refactor it behind the new `Backend` interface.

**Tech Stack:** Node.js 20+, TypeScript 5, ESM modules, Zod for config validation, `better-sqlite3` for archive storage, Vitest + Supertest for tests.

**Spec:** `docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md`

---

## File map

| File | Responsibility |
|---|---|
| `package.json` | Dependencies, scripts |
| `tsconfig.json` | Strict TypeScript config, ESM module target |
| `vitest.config.ts` | Test runner config |
| `.gitignore` | Exclude `node_modules`, `dist`, `data`, `logs`, `.env` |
| `src/backends/types.ts` | `Backend` interface, `BackendCapabilities`, `NormalizedRequest`, `NormalizedEvent`, `ModelDescriptor` |
| `src/config.ts` | Zod schema for the multi-backend config; `loadConfig(path)` returns frozen object |
| `src/auth.ts` | `checkAuth(req, configApiKey)` accepting `x-api-key`, `Authorization: Bearer`, `x-goog-api-key`, or `?key=` |
| `src/archive.ts` | Open SQLite db, run schema migration, expose `Archive` class with `close()`. Writers come in Plan 05 |
| `src/modelRouter.ts` | `identifyBackend(model, defaultBackend)` returns the backend id without resolving the model (model resolution lives in registry once backends exist) |
| `src/backends/registry.ts` | `BackendRegistry` skeleton: holds a map of `BackendId -> Backend`, supports `register`/`get`/`enabledBackends`. Periodic probe loop scaffolded but no-ops until backends register |
| `configs/default.json` | Shipped default config matching the Zod schema |
| `configs/example.json` | Annotated copy with `_comments` block per knob |
| `tests/unit/auth.test.ts` | Unit tests for `auth.ts` |
| `tests/unit/config.test.ts` | Unit tests for `config.ts` |
| `tests/unit/archive.test.ts` | Unit tests for `archive.ts` schema creation + idempotent reopen |
| `tests/unit/modelRouter.test.ts` | Unit tests for `identifyBackend` resolution rules |
| `tests/unit/backends/registry.test.ts` | Unit tests for `BackendRegistry` skeleton |
| `tests/unit/backends/types.test.ts` | Type-level smoke test ensuring `NormalizedEvent` union compiles |

---

## Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claude-mcp",
  "version": "0.2.0",
  "description": "Multi-backend local gateway for Claude, Gemini, LM Studio, and Ollama",
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
    "better-sqlite3": "^11.5.0",
    "cross-spawn": "^7.0.6",
    "express": "^4.21.1",
    "tree-kill": "^1.2.2",
    "uuid": "^11.0.3",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/cross-spawn": "^6.0.6",
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.0",
    "@types/supertest": "^6.0.2",
    "@types/uuid": "^10.0.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "declaration": false,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/bin.ts"]
    }
  }
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
data/
logs/
coverage/
.env
*.tsbuildinfo
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: Completes without error; `node_modules/` populated.

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors (nothing to compile yet — empty `src/`).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore: scaffold TypeScript + Vitest project for Plan 01 foundation"
```

---

## Task 2: Normalized backend types

**Files:**
- Create: `src/backends/types.ts`
- Test: `tests/unit/backends/types.test.ts`

- [ ] **Step 1: Write the failing type-level test**

Create `tests/unit/backends/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type {
  Backend,
  BackendCapabilities,
  BackendId,
  ModelDescriptor,
  NormalizedEmbeddingRequest,
  NormalizedEmbeddingResponse,
  NormalizedEvent,
  NormalizedRequest
} from "../../../src/backends/types.js";

describe("backend types", () => {
  it("permits the four expected backend ids", () => {
    const ids: BackendId[] = ["claude", "gemini", "lmstudio", "ollama"];
    expect(ids).toHaveLength(4);
  });

  it("constructs a minimal NormalizedRequest", () => {
    const req: NormalizedRequest = {
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    };
    expect(req.model).toBe("claude-opus-4-7");
  });

  it("constructs all NormalizedEvent variants", () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "x" },
      { kind: "text_delta", index: 0, text: "hello" },
      { kind: "tool_use_start", index: 1, id: "t1", name: "fn" },
      { kind: "tool_use_delta", index: 1, partialJson: "{\"a\":" },
      { kind: "tool_use_stop", index: 1 },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    expect(events).toHaveLength(6);
  });

  it("requires Backend implementations to expose id and capabilitiesFor", () => {
    const fake: Backend = {
      id: "claude",
      capabilitiesFor(): BackendCapabilities {
        return {
          toolUse: true,
          multimodal: false,
          thinking: false,
          cacheControl: "none",
          samplingParams: { temperature: false, topP: false, topK: false },
          stopSequences: "server-side-cut",
          embeddings: false
        };
      },
      async listModels(): Promise<ModelDescriptor[]> {
        return [];
      },
      async *invoke(): AsyncIterable<NormalizedEvent> {
        // pragma: no cover
      },
      async countTokens(): Promise<number> {
        return 0;
      }
    };
    expect(fake.id).toBe("claude");
  });

  it("optional embed() conforms to NormalizedEmbedding types when present", () => {
    const req: NormalizedEmbeddingRequest = { model: "nomic-embed-text", input: ["hello"] };
    const resp: NormalizedEmbeddingResponse = {
      model: "nomic-embed-text",
      embeddings: [[0.1, 0.2, 0.3]]
    };
    expect(req.input).toEqual(["hello"]);
    expect(resp.embeddings[0]).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/backends/types.test.ts`
Expected: FAIL — module `src/backends/types.js` not found.

- [ ] **Step 3: Create `src/backends/types.ts`**

```ts
export type BackendId = "claude" | "gemini" | "lmstudio" | "ollama";

// ---- Capability matrix ----------------------------------------------------

export interface BackendCapabilities {
  toolUse: boolean;
  multimodal: boolean;
  thinking: boolean;
  cacheControl: "native" | "local-emulation" | "none";
  samplingParams: { temperature: boolean; topP: boolean; topK: boolean };
  stopSequences: "native" | "server-side-cut";
  embeddings: boolean;
}

// ---- Normalized request shape --------------------------------------------

export type NormalizedRole = "system" | "user" | "assistant" | "tool";

export type NormalizedContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string /* base64 */ }
  | { type: "document"; mediaType: string; data: string /* base64 */ }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string };

export interface NormalizedMessage {
  role: NormalizedRole;
  content: NormalizedContentBlock[];
}

export interface NormalizedToolDef {
  name: string;
  description?: string;
  inputSchema: unknown; // JSON Schema
}

export type NormalizedToolChoice =
  | "auto"
  | "any"
  | "none"
  | { type: "tool"; name: string };

export interface NormalizedSamplingParams {
  temperature?: number;
  topP?: number;
  topK?: number;
}

export interface NormalizedRequest {
  model: string;
  system?: string;
  messages: NormalizedMessage[];
  tools?: NormalizedToolDef[];
  toolChoice?: NormalizedToolChoice;
  stopSequences?: string[];
  maxTokens?: number;
  samplingParams?: NormalizedSamplingParams;
  metadata?: Record<string, unknown>;
  thinking?: boolean;
}

// ---- Normalized streaming event union ------------------------------------

export type NormalizedEvent =
  | { kind: "message_start"; model: string }
  | { kind: "text_delta"; index: number; text: string }
  | { kind: "tool_use_start"; index: number; id: string; name: string }
  | { kind: "tool_use_delta"; index: number; partialJson: string }
  | { kind: "tool_use_stop"; index: number }
  | {
      kind: "message_stop";
      stopReason:
        | "end_turn"
        | "stop_sequence"
        | "max_tokens"
        | "tool_use"
        | "error";
      usage?: { inputTokens: number; outputTokens: number };
    };

// ---- Embeddings -----------------------------------------------------------

export interface NormalizedEmbeddingRequest {
  model: string;
  input: string[];
}

export interface NormalizedEmbeddingResponse {
  model: string;
  embeddings: number[][];
}

// ---- Model metadata -------------------------------------------------------

export interface ModelDescriptor {
  id: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  description?: string;
}

// ---- Backend interface ---------------------------------------------------

export interface Backend {
  readonly id: BackendId;
  capabilitiesFor(model: string): BackendCapabilities;
  listModels(): Promise<ModelDescriptor[]>;
  invoke(req: NormalizedRequest): AsyncIterable<NormalizedEvent>;
  countTokens(req: NormalizedRequest): Promise<number>;
  embed?(
    req: NormalizedEmbeddingRequest
  ): Promise<NormalizedEmbeddingResponse>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/backends/types.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backends/types.ts tests/unit/backends/types.test.ts
git commit -m "feat(backends): add normalized Backend interface and event types"
```

---

## Task 3: Config schema with Zod

**Files:**
- Create: `src/config.ts`
- Create: `configs/default.json`
- Create: `configs/example.json`
- Test: `tests/unit/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config.js";

function withTempConfig(json: unknown, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "claudemcp-cfg-"));
  const path = join(dir, "test.json");
  writeFileSync(path, JSON.stringify(json));
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadConfig", () => {
  it("loads a minimal valid config", () => {
    withTempConfig(
      {
        apiKey: "sk-test",
        claude: { enabled: true, command: "claude" },
        gemini: { enabled: false, command: "gemini" },
        lmstudio: { enabled: false, instances: [] },
        ollama: { enabled: false, useNativeApi: false, instances: [] }
      },
      (path) => {
        const cfg = loadConfig(path);
        expect(cfg.apiKey).toBe("sk-test");
        expect(cfg.claude.enabled).toBe(true);
        expect(cfg.router.defaultBackend).toBe("claude");
        expect(cfg.archive.dbPath).toBe("data/archive.sqlite");
      }
    );
  });

  it("rejects missing apiKey", () => {
    withTempConfig(
      {
        claude: { enabled: true, command: "claude" },
        gemini: { enabled: false, command: "gemini" },
        lmstudio: { enabled: false, instances: [] },
        ollama: { enabled: false, useNativeApi: false, instances: [] }
      },
      (path) => {
        expect(() => loadConfig(path)).toThrow(/apiKey/);
      }
    );
  });

  it("rejects an unknown defaultBackend", () => {
    withTempConfig(
      {
        apiKey: "sk-test",
        claude: { enabled: true, command: "claude" },
        gemini: { enabled: false, command: "gemini" },
        lmstudio: { enabled: false, instances: [] },
        ollama: { enabled: false, useNativeApi: false, instances: [] },
        router: { defaultBackend: "bogus" }
      },
      (path) => {
        expect(() => loadConfig(path)).toThrow(/defaultBackend/);
      }
    );
  });

  it("rejects multi-instance backend with duplicate names", () => {
    withTempConfig(
      {
        apiKey: "sk-test",
        claude: { enabled: false, command: "claude" },
        gemini: { enabled: false, command: "gemini" },
        lmstudio: {
          enabled: true,
          instances: [
            { name: "dup", baseUrl: "http://a/v1", priority: 50, timeoutMs: 1000 },
            { name: "dup", baseUrl: "http://b/v1", priority: 50, timeoutMs: 1000 }
          ]
        },
        ollama: { enabled: false, useNativeApi: false, instances: [] }
      },
      (path) => {
        expect(() => loadConfig(path)).toThrow(/unique/i);
      }
    );
  });

  it("returns a deeply frozen object", () => {
    withTempConfig(
      {
        apiKey: "sk-test",
        claude: { enabled: true, command: "claude" },
        gemini: { enabled: false, command: "gemini" },
        lmstudio: { enabled: false, instances: [] },
        ollama: { enabled: false, useNativeApi: false, instances: [] }
      },
      (path) => {
        const cfg = loadConfig(path);
        expect(Object.isFrozen(cfg)).toBe(true);
        expect(Object.isFrozen(cfg.claude)).toBe(true);
      }
    );
  });

  it("env var overrides apiKey when set", () => {
    withTempConfig(
      {
        apiKey: "sk-file",
        claude: { enabled: true, command: "claude" },
        gemini: { enabled: false, command: "gemini" },
        lmstudio: { enabled: false, instances: [] },
        ollama: { enabled: false, useNativeApi: false, instances: [] }
      },
      (path) => {
        process.env.CLAUDE_MCP_API_KEY = "sk-env";
        try {
          const cfg = loadConfig(path);
          expect(cfg.apiKey).toBe("sk-env");
        } finally {
          delete process.env.CLAUDE_MCP_API_KEY;
        }
      }
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: FAIL — module `src/config.js` not found.

- [ ] **Step 3: Create `src/config.ts`**

```ts
import { readFileSync } from "node:fs";
import { z } from "zod";

const InstanceSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().default(""),
  priority: z.number().int().default(50),
  timeoutMs: z.number().int().positive().default(300000),
  useNativeApi: z.boolean().nullable().default(null)
});

const ConfigSchema = z
  .object({
    apiKey: z.string().min(1),

    claude: z
      .object({
        enabled: z.boolean().default(true),
        command: z.string().default("claude"),
        priority: z.number().int().default(100),
        timeoutMs: z.number().int().positive().default(600000)
      })
      .default({ enabled: true, command: "claude", priority: 100, timeoutMs: 600000 }),

    gemini: z
      .object({
        enabled: z.boolean().default(true),
        command: z.string().default("gemini"),
        priority: z.number().int().default(90),
        timeoutMs: z.number().int().positive().default(600000)
      })
      .default({ enabled: true, command: "gemini", priority: 90, timeoutMs: 600000 }),

    lmstudio: z
      .object({
        enabled: z.boolean().default(true),
        instances: z.array(InstanceSchema).default([])
      })
      .default({ enabled: true, instances: [] }),

    ollama: z
      .object({
        enabled: z.boolean().default(true),
        useNativeApi: z.boolean().default(false),
        instances: z.array(InstanceSchema).default([])
      })
      .default({ enabled: true, useNativeApi: false, instances: [] }),

    router: z
      .object({
        defaultBackend: z
          .enum(["claude", "gemini", "lmstudio", "ollama"])
          .default("claude"),
        localProbeIntervalMs: z.number().int().positive().default(60000),
        thresholds: z
          .object({
            opusPromptTokens: z.number().int().positive().default(50000),
            opusToolCount: z.number().int().positive().default(5),
            sonnetPromptTokens: z.number().int().positive().default(5000)
          })
          .default({
            opusPromptTokens: 50000,
            opusToolCount: 5,
            sonnetPromptTokens: 5000
          }),
        reasoningEffortMap: z
          .object({
            claude: z.record(z.string()).default({
              low: "claude-haiku-4-5",
              medium: "claude-sonnet-4-6",
              high: "claude-opus-4-7"
            }),
            gemini: z.record(z.string()).default({
              low: "gemini-flash-lite",
              medium: "gemini-flash",
              high: "gemini-pro"
            }),
            lmstudio: z.record(z.string()).default({}),
            ollama: z.record(z.string()).default({})
          })
          .default({
            claude: {
              low: "claude-haiku-4-5",
              medium: "claude-sonnet-4-6",
              high: "claude-opus-4-7"
            },
            gemini: {
              low: "gemini-flash-lite",
              medium: "gemini-flash",
              high: "gemini-pro"
            },
            lmstudio: {},
            ollama: {}
          })
      })
      .default({
        defaultBackend: "claude",
        localProbeIntervalMs: 60000,
        thresholds: {
          opusPromptTokens: 50000,
          opusToolCount: 5,
          sonnetPromptTokens: 5000
        },
        reasoningEffortMap: {
          claude: {
            low: "claude-haiku-4-5",
            medium: "claude-sonnet-4-6",
            high: "claude-opus-4-7"
          },
          gemini: {
            low: "gemini-flash-lite",
            medium: "gemini-flash",
            high: "gemini-pro"
          },
          lmstudio: {},
          ollama: {}
        }
      }),

    files: z
      .object({
        dir: z.string().default("data/files"),
        ttlMs: z.number().int().positive().default(604800000),
        maxTotalBytes: z.number().int().positive().default(5368709120)
      })
      .default({
        dir: "data/files",
        ttlMs: 604800000,
        maxTotalBytes: 5368709120
      }),

    cache: z
      .object({
        file: z.string().default("data/response-cache.json"),
        ttlMs: z.number().int().positive().default(3600000),
        maxEntries: z.number().int().positive().default(500)
      })
      .default({ file: "data/response-cache.json", ttlMs: 3600000, maxEntries: 500 }),

    archive: z
      .object({
        dbPath: z.string().default("data/archive.sqlite"),
        compressionLevel: z.number().int().min(1).max(22).default(3)
      })
      .default({ dbPath: "data/archive.sqlite", compressionLevel: 3 }),

    embeddings: z
      .object({
        legacyBackendUrl: z.string().default(""),
        legacyApiKey: z.string().default(""),
        legacyTimeoutMs: z.number().int().positive().default(30000)
      })
      .default({ legacyBackendUrl: "", legacyApiKey: "", legacyTimeoutMs: 30000 }),

    adminUi: z
      .object({
        enabled: z.boolean().default(true),
        bindLocalhost: z.boolean().default(true),
        sessionTtlMs: z.number().int().positive().default(3600000)
      })
      .default({ enabled: true, bindLocalhost: true, sessionTtlMs: 3600000 })
  })
  .superRefine((cfg, ctx) => {
    for (const backend of ["lmstudio", "ollama"] as const) {
      const seen = new Set<string>();
      for (const inst of cfg[backend].instances) {
        if (seen.has(inst.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [backend, "instances"],
            message: `instance names must be unique within ${backend}; duplicate: ${inst.name}`
          });
        }
        seen.add(inst.name);
      }
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function applyEnvOverrides(cfg: Config): Config {
  if (process.env.CLAUDE_MCP_API_KEY) {
    return { ...cfg, apiKey: process.env.CLAUDE_MCP_API_KEY };
  }
  return cfg;
}

export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const parsed = ConfigSchema.parse(raw);
  const withEnv = applyEnvOverrides(parsed);
  return deepFreeze(withEnv);
}
```

- [ ] **Step 4: Create `configs/default.json`**

```json
{
  "apiKey": "CHANGE-ME-BEFORE-USE",
  "claude": { "enabled": true, "command": "claude", "priority": 100, "timeoutMs": 600000 },
  "gemini": { "enabled": true, "command": "gemini", "priority": 90, "timeoutMs": 600000 },
  "lmstudio": {
    "enabled": true,
    "instances": [
      { "name": "local", "baseUrl": "http://127.0.0.1:1234/v1", "apiKey": "", "priority": 50, "timeoutMs": 300000 }
    ]
  },
  "ollama": {
    "enabled": true,
    "useNativeApi": false,
    "instances": [
      { "name": "local", "baseUrl": "http://127.0.0.1:11434", "priority": 40, "timeoutMs": 300000, "useNativeApi": null }
    ]
  },
  "router": {
    "defaultBackend": "claude",
    "localProbeIntervalMs": 60000
  },
  "files": { "dir": "data/files", "ttlMs": 604800000, "maxTotalBytes": 5368709120 },
  "cache": { "file": "data/response-cache.json", "ttlMs": 3600000, "maxEntries": 500 },
  "archive": { "dbPath": "data/archive.sqlite", "compressionLevel": 3 },
  "embeddings": { "legacyBackendUrl": "", "legacyApiKey": "", "legacyTimeoutMs": 30000 },
  "adminUi": { "enabled": true, "bindLocalhost": true, "sessionTtlMs": 3600000 }
}
```

- [ ] **Step 5: Create `configs/example.json`**

Copy `configs/default.json` and add a `_comments` block immediately after `"apiKey"`:

```json
{
  "_comments": {
    "apiKey": "Required. Shared API key for all clients. Sent via x-api-key, Authorization: Bearer, x-goog-api-key, or ?key= query.",
    "claude.command": "Path or name of the claude CLI executable.",
    "gemini.command": "Path or name of the gemini CLI executable.",
    "lmstudio.instances[*].baseUrl": "OpenAI-compatible server URL. Default port for LM Studio is 1234.",
    "ollama.useNativeApi": "Default mode for all Ollama instances. true => /api/*, false => /v1/*. Per-instance useNativeApi overrides.",
    "router.defaultBackend": "Backend used when no model is supplied or model is 'auto'.",
    "router.localProbeIntervalMs": "How often local backends are re-probed to discover loaded models.",
    "files.maxTotalBytes": "Eviction kicks in when fileStore exceeds this size after TTL pass.",
    "cache.ttlMs": "Response cache entry lifetime.",
    "archive.compressionLevel": "zstd level 1-22 for archived request/response bodies.",
    "embeddings.legacyBackendUrl": "Deprecated: when non-empty, bypasses the backend registry for /v1/embeddings.",
    "adminUi.bindLocalhost": "When true, admin UI rejects non-localhost requests with 403."
  },
  "apiKey": "CHANGE-ME-BEFORE-USE",
  "claude": { "enabled": true, "command": "claude", "priority": 100, "timeoutMs": 600000 },
  "gemini": { "enabled": true, "command": "gemini", "priority": 90, "timeoutMs": 600000 },
  "lmstudio": {
    "enabled": true,
    "instances": [
      { "name": "local", "baseUrl": "http://127.0.0.1:1234/v1", "apiKey": "", "priority": 50, "timeoutMs": 300000 }
    ]
  },
  "ollama": {
    "enabled": true,
    "useNativeApi": false,
    "instances": [
      { "name": "local", "baseUrl": "http://127.0.0.1:11434", "priority": 40, "timeoutMs": 300000, "useNativeApi": null }
    ]
  },
  "router": { "defaultBackend": "claude", "localProbeIntervalMs": 60000 },
  "files": { "dir": "data/files", "ttlMs": 604800000, "maxTotalBytes": 5368709120 },
  "cache": { "file": "data/response-cache.json", "ttlMs": 3600000, "maxEntries": 500 },
  "archive": { "dbPath": "data/archive.sqlite", "compressionLevel": 3 },
  "embeddings": { "legacyBackendUrl": "", "legacyApiKey": "", "legacyTimeoutMs": 30000 },
  "adminUi": { "enabled": true, "bindLocalhost": true, "sessionTtlMs": 3600000 }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts configs/default.json configs/example.json tests/unit/config.test.ts
git commit -m "feat(config): add Zod schema and loader for multi-backend config"
```

---

## Task 4: Multi-scheme auth utility

**Files:**
- Create: `src/auth.ts`
- Test: `tests/unit/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkAuth } from "../../src/auth.js";

function req(opts: {
  headers?: Record<string, string>;
  query?: Record<string, string>;
}): { headers: Record<string, string>; query: Record<string, string> } {
  return { headers: opts.headers ?? {}, query: opts.query ?? {} };
}

describe("checkAuth", () => {
  const apiKey = "sk-secret-123";

  it("accepts x-api-key header (Anthropic style)", () => {
    expect(checkAuth(req({ headers: { "x-api-key": apiKey } }), apiKey)).toBe(true);
  });

  it("accepts Authorization: Bearer header (OpenAI style)", () => {
    expect(
      checkAuth(req({ headers: { authorization: `Bearer ${apiKey}` } }), apiKey)
    ).toBe(true);
  });

  it("accepts x-goog-api-key header (Google style)", () => {
    expect(
      checkAuth(req({ headers: { "x-goog-api-key": apiKey } }), apiKey)
    ).toBe(true);
  });

  it("accepts ?key= query parameter (Google GET fallback)", () => {
    expect(checkAuth(req({ query: { key: apiKey } }), apiKey)).toBe(true);
  });

  it("rejects missing credentials", () => {
    expect(checkAuth(req({}), apiKey)).toBe(false);
  });

  it("rejects wrong key", () => {
    expect(checkAuth(req({ headers: { "x-api-key": "wrong" } }), apiKey)).toBe(false);
  });

  it("rejects Bearer with wrong key", () => {
    expect(
      checkAuth(req({ headers: { authorization: "Bearer wrong" } }), apiKey)
    ).toBe(false);
  });

  it("rejects malformed Authorization (no Bearer prefix)", () => {
    expect(
      checkAuth(req({ headers: { authorization: apiKey } }), apiKey)
    ).toBe(false);
  });

  it("comparison is constant-time-shaped (same length wrong key still false)", () => {
    const wrong = apiKey.replace(/.$/, "X");
    expect(checkAuth(req({ headers: { "x-api-key": wrong } }), apiKey)).toBe(false);
  });

  it("handles array-valued headers by taking the first value", () => {
    // Express sometimes parses repeated headers as string[].
    const r = {
      headers: { "x-api-key": [apiKey, "extra"] as unknown as string },
      query: {}
    };
    expect(checkAuth(r, apiKey)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/auth.test.ts`
Expected: FAIL — module `src/auth.js` not found.

- [ ] **Step 3: Create `src/auth.ts`**

```ts
import { timingSafeEqual } from "node:crypto";

export interface AuthCarrier {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
}

function pickFirst(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function safeEqual(a: string, b: string): boolean {
  // Pad the shorter to the longer length so timingSafeEqual doesn't throw, then
  // require lengths to match for a true result.
  const len = Math.max(a.length, b.length);
  const ab = Buffer.from(a.padEnd(len, "\0"));
  const bb = Buffer.from(b.padEnd(len, "\0"));
  const equal = timingSafeEqual(ab, bb);
  return equal && a.length === b.length;
}

function extractKey(carrier: AuthCarrier): string | undefined {
  const xApi = pickFirst(carrier.headers["x-api-key"]);
  if (xApi) return xApi;

  const goog = pickFirst(carrier.headers["x-goog-api-key"]);
  if (goog) return goog;

  const auth = pickFirst(carrier.headers["authorization"]);
  if (auth) {
    const [scheme, token] = auth.split(/\s+/, 2);
    if (scheme === "Bearer" && token) return token;
  }

  const query = pickFirst(carrier.query["key"]);
  if (query) return query;

  return undefined;
}

export function checkAuth(carrier: AuthCarrier, expectedApiKey: string): boolean {
  const presented = extractKey(carrier);
  if (!presented) return false;
  return safeEqual(presented, expectedApiKey);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/auth.test.ts`
Expected: PASS — all 10 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts tests/unit/auth.test.ts
git commit -m "feat(auth): add multi-scheme auth check (x-api-key, Bearer, x-goog-api-key, ?key=)"
```

---

## Task 5: Archive SQLite schema

**Files:**
- Create: `src/archive.ts`
- Test: `tests/unit/archive.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/archive.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Archive } from "../../src/archive.js";

describe("Archive schema management", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-arc-"));
    dbPath = join(dir, "archive.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the entries table on first open", () => {
    const archive = new Archive(dbPath);
    archive.close();

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='entries'"
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("entries");
    db.close();
  });

  it("creates all expected indexes", () => {
    const archive = new Archive(dbPath);
    archive.close();

    const db = new Database(dbPath, { readonly: true });
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='entries' ORDER BY name"
      )
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_hash");
    expect(names).toContain("idx_time");
    expect(names).toContain("idx_session");
    expect(names).toContain("idx_backend");
    db.close();
  });

  it("is idempotent on reopen", () => {
    new Archive(dbPath).close();
    new Archive(dbPath).close(); // must not throw
    const db = new Database(dbPath, { readonly: true });
    const count = db
      .prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='entries'"
      )
      .get() as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });

  it("schema columns match the spec", () => {
    const archive = new Archive(dbPath);
    archive.close();

    const db = new Database(dbPath, { readonly: true });
    const cols = db
      .prepare("PRAGMA table_info(entries)")
      .all() as { name: string; type: string; notnull: number }[];
    const colMap = new Map(cols.map((c) => [c.name, c]));

    for (const required of [
      "id",
      "request_hash",
      "log_id",
      "endpoint",
      "backend",
      "model_resolved",
      "session_id",
      "timestamp",
      "status",
      "duration_ms",
      "input_tokens",
      "output_tokens",
      "request_body",
      "response_body"
    ]) {
      expect(colMap.has(required), `missing column ${required}`).toBe(true);
    }

    expect(colMap.get("backend")?.notnull).toBe(1);
    expect(colMap.get("request_body")?.type.toUpperCase()).toBe("BLOB");
    db.close();
  });

  it("creates parent directory if missing", () => {
    const nested = join(dir, "nested", "deeper", "archive.sqlite");
    new Archive(nested).close();
    expect(() => new Database(nested, { readonly: true }).close()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/archive.test.ts`
Expected: FAIL — module `src/archive.js` not found.

- [ ] **Step 3: Create `src/archive.ts`**

```ts
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entries (
  id              INTEGER PRIMARY KEY,
  request_hash    TEXT NOT NULL,
  log_id          TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  backend         TEXT NOT NULL,
  model_resolved  TEXT,
  session_id      TEXT,
  timestamp       TEXT NOT NULL,
  status          TEXT NOT NULL,
  duration_ms     INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  request_body    BLOB NOT NULL,
  response_body   BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hash    ON entries(request_hash);
CREATE INDEX IF NOT EXISTS idx_time    ON entries(timestamp);
CREATE INDEX IF NOT EXISTS idx_session ON entries(session_id);
CREATE INDEX IF NOT EXISTS idx_backend ON entries(backend);
`;

export class Archive {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
  }

  /** Exposed for use by writers added in Plan 05. */
  raw(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/archive.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/archive.ts tests/unit/archive.test.ts
git commit -m "feat(archive): add SQLite schema with WAL mode and idempotent migration"
```

---

## Task 6: Model router — backend identification

**Files:**
- Create: `src/modelRouter.ts`
- Test: `tests/unit/modelRouter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/modelRouter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { identifyBackend } from "../../src/modelRouter.js";

describe("identifyBackend", () => {
  it("routes claude- prefix to claude", () => {
    expect(identifyBackend("claude-opus-4-7", "claude")).toEqual({
      backend: "claude",
      remainingModel: "claude-opus-4-7",
      reason: "anthropic-id-prefix"
    });
  });

  it("routes short claude aliases to claude", () => {
    for (const alias of ["opus", "sonnet", "haiku"]) {
      expect(identifyBackend(alias, "gemini").backend).toBe("claude");
    }
  });

  it("routes gemini- prefix to gemini", () => {
    expect(identifyBackend("gemini-pro", "claude")).toEqual({
      backend: "gemini",
      remainingModel: "gemini-pro",
      reason: "google-id-prefix"
    });
  });

  it("routes short gemini aliases to gemini", () => {
    for (const alias of ["pro", "flash", "flash-lite"]) {
      expect(identifyBackend(alias, "claude").backend).toBe("gemini");
    }
  });

  it("honors explicit prefix override for lmstudio", () => {
    expect(identifyBackend("lmstudio/qwen3-coder-30b", "claude")).toEqual({
      backend: "lmstudio",
      remainingModel: "qwen3-coder-30b",
      reason: "prefix-override"
    });
  });

  it("honors explicit prefix override for ollama", () => {
    expect(identifyBackend("ollama/llama-3.3-70b", "claude")).toEqual({
      backend: "ollama",
      remainingModel: "llama-3.3-70b",
      reason: "prefix-override"
    });
  });

  it("honors explicit prefix override for claude even when alias would route gemini", () => {
    expect(identifyBackend("claude/pro", "gemini")).toEqual({
      backend: "claude",
      remainingModel: "pro",
      reason: "prefix-override"
    });
  });

  it("honors fully-qualified multi-instance prefix (lmstudio:work/model)", () => {
    expect(identifyBackend("lmstudio:work-server/qwen3-coder-30b", "claude")).toEqual({
      backend: "lmstudio",
      remainingModel: "qwen3-coder-30b",
      instance: "work-server",
      reason: "prefix-override"
    });
  });

  it("falls back to defaultBackend on 'auto' / empty / sentinel", () => {
    expect(identifyBackend("auto", "gemini").backend).toBe("gemini");
    expect(identifyBackend("", "claude").backend).toBe("claude");
    expect(identifyBackend(undefined, "lmstudio").backend).toBe("lmstudio");
  });

  it("'claude-code-cli' forces claude regardless of defaultBackend", () => {
    expect(identifyBackend("claude-code-cli", "gemini").backend).toBe("claude");
  });

  it("'gemini-cli' forces gemini regardless of defaultBackend", () => {
    expect(identifyBackend("gemini-cli", "claude").backend).toBe("gemini");
  });

  it("returns unresolved-local for unknown bare names (registry will look up)", () => {
    expect(identifyBackend("qwen3-coder-30b", "claude")).toEqual({
      backend: null,
      remainingModel: "qwen3-coder-30b",
      reason: "needs-registry-lookup"
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/modelRouter.test.ts`
Expected: FAIL — module `src/modelRouter.js` not found.

- [ ] **Step 3: Create `src/modelRouter.ts`**

```ts
import type { BackendId } from "./backends/types.js";

export interface IdentifyResult {
  /** null means the registry must look this model up in its discovered map */
  backend: BackendId | null;
  remainingModel: string;
  /** When the prefix-override syntax includes :<instance>, set here */
  instance?: string;
  reason:
    | "prefix-override"
    | "anthropic-id-prefix"
    | "google-id-prefix"
    | "default-backend"
    | "needs-registry-lookup";
}

const CLAUDE_ALIASES = new Set(["opus", "sonnet", "haiku"]);
const GEMINI_ALIASES = new Set(["pro", "flash", "flash-lite"]);
const SENTINELS = new Set(["auto", ""]);

function parsePrefix(
  model: string
): { backend: BackendId; instance?: string; remaining: string } | null {
  // Match backend prefix optionally followed by :instance, then /model.
  // Examples: "lmstudio/X", "lmstudio:work/X", "ollama:remote-1/X"
  const m = model.match(
    /^(claude|gemini|lmstudio|ollama)(?::([A-Za-z0-9_-]+))?\/(.+)$/
  );
  if (!m) return null;
  return {
    backend: m[1] as BackendId,
    instance: m[2],
    remaining: m[3]
  };
}

export function identifyBackend(
  model: string | undefined,
  defaultBackend: BackendId
): IdentifyResult {
  if (model === "claude-code-cli") {
    return {
      backend: "claude",
      remainingModel: "claude-code-cli",
      reason: "default-backend"
    };
  }
  if (model === "gemini-cli") {
    return {
      backend: "gemini",
      remainingModel: "gemini-cli",
      reason: "default-backend"
    };
  }

  if (model === undefined || SENTINELS.has(model)) {
    return {
      backend: defaultBackend,
      remainingModel: model ?? "",
      reason: "default-backend"
    };
  }

  const prefixed = parsePrefix(model);
  if (prefixed) {
    return {
      backend: prefixed.backend,
      remainingModel: prefixed.remaining,
      instance: prefixed.instance,
      reason: "prefix-override"
    };
  }

  if (model.startsWith("claude-") || CLAUDE_ALIASES.has(model)) {
    return {
      backend: "claude",
      remainingModel: model,
      reason: "anthropic-id-prefix"
    };
  }
  if (model.startsWith("gemini-") || GEMINI_ALIASES.has(model)) {
    return {
      backend: "gemini",
      remainingModel: model,
      reason: "google-id-prefix"
    };
  }

  return {
    backend: null,
    remainingModel: model,
    reason: "needs-registry-lookup"
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/modelRouter.test.ts`
Expected: PASS — all 12 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/modelRouter.ts tests/unit/modelRouter.test.ts
git commit -m "feat(router): add backend-identification for prefixes, aliases, and sentinels"
```

---

## Task 7: Backend registry skeleton

**Files:**
- Create: `src/backends/registry.ts`
- Test: `tests/unit/backends/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/backends/registry.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendRegistry } from "../../../src/backends/registry.js";
import type {
  Backend,
  BackendCapabilities,
  ModelDescriptor,
  NormalizedEvent
} from "../../../src/backends/types.js";

function makeBackend(opts: {
  id: Backend["id"];
  priority?: number;
  models?: string[];
  probeError?: Error;
}): Backend & { listModelsMock: ReturnType<typeof vi.fn> } {
  const caps: BackendCapabilities = {
    toolUse: true,
    multimodal: false,
    thinking: false,
    cacheControl: "none",
    samplingParams: { temperature: false, topP: false, topK: false },
    stopSequences: "server-side-cut",
    embeddings: false
  };
  const listModelsMock = vi.fn(async () => {
    if (opts.probeError) throw opts.probeError;
    return (opts.models ?? []).map<ModelDescriptor>((id) => ({ id }));
  });
  return {
    id: opts.id,
    capabilitiesFor: () => caps,
    listModels: listModelsMock,
    invoke: async function* (): AsyncIterable<NormalizedEvent> {
      // pragma: no cover
    },
    countTokens: async () => 0,
    listModelsMock
  };
}

describe("BackendRegistry", () => {
  let registry: BackendRegistry;

  beforeEach(() => {
    registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
  });

  afterEach(() => {
    registry.stop();
  });

  it("starts empty", () => {
    expect(registry.enabledBackends()).toEqual([]);
    expect(registry.get("claude")).toBeUndefined();
    expect(registry.resolveModel("anything")).toBeUndefined();
  });

  it("registers and retrieves a backend", () => {
    const claude = makeBackend({ id: "claude" });
    registry.register(claude);
    expect(registry.get("claude")).toBe(claude);
    expect(registry.enabledBackends().map((b) => b.id)).toEqual(["claude"]);
  });

  it("probe() populates modelMap from each backend's listModels()", async () => {
    const claude = makeBackend({ id: "claude", models: ["claude-opus-4-7"] });
    const ollama = makeBackend({ id: "ollama", models: ["llama-3.3-70b"] });
    registry.register(claude);
    registry.register(ollama);

    await registry.probe();

    expect(registry.resolveModel("claude-opus-4-7")?.id).toBe("claude");
    expect(registry.resolveModel("llama-3.3-70b")?.id).toBe("ollama");
    expect(claude.listModelsMock).toHaveBeenCalledOnce();
  });

  it("higher-priority backend wins on model-id collision", async () => {
    const lmstudio = makeBackend({ id: "lmstudio", models: ["shared-model"] });
    const ollama = makeBackend({ id: "ollama", models: ["shared-model"] });
    registry.register(lmstudio);
    registry.register(ollama);

    await registry.probe();

    // lmstudio priority 50 > ollama priority 40
    expect(registry.resolveModel("shared-model")?.id).toBe("lmstudio");
  });

  it("probe failures do not crash, leave the failing backend with no models", async () => {
    const ok = makeBackend({ id: "claude", models: ["claude-opus-4-7"] });
    const bad = makeBackend({
      id: "gemini",
      probeError: new Error("connection refused")
    });
    registry.register(ok);
    registry.register(bad);

    const result = await registry.probe();

    expect(result.failures.map((f) => f.backendId)).toEqual(["gemini"]);
    expect(registry.resolveModel("claude-opus-4-7")?.id).toBe("claude");
    expect(registry.lastProbeStatus("gemini")?.ok).toBe(false);
    expect(registry.lastProbeStatus("claude")?.ok).toBe(true);
  });

  it("startPeriodicProbe schedules repeated probes at the given interval", async () => {
    vi.useFakeTimers();
    const claude = makeBackend({ id: "claude", models: ["claude-opus-4-7"] });
    registry.register(claude);
    registry.startPeriodicProbe(1000);

    await vi.advanceTimersByTimeAsync(0); // initial immediate probe
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(claude.listModelsMock).toHaveBeenCalledTimes(3);
    registry.stop();
    vi.useRealTimers();
  });

  it("stop() halts the periodic probe", async () => {
    vi.useFakeTimers();
    const claude = makeBackend({ id: "claude" });
    registry.register(claude);
    registry.startPeriodicProbe(1000);

    await vi.advanceTimersByTimeAsync(0);
    registry.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(claude.listModelsMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/backends/registry.test.ts`
Expected: FAIL — module `src/backends/registry.js` not found.

- [ ] **Step 3: Create `src/backends/registry.ts`**

```ts
import type { Backend, BackendId, ModelDescriptor } from "./types.js";

export interface ProbeResult {
  backendId: BackendId;
  models: ModelDescriptor[];
}

export interface ProbeFailure {
  backendId: BackendId;
  error: Error;
}

export interface ProbeOutcome {
  successes: ProbeResult[];
  failures: ProbeFailure[];
}

export interface ProbeStatus {
  ok: boolean;
  lastProbedAt: Date;
  error?: string;
}

export type PriorityMap = Record<BackendId, number>;

export class BackendRegistry {
  private readonly backends = new Map<BackendId, Backend>();
  private modelMap = new Map<string, BackendId>();
  private probeStatus = new Map<BackendId, ProbeStatus>();
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly priorities: PriorityMap) {}

  register(backend: Backend): void {
    this.backends.set(backend.id, backend);
  }

  get(id: BackendId): Backend | undefined {
    return this.backends.get(id);
  }

  enabledBackends(): Backend[] {
    return Array.from(this.backends.values());
  }

  resolveModel(modelId: string): Backend | undefined {
    const id = this.modelMap.get(modelId);
    return id ? this.backends.get(id) : undefined;
  }

  lastProbeStatus(id: BackendId): ProbeStatus | undefined {
    return this.probeStatus.get(id);
  }

  async probe(): Promise<ProbeOutcome> {
    const successes: ProbeResult[] = [];
    const failures: ProbeFailure[] = [];

    await Promise.all(
      Array.from(this.backends.values()).map(async (backend) => {
        try {
          const models = await backend.listModels();
          successes.push({ backendId: backend.id, models });
          this.probeStatus.set(backend.id, { ok: true, lastProbedAt: new Date() });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          failures.push({ backendId: backend.id, error });
          this.probeStatus.set(backend.id, {
            ok: false,
            lastProbedAt: new Date(),
            error: error.message
          });
        }
      })
    );

    this.rebuildModelMap(successes);
    return { successes, failures };
  }

  startPeriodicProbe(intervalMs: number): void {
    void this.probe();
    this.intervalHandle = setInterval(() => {
      void this.probe();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
  }

  private rebuildModelMap(successes: ProbeResult[]): void {
    const next = new Map<string, BackendId>();
    // Sort backends by descending priority so winners overwrite losers.
    const sorted = [...successes].sort(
      (a, b) =>
        (this.priorities[a.backendId] ?? 0) -
        (this.priorities[b.backendId] ?? 0)
    );
    for (const { backendId, models } of sorted) {
      for (const m of models) next.set(m.id, backendId);
    }
    this.modelMap = next;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/backends/registry.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backends/registry.ts tests/unit/backends/registry.test.ts
git commit -m "feat(registry): add BackendRegistry skeleton with periodic probe and priority-based collision resolution"
```

---

## Task 8: Foundation acceptance smoke test

**Files:**
- Create: `tests/integration/foundation.test.ts`

This integration test wires every Plan 01 module together to prove they cooperate. No HTTP server yet — that comes in later plans.

- [ ] **Step 1: Write the test**

Create `tests/integration/foundation.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config.js";
import { checkAuth } from "../../src/auth.js";
import { Archive } from "../../src/archive.js";
import { identifyBackend } from "../../src/modelRouter.js";
import { BackendRegistry } from "../../src/backends/registry.js";
import type {
  Backend,
  BackendCapabilities,
  NormalizedEvent
} from "../../src/backends/types.js";

function stubBackend(id: Backend["id"], modelIds: string[]): Backend {
  const caps: BackendCapabilities = {
    toolUse: true,
    multimodal: false,
    thinking: false,
    cacheControl: "none",
    samplingParams: { temperature: false, topP: false, topK: false },
    stopSequences: "server-side-cut",
    embeddings: false
  };
  return {
    id,
    capabilitiesFor: () => caps,
    listModels: async () => modelIds.map((m) => ({ id: m })),
    invoke: async function* (): AsyncIterable<NormalizedEvent> {
      yield { kind: "message_start", model: modelIds[0] ?? "unknown" };
      yield { kind: "text_delta", index: 0, text: "ok" };
      yield { kind: "message_stop", stopReason: "end_turn" };
    },
    countTokens: async () => 1
  };
}

describe("Plan 01 foundation cooperates end-to-end", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-found-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads config, validates auth, opens archive, probes registry, identifies backend", async () => {
    const cfgPath = join(dir, "config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        apiKey: "sk-integration-key",
        claude: { enabled: true, command: "claude" },
        gemini: { enabled: true, command: "gemini" },
        lmstudio: { enabled: true, instances: [] },
        ollama: { enabled: true, useNativeApi: false, instances: [] },
        archive: { dbPath: join(dir, "archive.sqlite"), compressionLevel: 3 }
      })
    );
    const cfg = loadConfig(cfgPath);

    // Auth
    expect(
      checkAuth({ headers: { "x-api-key": "sk-integration-key" }, query: {} }, cfg.apiKey)
    ).toBe(true);

    // Archive
    const archive = new Archive(cfg.archive.dbPath);
    try {
      expect(archive.raw().prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
    } finally {
      archive.close();
    }

    // Registry + router
    const registry = new BackendRegistry({
      claude: cfg.claude.priority,
      gemini: cfg.gemini.priority,
      lmstudio: 50,
      ollama: 40
    });
    registry.register(stubBackend("claude", ["claude-opus-4-7"]));
    registry.register(stubBackend("ollama", ["llama-3.3-70b"]));
    await registry.probe();

    const directHit = identifyBackend("claude-opus-4-7", cfg.router.defaultBackend);
    expect(directHit.backend).toBe("claude");

    const lookupNeeded = identifyBackend("llama-3.3-70b", cfg.router.defaultBackend);
    expect(lookupNeeded.backend).toBeNull();
    expect(registry.resolveModel(lookupNeeded.remainingModel)?.id).toBe("ollama");

    registry.stop();
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run tests/integration/foundation.test.ts`
Expected: PASS — single integration test green.

- [ ] **Step 3: Run the full test suite to confirm no regressions**

Run: `npx vitest run`
Expected: All tests green across unit + integration.

- [ ] **Step 4: Run TypeScript typecheck**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/foundation.test.ts
git commit -m "test(foundation): add integration test wiring all Plan 01 modules together"
```

---

## Task 9: Plan-01 close-out documentation

**Files:**
- Create: `docs/plan-01-foundation-readme.md`

A short README documenting what Plan 01 left in place, what works, and what the next plan should expect. Helps future agents executing Plans 02-13 start with the right mental model.

- [ ] **Step 1: Write the document**

```markdown
# Plan 01 — Foundation: what shipped

Plan 01 left the project with the following working pieces:

## Modules

| Path | What it does | What it does NOT do yet |
|---|---|---|
| `src/backends/types.ts` | Defines `Backend`, capabilities, normalized request/event/embedding types | No implementations |
| `src/config.ts` | Zod-validated multi-backend config loader, env-var overrides, deep freeze | Does not wire the config into a running server (no `server.ts` yet) |
| `src/auth.ts` | `checkAuth()` accepting x-api-key, Bearer, x-goog-api-key, ?key= | Not wired into any HTTP route |
| `src/archive.ts` | Opens SQLite at the configured path, runs idempotent schema migration | No write/read methods — Plan 05 adds those |
| `src/modelRouter.ts` | `identifyBackend()` for prefix/alias/sentinel resolution | Does NOT pick a specific model id or resolve registry lookups |
| `src/backends/registry.ts` | `BackendRegistry` skeleton — register, probe, periodic probe, priority-based collision resolution | No backends registered yet |

## Tests

All under `tests/`:
- `unit/backends/types.test.ts`
- `unit/config.test.ts`
- `unit/auth.test.ts`
- `unit/archive.test.ts`
- `unit/modelRouter.test.ts`
- `unit/backends/registry.test.ts`
- `integration/foundation.test.ts`

Run all: `npm test`

## What does NOT exist yet

- `src/server.ts` (no Express bootstrap)
- Any `src/backends/<id>Backend.ts` implementation
- Any shim (`src/anthropicShim/`, `src/openaiShim/`, `src/geminiShim/`)
- Any HTTP route handlers
- The existing `dist/` directory from the original ClaudeMCP iteration is untouched and not consumed by the new code — Plan 02 will refactor `claudeRunner.ts` / `claudeStreamRunner.ts` behind the `Backend` interface.

## What the next plan (Plan 02 — Claude backend refactor) needs

- Move `dist/claudeRunner.js` and `dist/claudeStreamRunner.js` source equivalents into `src/runners/`
- Implement `src/backends/claudeBackend.ts` against the `Backend` interface from `src/backends/types.ts`
- Register the Claude backend into `BackendRegistry` at server startup
- No HTTP behavior change yet — Plan 03 adds `/v1/messages`
```

- [ ] **Step 2: Commit**

```bash
git add docs/plan-01-foundation-readme.md
git commit -m "docs: add Plan 01 close-out README documenting what foundation shipped"
```

---

## Plan 01 — Self-review checklist

Before declaring Plan 01 done, run through this checklist:

- [ ] `npm test` — all green, no skips.
- [ ] `npx tsc --noEmit` — no type errors.
- [ ] `git status` — clean tree, all changes committed.
- [ ] `git log --oneline -20` — commits read sensibly: scaffold, types, config, auth, archive, router, registry, integration test, README.
- [ ] `configs/default.json` parses cleanly via `loadConfig()` (sanity: `node -e "import('./dist/config.js').then(m => console.log(m.loadConfig('configs/default.json')))"` after `npm run build`, or write a one-off `tsx` script).
- [ ] No file under `src/` exceeds 300 lines (if any does, that's a smell — split it before moving to Plan 02).

If all check, Plan 01 is shipped and Plan 02 can begin.
