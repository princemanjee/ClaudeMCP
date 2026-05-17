import { createHash } from "node:crypto";
import type { Archive, ArchiveEntry, ArchiveStatus } from "../archive.js";

/**
 * Shared archive-write helper for shim request handlers.
 *
 * The Anthropic shim's /v1/messages handler has its own bespoke archive
 * pipeline (it carries cache-key state that doubles as the requestHash). The
 * OpenAI and Gemini shims don't have that state and so use this helper to
 * synthesize a stable request hash from the request body + the resolved
 * backend/model, and to write the archive entry asynchronously off the
 * response path (fire-and-forget, errors logged but swallowed).
 */

export interface RecordCompletionInput {
  endpoint: string;
  backend: string;
  modelResolved: string | null;
  logId: string;
  startedAtMs: number;
  durationMs: number;
  status: ArchiveStatus;
  inputTokens?: number | null;
  outputTokens?: number | null;
  requestBody: unknown;
  responseBody: unknown;
  sessionId?: string | null;
}

function hashRequest(parts: {
  endpoint: string;
  backend: string;
  modelResolved: string | null;
  requestBody: unknown;
}): string {
  const canonical = JSON.stringify({
    endpoint: parts.endpoint,
    backend: parts.backend,
    modelResolved: parts.modelResolved,
    requestBody: parts.requestBody
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Build the archive entry from a completed request. Pure — does not write.
 * Exposed for unit tests; callers normally use `recordCompletion`.
 */
export function buildArchiveEntry(input: RecordCompletionInput): ArchiveEntry {
  return {
    requestHash: hashRequest({
      endpoint: input.endpoint,
      backend: input.backend,
      modelResolved: input.modelResolved,
      requestBody: input.requestBody
    }),
    logId: input.logId,
    endpoint: input.endpoint,
    backend: input.backend,
    modelResolved: input.modelResolved,
    sessionId: input.sessionId ?? null,
    timestamp: new Date(input.startedAtMs).toISOString(),
    status: input.status,
    durationMs: input.durationMs,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    requestBody: input.requestBody,
    responseBody: input.responseBody
  };
}

/**
 * Write an archive entry from the response path without blocking the
 * caller. Errors are logged to stderr but never thrown — the archive is
 * observability, not a hard dependency on the request path.
 */
export function recordCompletion(
  archive: Archive,
  input: RecordCompletionInput
): void {
  const entry = buildArchiveEntry(input);
  setImmediate(() => {
    try {
      archive.recordEntry(entry);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("archive.recordEntry failed:", err);
    }
  });
}
