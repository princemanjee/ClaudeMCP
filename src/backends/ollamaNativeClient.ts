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

  /**
   * POST /api/chat with stream: true. Yields one parsed JSON object per
   * NDJSON line. The caller is responsible for shape-matching (text chunks
   * have a `message.content` string; tool-call chunks have a
   * `message.tool_calls` array; the terminal chunk has `done: true`).
   *
   * The body is taken as-is and serialized. We do not validate or rewrite it
   * here — the backend's translator owns request shape.
   */
  async *chat(body: Record<string, unknown>): AsyncIterable<unknown> {
    const url = `${this.baseUrl}/api/chat`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: ctl.signal
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`ollama chat timeout after ${this.timeoutMs}ms @ ${url}`);
      }
      if (err instanceof Error) {
        throw new Error(`ollama chat connect error: ${err.message} @ ${url}`);
      }
      throw err;
    }

    if (!res.ok) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        // ignore
      }
      clearTimeout(timer);
      throw new Error(
        `ollama chat failed: HTTP ${res.status} ${res.statusText} @ ${url}` +
          (bodyText ? `: ${bodyText.slice(0, 200)}` : "")
      );
    }

    if (!res.body) {
      clearTimeout(timer);
      throw new Error(`ollama chat: response body is null @ ${url}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.length > 0) {
            try {
              yield JSON.parse(line);
            } catch {
              // Malformed NDJSON line — drop silently. Same pattern as the
              // CLI stream runners; the caller sees fewer events.
            }
          }
          nl = buffer.indexOf("\n");
        }
      }
      const trailing = buffer.trim();
      if (trailing.length > 0) {
        try {
          yield JSON.parse(trailing);
        } catch {
          // ignore
        }
      }
    } finally {
      clearTimeout(timer);
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
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
