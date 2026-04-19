import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
const SessionModeSchema = z.enum(["stateless", "session", "auto-last"]);
const ConfigSchema = z.object({
    port: z.number().int().positive().default(3000),
    host: z.string().default("127.0.0.1"),
    logFile: z.string().default("logs/activity.log"),
    sessionStoreFile: z.string().default("data/sessions.json"),
    claudeCommand: z
        .union([z.string(), z.array(z.string()).min(1)])
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
    openai: z
        .object({
        enabled: z.boolean().default(true),
        requireAuthHeader: z.string().nullable().default(null),
        timeoutMs: z.number().int().positive().default(120000),
    })
        .default({}),
});
function applyEnvOverrides(cfg) {
    const portEnv = process.env.CLAUDE_MCP_PORT;
    const hostEnv = process.env.CLAUDE_MCP_HOST;
    const logEnv = process.env.CLAUDE_MCP_LOG_FILE;
    const storeEnv = process.env.CLAUDE_MCP_SESSION_STORE_FILE;
    const openaiEnabledEnv = process.env.CLAUDE_MCP_OPENAI_ENABLED;
    const openaiAuthEnv = process.env.CLAUDE_MCP_OPENAI_AUTH_HEADER;
    const openaiTimeoutEnv = process.env.CLAUDE_MCP_OPENAI_TIMEOUT_MS;
    const next = {
        ...cfg,
        port: portEnv ? Number(portEnv) : cfg.port,
        host: hostEnv ?? cfg.host,
        logFile: logEnv ?? cfg.logFile,
        sessionStoreFile: storeEnv ?? cfg.sessionStoreFile,
        openai: {
            ...cfg.openai,
            enabled: openaiEnabledEnv !== undefined
                ? openaiEnabledEnv === "true"
                : cfg.openai.enabled,
            requireAuthHeader: openaiAuthEnv ?? cfg.openai.requireAuthHeader,
            timeoutMs: openaiTimeoutEnv
                ? Number(openaiTimeoutEnv)
                : cfg.openai.timeoutMs,
        },
    };
    if (portEnv && (!Number.isInteger(next.port) || next.port <= 0)) {
        throw new Error(`CLAUDE_MCP_PORT must be a positive integer, got: ${portEnv}`);
    }
    if (openaiTimeoutEnv &&
        (!Number.isInteger(next.openai.timeoutMs) || next.openai.timeoutMs <= 0)) {
        throw new Error(`CLAUDE_MCP_OPENAI_TIMEOUT_MS must be a positive integer, got: ${openaiTimeoutEnv}`);
    }
    return next;
}
export function loadConfig(path) {
    if (!existsSync(path)) {
        throw new Error(`Config file not found: ${path}`);
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (err) {
        throw new Error(`Config file ${path} is not valid JSON: ${err.message}`);
    }
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
            .join("\n");
        throw new Error(`Invalid config at ${path}:\n${issues}`);
    }
    const withEnv = applyEnvOverrides(parsed.data);
    Object.freeze(withEnv.ask);
    Object.freeze(withEnv.task);
    Object.freeze(withEnv.openai);
    return Object.freeze(withEnv);
}
//# sourceMappingURL=config.js.map