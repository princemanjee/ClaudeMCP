import type { Request, RequestHandler, Response } from "express";
import { randomBytes } from "node:crypto";
import { checkAuth, type AuthCarrier } from "../auth.js";
import type { BackendRegistry } from "../backends/registry.js";
import type {
  Backend,
  BackendId,
  NormalizedEvent
} from "../backends/types.js";
import { identifyBackend } from "../modelRouter.js";
import type { Archive, ArchiveEntry, ArchiveStatus } from "../archive.js";
import type { CacheKeyParts, ResponseCache } from "../responseCache.js";
import { buildCacheKey } from "../responseCache.js";
import type { FileStore } from "../fileStore.js";
import {
  authenticationError,
  internalServerError,
  invalidRequestError,
  notFoundError,
  ShimRequestError
} from "./errors.js";
import { anthropicRequestToNormalized } from "./requestTranslator.js";
import {
  normalizedEventsToFinalResponse,
  normalizedEventsToSSE,
  type ResponseMeta
} from "./responseTranslator.js";
import type { AnthropicMessagesRequest } from "./types.js";

export interface MessagesHandlerConfig {
  apiKey: string;
  router: { defaultBackend: BackendId };
}

export interface MessagesHandlerDeps {
  registry: BackendRegistry;
  archive: Archive;
  responseCache: ResponseCache;
  fileStore?: FileStore;
  config: MessagesHandlerConfig;
}

function newMessageId(): string {
  return `msg_${randomBytes(12).toString("hex")}`;
}

function resolveBackend(
  registry: BackendRegistry,
  defaultBackend: BackendId,
  requestedModel: string
): { backend: Backend; resolvedModel: string } | { error: "not_found" } {
  const ident = identifyBackend(requestedModel, defaultBackend);
  if (ident.backend !== null) {
    const backend = registry.get(ident.backend);
    if (!backend) return { error: "not_found" };
    return { backend, resolvedModel: ident.remainingModel || requestedModel };
  }
  // Bare local model name — consult the registry's discovered model map.
  const found = registry.resolveModel(ident.remainingModel);
  if (found) return { backend: found, resolvedModel: ident.remainingModel };
  return { error: "not_found" };
}

function hasCacheControl(body: AnthropicMessagesRequest): boolean {
  for (const msg of body.messages ?? []) {
    if (typeof msg.content === "string") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && typeof block === "object" && "cache_control" in block) return true;
    }
  }
  return false;
}

function splitCacheable(body: AnthropicMessagesRequest): {
  prefix: unknown[];
  tail: unknown[];
} {
  // Cacheable prefix ends at the last `ephemeral` block; everything after
  // (inclusive of the next block) is the tail.
  const flattened: Array<{ role: string; block: unknown }> = [];
  for (const msg of body.messages ?? []) {
    if (typeof msg.content === "string") {
      flattened.push({ role: msg.role, block: { type: "text", text: msg.content } });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) flattened.push({ role: msg.role, block });
    }
  }
  let lastEphemeralIdx = -1;
  for (let i = 0; i < flattened.length; i++) {
    const b = flattened[i]?.block as Record<string, unknown> | undefined;
    if (b && typeof b === "object" && "cache_control" in b) lastEphemeralIdx = i;
  }
  return {
    prefix: flattened.slice(0, lastEphemeralIdx + 1),
    tail: flattened.slice(lastEphemeralIdx + 1)
  };
}

function archiveRequestHash(parts: CacheKeyParts): string {
  // Reuse the cache canonicalization for the archive hash; doc'd in the spec.
  return buildCacheKey(parts);
}

function fireAndForgetArchive(archive: Archive, entry: ArchiveEntry): void {
  setImmediate(() => {
    try {
      archive.recordEntry(entry);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("archive.recordEntry failed:", err);
    }
  });
}

async function* synthesizeEventsFromBody(
  body: Record<string, unknown>
): AsyncIterable<NormalizedEvent> {
  yield { kind: "message_start", model: (body.model as string) ?? "" };
  const content = (body.content as Array<Record<string, unknown>>) ?? [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block?.type === "text" && typeof block.text === "string") {
      yield { kind: "text_delta", index: i, text: block.text };
    }
  }
  const usage = body.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  yield {
    kind: "message_stop",
    stopReason: (body.stop_reason as never) ?? "end_turn",
    ...(usage
      ? {
          usage: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0
          }
        }
      : {})
  };
}

async function replayCachedAsSSE(
  cached: { body: Record<string, unknown> },
  meta: ResponseMeta,
  res: Response
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const synthEvents = synthesizeEventsFromBody(cached.body);
  for await (const chunk of normalizedEventsToSSE(synthEvents, meta)) {
    res.write(chunk);
  }
  res.end();
}

