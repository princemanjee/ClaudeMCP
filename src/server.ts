import express, { type Express } from "express";
import type { Server } from "node:http";
import { Archive } from "./archive.js";
import { BackendRegistry } from "./backends/registry.js";
import { ClaudeBackend } from "./backends/claudeBackend.js";
import { LMStudioBackend } from "./backends/lmstudioBackend.js";
import { FileStore } from "./fileStore.js";
import { ResponseCache } from "./responseCache.js";
import { loadConfig, type Config } from "./config.js";
import { createCountTokensHandler } from "./anthropicShim/countTokens.js";
import { createMessagesHandler } from "./anthropicShim/messages.js";
import { createModelsHandlers } from "./anthropicShim/models.js";
import { createFilesHandlers } from "./anthropicShim/files.js";
import { createAdminArchiveHandlers } from "./admin/archive.js";

export interface ServerDeps {
  config: Config;
  registry: BackendRegistry;
  archive: Archive;
  fileStore: FileStore;
  responseCache: ResponseCache;
}

/**
 * Build the Express app without binding a port. Exported so unit tests can
 * exercise the full routing surface against supertest without race conditions.
 */
export function buildApp(deps: ServerDeps): Express {
  const app = express();
  app.use(express.json({ limit: "32mb" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // ---- Anthropic shim --------------------------------------------------
  const handlerConfig = {
    apiKey: deps.config.apiKey,
    router: { defaultBackend: deps.config.router.defaultBackend }
  };

  app.post(
    "/v1/messages",
    createMessagesHandler({
      registry: deps.registry,
      archive: deps.archive,
      responseCache: deps.responseCache,
      fileStore: deps.fileStore,
      config: handlerConfig
    })
  );
  app.post(
    "/v1/messages/count_tokens",
    createCountTokensHandler({ registry: deps.registry, config: handlerConfig })
  );

  const modelsHandlers = createModelsHandlers({
    registry: deps.registry,
    config: { apiKey: deps.config.apiKey }
  });
  app.get("/v1/models", modelsHandlers.list);
  app.get("/v1/models/:id", modelsHandlers.get);

  // ---- Files API -------------------------------------------------------
  const filesHandlers = createFilesHandlers({
    fileStore: deps.fileStore,
    config: { apiKey: deps.config.apiKey }
  });
  app.post("/v1/files", filesHandlers.upload);
  app.get("/v1/files", filesHandlers.list);
  app.get("/v1/files/:id", filesHandlers.getMetadata);
  app.get("/v1/files/:id/content", filesHandlers.download);
  app.delete("/v1/files/:id", filesHandlers.delete);

  // ---- Admin archive ---------------------------------------------------
  const adminArchive = createAdminArchiveHandlers({
    archive: deps.archive,
    config: { apiKey: deps.config.apiKey }
  });
  app.get("/admin/archive", adminArchive.list);
  app.get("/admin/archive/search", adminArchive.search);
  app.get("/admin/archive/:id", adminArchive.getById);

  return app;
}

/**
 * Build a registry populated with every enabled backend. Plan 08 adds
 * LMStudioBackend alongside ClaudeBackend; Plan 06's GeminiBackend will land
 * here once Plan 07 ships. Ollama lands in Plan 09.
 */
export function buildRegistry(config: Config): BackendRegistry {
  const registry = new BackendRegistry({
    claude: config.claude.priority,
    gemini: config.gemini.priority,
    lmstudio: 50,
    ollama: 40
  });
  if (config.claude.enabled) {
    registry.register(
      new ClaudeBackend({
        command: config.claude.command,
        timeoutMs: config.claude.timeoutMs
      })
    );
  }
  if (config.lmstudio.enabled && config.lmstudio.instances.length > 0) {
    registry.register(
      new LMStudioBackend({
        enabled: config.lmstudio.enabled,
        instances: config.lmstudio.instances
      })
    );
  }
  return registry;
}

export interface MainOptions {
  configPath: string;
  port?: number;
}

export interface RunningServer {
  app: Express;
  http: Server;
  registry: BackendRegistry;
  archive: Archive;
  fileStore: FileStore;
  responseCache: ResponseCache;
  config: Config;
  shutdown: () => Promise<void>;
}

const DEFAULT_PORT = 3210;

/**
 * Top-level bootstrap. Loads config, constructs the registry + archive,
 * builds the Express app, starts a server on the requested port (or 3210),
 * begins the periodic probe, and wires SIGINT/SIGTERM to graceful shutdown.
 */
export async function main(opts: MainOptions): Promise<RunningServer> {
  const config = loadConfig(opts.configPath);
  const archive = new Archive(config.archive.dbPath);
  const fileStore = new FileStore({
    dir: config.files.dir,
    ttlMs: config.files.ttlMs,
    maxTotalBytes: config.files.maxTotalBytes
  });
  const responseCache = new ResponseCache({
    file: config.cache.file,
    ttlMs: config.cache.ttlMs,
    maxEntries: config.cache.maxEntries
  });
  const registry = buildRegistry(config);

  const app = buildApp({ config, registry, archive, fileStore, responseCache });
  const port = opts.port ?? DEFAULT_PORT;
  const http = app.listen(port);

  await new Promise<void>((resolve, reject) => {
    http.once("listening", () => resolve());
    http.once("error", reject);
  });

  registry.startPeriodicProbe(config.router.localProbeIntervalMs);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    registry.stop();
    fileStore.stop();
    archive.close();
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => resolve(), 5000);
      http.close(() => {
        clearTimeout(force);
        resolve();
      });
    });
  };

  const onSignal = (): void => {
    void shutdown();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  // eslint-disable-next-line no-console
  console.log(`ClaudeMCP listening on http://127.0.0.1:${port}`);
  return { app, http, registry, archive, fileStore, responseCache, config, shutdown };
}
