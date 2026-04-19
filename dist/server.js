import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { SessionStore } from "./sessionStore.js";
import { registerClaudeAsk } from "./tools/claudeAsk.js";
import { registerClaudeTask } from "./tools/claudeTask.js";
import { createOpenAIHandler } from "./openaiShim/handler.js";
const TTL_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
function parseConfigPath(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            config: { type: "string", short: "c", default: "configs/default.json" },
        },
        allowPositionals: true,
    });
    return values.config ?? "configs/default.json";
}
export async function main(argv = process.argv.slice(2)) {
    const configPath = parseConfigPath(argv);
    const config = loadConfig(configPath);
    const logger = new Logger(config.logFile);
    const store = new SessionStore(config.sessionStoreFile);
    await store.load();
    const mcp = new McpServer({ name: "ClaudeMCP", version: "0.1.0" });
    registerClaudeAsk(mcp, config, logger);
    registerClaudeTask(mcp, config, logger, store);
    const openaiHandler = config.openai.enabled
        ? createOpenAIHandler(config, logger, store)
        : null;
    const app = express();
    let transport = null;
    app.get("/sse", async (_req, res) => {
        transport = new SSEServerTransport("/message", res);
        await mcp.connect(transport);
    });
    app.post("/message", express.json(), async (req, res) => {
        if (!transport) {
            res.status(400).json({ error: "No active SSE connection" });
            return;
        }
        await transport.handlePostMessage(req, res, req.body);
    });
    app.get("/health", (_req, res) => {
        res.json({ ok: true, sessions: store.size() });
    });
    if (openaiHandler) {
        app.post("/v1/chat/completions", express.json({ limit: "10mb" }), (req, res) => {
            openaiHandler(req, res).catch((err) => {
                console.error("[openaiShim] unhandled error:", err);
                if (!res.headersSent) {
                    res.status(500).json({
                        error: {
                            message: err.message ?? "internal error",
                            type: "api_error",
                        },
                    });
                }
            });
        });
    }
    const sweepTimer = setInterval(() => {
        store
            .evictExpired(config.task.sessionTtlMs)
            .catch((err) => console.error("[sweep] eviction failed:", err.message));
    }, TTL_SWEEP_INTERVAL_MS);
    const httpServer = await new Promise((resolve) => {
        const s = app.listen(config.port, config.host, () => {
            console.log(`[ClaudeMCP] listening at http://${config.host}:${config.port}/sse`);
            if (config.openai.enabled) {
                console.log(`[ClaudeMCP] OpenAI endpoint: http://${config.host}:${config.port}/v1/chat/completions`);
            }
            console.log(`[ClaudeMCP] log: ${config.logFile}`);
            console.log(`[ClaudeMCP] sessions: ${config.sessionStoreFile}`);
            resolve(s);
        });
    });
    async function close() {
        clearInterval(sweepTimer);
        // Forcibly close keep-alive / SSE connections so the server drains fast
        // and any file-handle locks are released (important on Windows).
        httpServer
            .closeAllConnections?.();
        await new Promise((resolve) => httpServer.close(() => resolve()));
        await logger.flush();
        // On Windows, spawned child processes may hold a directory handle for a
        // brief moment after exit (cwd lock). A short drain gives the OS time to
        // release those handles before callers delete the working directory.
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { close, port: config.port };
}
//# sourceMappingURL=server.js.map