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

export const ConfigSchema = z
  .object({
    apiKey: z.string().min(1),

    claude: z
      .object({
        enabled: z.boolean().default(true),
        // string for a bare executable name, or string[] for a prefix-args form
        // like ["wsl", "claude"]. Matches what runners/types.ts accepts.
        command: z.union([z.string(), z.array(z.string()).nonempty()]).default("claude"),
        priority: z.number().int().default(100),
        timeoutMs: z.number().int().positive().default(600000)
      })
      .default({ enabled: true, command: "claude", priority: 100, timeoutMs: 600000 }),

    gemini: z
      .object({
        enabled: z.boolean().default(true),
        command: z.union([z.string(), z.array(z.string()).nonempty()]).default("gemini"),
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
            claude: z.record(z.enum(["low", "medium", "high"]), z.string()).default({
              low: "claude-haiku-4-5",
              medium: "claude-sonnet-4-6",
              high: "claude-opus-4-7"
            }),
            gemini: z.record(z.enum(["low", "medium", "high"]), z.string()).default({
              low: "gemini-flash-lite",
              medium: "gemini-flash",
              high: "gemini-pro"
            }),
            lmstudio: z.record(z.enum(["low", "medium", "high"]), z.string()).default({}),
            ollama: z.record(z.enum(["low", "medium", "high"]), z.string()).default({})
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
