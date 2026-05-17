/**
 * ClaudeMCP server bootstrap.
 *
 * Mounts three shim surfaces:
 * - Anthropic shim: POST /v1/messages, POST /v1/messages/count_tokens,
 *   GET /v1/anthropic/models[/{id}], POST /v1/files*, ...
 * - OpenAI shim: POST /v1/chat/completions, POST /v1/embeddings,
 *   GET /v1/models[/{id}].
 * - Gemini shim: POST /v1beta/models/{model}:generateContent, ...
 *
 * Migration note: the legacy `dist/openaiShim/` (compiled-only, single-Claude-
 * backend) ships in this repo alongside the new `src/openaiShim/` (multi-
 * backend). The legacy is retained so existing Agent Zero deployments can pin
 * to either entrypoint during a transitional period; running both on different
 * ports is supported. Eventual removal of `dist/openaiShim/` is a future
 * cleanup spec.
 *
 * GET /v1/models routing: the canonical path serves the OpenAI-shaped envelope
 * (matching `openai` npm package expectations). The Anthropic-shaped envelope
 * is reachable at /v1/anthropic/models. Anthropic-SDK clients calling
 * `client.models.list()` should set `baseURL` to include `/anthropic`.
 */
import express, { type Express, type RequestHandler } from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import { Archive } from "./archive.js";
import { BackendRegistry } from "./backends/registry.js";
import { ClaudeBackend } from "./backends/claudeBackend.js";
import { GeminiBackend } from "./backends/geminiBackend.js";
import { LMStudioBackend } from "./backends/lmstudioBackend.js";
import { OllamaBackend } from "./backends/ollamaBackend.js";
import { FileStore } from "./fileStore.js";
import { ResponseCache } from "./responseCache.js";
import { loadConfig, type Config } from "./config.js";
import { checkApiKey } from "./auth.js";
import { createCountTokensHandler } from "./anthropicShim/countTokens.js";
import { createMessagesHandler } from "./anthropicShim/messages.js";
import { createModelsHandlers } from "./anthropicShim/models.js";
import { createFilesHandlers } from "./anthropicShim/files.js";
import { createCountTokensHandler as createGeminiCountTokensHandler } from "./geminiShim/countTokens.js";
import { createFilesHandlers as createGeminiFilesHandlers } from "./geminiShim/files.js";
import { createGenerateContentHandlers } from "./geminiShim/generateContent.js";
import { createGeminiModelsHandlers } from "./geminiShim/models.js";
import { createChatCompletionsHandler } from "./openaiShim/chatCompletions.js";
import { createEmbeddingsHandler } from "./openaiShim/embeddings.js";
import { createOpenAIModelsHandlers } from "./openaiShim/models.js";
import { ConfigSnapshotStore } from "./admin/configSnapshot.js";
import { mountAdminRoutes } from "./admin/router.js";
import { SessionStore } from "./admin/session.js";
import { createAdminUiHandler, readSessionCookie } from "./admin/ui.js";

export interface ServerDeps {
  config: Config;
  registry: BackendRegistry;
  archive: Archive;
  fileStore: FileStore;
  responseCache: ResponseCache;
  configSnapshot: ConfigSnapshotStore;
  /** Plan 12: optional SessionStore. If omitted, buildApp constructs one. */
  sessionStore?: SessionStore;
}

/**
 * Build the Express app without binding a port. Exported so unit tests can
 * exercise the full routing surface against supertest without race conditions.
 */
