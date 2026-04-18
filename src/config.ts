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
