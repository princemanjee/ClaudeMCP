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

class EmbedNotFoundError extends Error {
  constructor() {
    super("ollama embed: /api/embed not found");
    this.name = "EmbedNotFoundError";
  }
}

export class OllamaNativeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  /**
   * Per-instance probe cache: which embeddings path responded successfully?
   *   null  → not yet probed
   *   "v2"  → /api/embed worked
   *   "v1"  → /api/embed 404'd; using /api/embeddings legacy path
   */
  private embedPath: null | "v1" | "v2" = null;

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

  /**
   * Embeddings. Tries /api/embed first (modern), falls back to /api/embeddings
   * (legacy single-prompt shape) on HTTP 404. The legacy path is called once
   * per input string and the results merged into the modern response shape so
   * callers see a uniform `{embeddings: number[][]}` regardless of server age.
   */
  async embed(body: { model: string; input: string | string[] } & Record<string, unknown>): Promise<unknown> {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];

    if (this.embedPath === null || this.embedPath === "v2") {
      try {
        const resp = await this.embedModern(body, inputs);
        this.embedPath = "v2";
        return resp;
      } catch (err) {
        if (err instanceof EmbedNotFoundError) {
          this.embedPath = "v1";
          // fall through to legacy path
        } else {
          throw err;
        }
      }
    }

    // Legacy path: one POST per input string.
    const embeddings: number[][] = [];
    for (const input of inputs) {
      const legacyBody: Record<string, unknown> = { ...body, prompt: input };
      delete legacyBody.input;
      const url = `${this.baseUrl}/api/embeddings`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(legacyBody),
          signal: ctl.signal
        });
        if (!res.ok) {
          throw new Error(
            `ollama embed (legacy) failed: HTTP ${res.status} ${res.statusText} @ ${url}`
          );
        }
        const parsed = (await res.json()) as { embedding?: number[] };
        if (!Array.isArray(parsed.embedding)) {
          throw new Error(`ollama embed (legacy) response missing embedding[] @ ${url}`);
        }
        embeddings.push(parsed.embedding);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`ollama embed timeout after ${this.timeoutMs}ms @ ${url}`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    return { model: body.model, embeddings };
  }

  private async embedModern(
    body: Record<string, unknown>,
    inputs: string[]
  ): Promise<unknown> {
    const url = `${this.baseUrl}/api/embed`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, input: inputs }),
        signal: ctl.signal
      });
      if (res.status === 404) {
        throw new EmbedNotFoundError();
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `ollama embed failed: HTTP ${res.status} ${res.statusText} @ ${url}` +
            (text ? `: ${text.slice(0, 200)}` : "")
        );
      }
      return await res.json();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`ollama embed timeout after ${this.timeoutMs}ms @ ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One-shot variant of chat(): POST /api/chat with stream: false. Returns
   * the parsed terminal JSON object directly. Used by countTokens probes.
   */
  async chatBuffered(body: Record<string, unknown>): Promise<unknown> {
    // Even with stream: false, Ollama may still emit a single NDJSON line
    // (depending on version). Reuse chat() and return the last yielded event.
    let last: unknown = null;
    for await (const ev of this.chat({ ...body, stream: false })) {
      last = ev;
    }
    if (last === null) {
      throw new Error(`ollama chatBuffered: stream produced zero events`);
    }
    return last;
  }
}