export function buildApp(deps: ServerDeps): Express {
  const app = express();
  app.use(express.json({ limit: "32mb" }));
  // Plan 12: cookie-parser populates req.cookies for the session-cookie path.
  app.use(cookieParser());

  // Plan 12: SessionStore — in-memory, TTL-evicted token map for admin UI sessions.
  const sessionStore =
    deps.sessionStore ??
    new SessionStore({ ttlMs: deps.config.adminUi.sessionTtlMs });

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

  // Anthropic-shape models endpoint moves to /v1/anthropic/models so the
  // canonical /v1/models can serve the OpenAI shape (the dominant SDK target).
  const anthropicModelsHandlers = createModelsHandlers({
    registry: deps.registry,
    config: { apiKey: deps.config.apiKey }
  });
  app.get("/v1/anthropic/models", anthropicModelsHandlers.list);
  app.get("/v1/anthropic/models/:id", anthropicModelsHandlers.get);

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

  // ---- Gemini shim ------------------------------------------------------
  const geminiHandlerConfig = {
    apiKey: deps.config.apiKey,
    router: { defaultBackend: deps.config.router.defaultBackend }
  };

  const generateHandlers = createGenerateContentHandlers({
    registry: deps.registry,
    fileStore: deps.fileStore,
    config: geminiHandlerConfig
  });
  const geminiCountTokensHandler = createGeminiCountTokensHandler({
    registry: deps.registry,
    fileStore: deps.fileStore,
    config: geminiHandlerConfig
  });

  // The colon character is a path-to-regexp 0.1.13 param sigil; the `[:]`
  // bracket escape is the load-bearing idiom for Gemini's `:method` action
  // suffix under Express 4. Each method gets two routes: the bare-id form
  // and a regex sibling that handles the `models/`-prefixed double-wrap form.
  const stripPrefix = (req: express.Request): void => {
    const m = req.params["model"];
    if (typeof m === "string" && m.startsWith("models/")) {
      req.params["model"] = m.slice("models/".length);
    }
  };

  for (const action of ["generateContent", "streamGenerateContent", "countTokens"] as const) {
    const handler: RequestHandler =
      action === "generateContent"
        ? generateHandlers.generate
        : action === "streamGenerateContent"
          ? generateHandlers.streamGenerate
          : geminiCountTokensHandler;
    // Bare-id form: /v1beta/models/<id>:<action>
    app.post(`/v1beta/models/:model[:]${action}`, handler);
    // Prefixed form: /v1beta/models/models/<id>:<action>
    app.post(
      new RegExp(`^/v1beta/models/(models/[^:]+):${action}$`),
      (req, res, next) => {
        const m = req.params[0];
        if (typeof m === "string") {
          req.params["model"] = m.startsWith("models/")
            ? m.slice("models/".length)
            : m;
        }
        stripPrefix(req);
        handler(req, res, next);
      }
    );
  }

  const geminiModelsHandlers = createGeminiModelsHandlers({
    registry: deps.registry,
    config: { apiKey: deps.config.apiKey }
  });
  app.get("/v1beta/models", geminiModelsHandlers.list);
  app.get("/v1beta/models/:id", geminiModelsHandlers.get);
  // Allow the `models/<id>` double-wrap form via a regex route:
  app.get(/^\/v1beta\/models\/models\/(.+)$/, (req, res, next) => {
    const m = req.params[0];
    if (typeof m === "string") req.params["id"] = m;
    geminiModelsHandlers.get(req, res, next);
  });

  const geminiFilesHandlers = createGeminiFilesHandlers({
    fileStore: deps.fileStore,
    config: { apiKey: deps.config.apiKey }
  });
  app.post("/v1beta/files", geminiFilesHandlers.upload);
  app.get("/v1beta/files", geminiFilesHandlers.list);
  // Mount the :download route BEFORE the bare :id route to keep path-to-regexp
  // from greedily swallowing the `:download` suffix in :id.
  app.get("/v1beta/files/:id[:]download", geminiFilesHandlers.download);
  app.get("/v1beta/files/:id", geminiFilesHandlers.getMetadata);
  app.delete("/v1beta/files/:id", geminiFilesHandlers.delete);

  // ---- OpenAI shim -----------------------------------------------------
  const openaiHandlerConfig = {
    apiKey: deps.config.apiKey,
    router: { defaultBackend: deps.config.router.defaultBackend },
    embeddings: {
      legacyBackendUrl: deps.config.embeddings.legacyBackendUrl,
      legacyApiKey: deps.config.embeddings.legacyApiKey,
      legacyTimeoutMs: deps.config.embeddings.legacyTimeoutMs
    }
  };

  app.post(
    "/v1/chat/completions",
    createChatCompletionsHandler({
      registry: deps.registry,
      config: {
        apiKey: openaiHandlerConfig.apiKey,
        router: openaiHandlerConfig.router
      }
    })
  );
  app.post(
    "/v1/embeddings",
    createEmbeddingsHandler({
      registry: deps.registry,
      config: openaiHandlerConfig
    })
  );

  const openaiModelsHandlers = createOpenAIModelsHandlers({
    registry: deps.registry,
    config: { apiKey: deps.config.apiKey }
  });
  app.get("/v1/models", openaiModelsHandlers.list);
  app.get("/v1/models/:id", openaiModelsHandlers.get);

  // ---- Admin UI (Plan 12) — mount BEFORE the /admin catch-all -----------
  // The /admin/ui Router serves static SPA assets + POST/DELETE /session,
  // none of which require auth (the page is inert without an apiKey, and the
  // POST /session endpoint IS the login). Because Express matches mounts in
  // declaration order, mounting /admin/ui first keeps it reachable while
  // every JSON /admin/* endpoint stays gated by the sessionAuthMiddleware +
  // per-handler checkAuth below.
  if (deps.config.adminUi.enabled) {
    app.use(
      "/admin/ui",
      createAdminUiHandler({
        sessionStore,
        config: {
          apiKey: deps.config.apiKey,
          adminUi: deps.config.adminUi
        },
        checkApiKey
      })
    );
  }

  // Plan 12: sessionAuthMiddleware — when a valid session cookie is present
  // on an /admin/* request, synthesize an x-api-key header so the existing
  // per-handler checkAuth (which inspects the carrier headers) succeeds. If
  // the cookie is absent or invalid, the request falls through unchanged —
  // x-api-key bearing requests authenticate normally; everything else is
  // 401'd by the per-handler auth gate.
  const sessionAuthMiddleware: express.RequestHandler = (req, _res, next) => {
    // Already authenticated via x-api-key header — nothing to do.
    if (typeof req.headers["x-api-key"] === "string" && req.headers["x-api-key"].length > 0) {
      next();
      return;
    }
    const token = readSessionCookie(req);
    if (token && sessionStore.validate(token)) {
      // Promote the cookie session to an x-api-key header for downstream
      // handlers. This keeps the existing per-handler auth unchanged.
      req.headers["x-api-key"] = deps.config.apiKey;
    }
    next();
  };
  app.use("/admin", sessionAuthMiddleware);

  // ---- Admin routes (Plan 05 + Plan 11) -------------------------------
  mountAdminRoutes(app, {
    archive: deps.archive,
    registry: deps.registry,
    snapshot: deps.configSnapshot
  });

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
  if (config.gemini.enabled) {
    registry.register(
      new GeminiBackend({
        command: config.gemini.command,
        timeoutMs: config.gemini.timeoutMs
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
  if (config.ollama.enabled && config.ollama.instances.length > 0) {
    registry.register(
      new OllamaBackend({
        enabled: config.ollama.enabled,
        useNativeApi: config.ollama.useNativeApi,
        instances: config.ollama.instances.map((inst) => ({
          name: inst.name,
          baseUrl: inst.baseUrl,
          priority: inst.priority,
          timeoutMs: inst.timeoutMs,
          useNativeApi: inst.useNativeApi,
          apiKey: inst.apiKey
        }))
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
  configSnapshot: ConfigSnapshotStore;
  sessionStore: SessionStore;
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
  const configSnapshot = new ConfigSnapshotStore({
    initial: config,
    path: opts.configPath
  });
  // Plan 12: SessionStore + periodic sweep. Construct here so we own the
  // interval and can clear it at shutdown.
  const sessionStore = new SessionStore({ ttlMs: config.adminUi.sessionTtlMs });
  const sessionSweepInterval = setInterval(() => sessionStore.sweep(), 60_000);
  sessionSweepInterval.unref();

  if (config.adminUi.enabled && !config.adminUi.bindLocalhost) {
    // eslint-disable-next-line no-console
    console.warn(
      "[startup] WARNING: config.adminUi.bindLocalhost=false; the admin UI accepts " +
        "requests from any IP. This is a security concession — confirm intentional."
    );
  }

  const app = buildApp({
    config,
    registry,
    archive,
    fileStore,
    responseCache,
    configSnapshot,
    sessionStore
  });
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
    clearInterval(sessionSweepInterval);
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
  return {
    app,
    http,
    registry,
    archive,
    fileStore,
    responseCache,
    config,
    configSnapshot,
    sessionStore,
    shutdown
  };
}
