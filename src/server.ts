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
    await transport.handlePostMessage(req, res, req.body);
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
