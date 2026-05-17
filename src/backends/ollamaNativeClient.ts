// Thin HTTP client for Ollama's native /api/* endpoints.
//
// This module is intentionally NOT translating to NormalizedEvent — that's
// OllamaBackend's job. The client returns parsed JSON (one-shot endpoints) or
// AsyncIterable<unknown> of parsed NDJSON lines (streaming endpoints). The
// caller pattern-matches the raw shapes.
//
// Methods (full surface lands across Tasks 2-4):
//   listTags()           → GET  /api/tags
//   chat(body)           → POST /api/chat  with stream: true (NDJSON)
//   chatBuffered(body)   → POST /api/chat  with stream: false (single JSON)
//   embed(body)          → POST /api/embed (falls back to /api/embeddings on 404)
//
// All methods use AbortController for timeouts. Errors carry the URL and HTTP
// status when available so callers can distinguish connection-refused from
// 5xx from malformed responses.

export interface OllamaNativeClientOptions {
  /** Root URL, e.g. "http://127.0.0.1:11434". No trailing slash. */
  baseUrl: string;
  /** Per-call timeout in milliseconds. */
  timeoutMs: number;
}

export class OllamaNativeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: OllamaNativeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs;
  }

  /** GET /api/tags */
  async listTags(): Promise<unknown> {
    const url = `${this.baseUrl}/api/tags`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: "GET", signal: ctl.signal });
      if (!res.ok) {
        throw new Error(
          `ollama listTags failed: HTTP ${res.status} ${res.statusText} @ ${url}`
        );
      }
      return await res.json();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`ollama listTags timeout after ${this.timeoutMs}ms @ ${url}`);
      }
      if (err instanceof Error) {
        throw new Error(`ollama listTags error: ${err.message} @ ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