export function createMessagesHandler(deps: MessagesHandlerDeps): RequestHandler {
  return async (req: Request, res: Response) => {
    // ---- Auth -----------------------------------------------------------
    if (!checkAuth(req as unknown as AuthCarrier, deps.config.apiKey)) {
      res.status(401).json(authenticationError("invalid or missing API key"));
      return;
    }

    // ---- Translate ------------------------------------------------------
    const body = req.body as AnthropicMessagesRequest;
    let normalized;
    try {
      normalized = await anthropicRequestToNormalized(body, {
        fileStore: deps.fileStore
      });
    } catch (e) {
      if (e instanceof ShimRequestError) {
        res.status(e.status).json(invalidRequestError(e.message));
        return;
      }
      res
        .status(500)
        .json(internalServerError(e instanceof Error ? e.message : String(e)));
      return;
    }

    // ---- Route ----------------------------------------------------------
    const resolved = resolveBackend(
      deps.registry,
      deps.config.router.defaultBackend,
      normalized.model
    );
    if ("error" in resolved) {
      res
        .status(404)
        .json(notFoundError(`model ${normalized.model} not found in any enabled backend`));
      return;
    }
    const { backend } = resolved;

    // ---- Invoke ---------------------------------------------------------
    const messageId = newMessageId();
    const meta: ResponseMeta = { messageId, model: normalized.model };
    const wantStream = body.stream === true;

    // ---- Cache check ----------------------------------------------------
    const wantsCache = hasCacheControl(body);
    let cacheKey: string | undefined;
    if (wantsCache) {
      const { prefix, tail } = splitCacheable(body);
      const cacheKeyParts: CacheKeyParts = {
        backendId: backend.id,
        resolvedModel: normalized.model,
        system: normalized.system,
        cacheablePrefix: prefix,
        tail,
        tools: normalized.tools,
        toolChoice: normalized.toolChoice
      };
      cacheKey = buildCacheKey(cacheKeyParts);
      const hit = deps.responseCache.get(cacheKey);
      if (hit) {
        if (wantStream) {
          await replayCachedAsSSE(hit, meta, res);
        } else {
          res.status(200).json(hit.body);
        }
        // Still archive the cache hit so observability sees the request.
        fireAndForgetArchive(deps.archive, {
          requestHash: cacheKey,
          logId: messageId,
          endpoint: "/v1/messages",
          backend: backend.id,
          modelResolved: normalized.model,
          sessionId: null,
          timestamp: new Date().toISOString(),
          status: "ok",
          durationMs: 0,
          inputTokens: null,
          outputTokens: null,
          requestBody: { raw: body, normalized },
          responseBody: { ...hit.body, _cache_hit: true }
        });
        return;
      }
    }

    const started = Date.now();
    let finalBody: Record<string, unknown> | undefined;
    let status: ArchiveStatus = "ok";

    try {
      const events = backend.invoke(normalized);

      if (wantStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        // Tee the events into both the SSE writer and a buffer for cache/archive.
        const collected: NormalizedEvent[] = [];
        const teed: AsyncIterable<NormalizedEvent> = (async function* () {
          for await (const ev of events) {
            collected.push(ev);
            yield ev;
          }
        })();
        for await (const chunk of normalizedEventsToSSE(teed, meta)) {
          res.write(chunk);
        }
        res.end();
        finalBody = (await normalizedEventsToFinalResponse(
          (async function* () {
            for (const ev of collected) yield ev;
          })(),
          meta
        )) as unknown as Record<string, unknown>;
      } else {
        const built = await normalizedEventsToFinalResponse(events, meta);
        finalBody = built as unknown as Record<string, unknown>;
        res.status(200).json(built);
      }
    } catch (e) {
      status = "error";
      const msg = e instanceof Error ? e.message : String(e);
      finalBody = { type: "error", error: { type: "api_error", message: msg } };
      if (!res.headersSent) {
        res.status(500).json(internalServerError(`backend error: ${msg}`));
      } else {
        res.end();
      }
    }

    // ---- Cache write ----------------------------------------------------
    if (wantsCache && cacheKey && finalBody && status === "ok") {
      deps.responseCache.set(cacheKey, {
        body: finalBody,
        metadata: { backendId: backend.id, resolvedModel: normalized.model }
      });
    }

    // ---- Archive write (fire-and-forget) --------------------------------
    fireAndForgetArchive(deps.archive, {
      requestHash:
        cacheKey ??
        archiveRequestHash({
          backendId: backend.id,
          resolvedModel: normalized.model,
          system: normalized.system,
          cacheablePrefix: [],
          tail: normalized.messages,
          tools: normalized.tools,
          toolChoice: normalized.toolChoice
        }),
      logId: messageId,
      endpoint: "/v1/messages",
      backend: backend.id,
      modelResolved: normalized.model,
      sessionId: null,
      timestamp: new Date(started).toISOString(),
      status,
      durationMs: Date.now() - started,
      inputTokens: null,
      outputTokens: null,
      requestBody: { raw: body, normalized },
      responseBody: finalBody ?? null
    });
  };
}
