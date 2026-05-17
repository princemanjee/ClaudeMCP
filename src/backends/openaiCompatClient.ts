// Shared HTTP client for any OpenAI-shape server. LM Studio uses this in Plan
// 08; Ollama (OpenAI-compat mode) reuses it in Plan 09. No backend-specific
// logic — request/response shapes are exactly what the OpenAI API documents.
//
// Methods land across multiple tasks:
//   Task 2 (here): constructor, error classes, listModels
//   Task 3:         chatCompletions (streaming) + chatCompletionsBuffered
//   Task 4:         embeddings

export interface OpenAICompatClientConfig {
  /** Base URL ending in `/v1` (trailing slash optional; stripped on construction). */
  baseUrl: string;
  /** Optional Bearer token. When set, forwarded as Authorization: Bearer <apiKey>. */
  apiKey?: string;
  /** Per-request timeout in ms. */
  timeoutMs: number;
}

export class OpenAICompatHTTPError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "OpenAICompatHTTPError";
  }
}

export class OpenAICompatTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAICompatTimeoutError";
  }
}

export class OpenAICompatClient {
  public readonly baseUrl: string;
  public readonly timeoutMs: number;
  private readonly apiKey: string | undefined;

  constructor(config: OpenAICompatClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey && config.apiKey.length > 0 ? config.apiKey : undefined;
    this.timeoutMs = config.timeoutMs;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return { ...h, ...extra };
  }

  /** Internal — wraps fetch with abort-on-timeout and OpenAICompat error envelope. */
  private async fetchJson(
    path: string,
    init: RequestInit
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal
      });
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") {
        throw new OpenAICompatTimeoutError(
          `request to ${this.baseUrl}${path} timed out after ${this.timeoutMs}ms`
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let body: unknown = undefined;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      throw new OpenAICompatHTTPError(
        `HTTP ${response.status} from ${this.baseUrl}${path}`,
        response.status,
        body
      );
    }
    return body;
  }

  async listModels(): Promise<unknown[]> {
    const raw = (await this.fetchJson("/models", {
      method: "GET",
      headers: this.headers()
    })) as { data?: unknown[] } | undefined;
    return raw?.data ?? [];
  }

  /**
   * Buffered (non-streaming) chat completion. The body's `stream` field is
   * forced to false regardless of caller input — use `chatCompletions()` for
   * streaming.
   */
  async chatCompletionsBuffered(body: unknown): Promise<unknown> {
    const merged = { ...(body as Record<string, unknown>), stream: false };
    return this.fetchJson("/chat/completions", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(merged)
    });
  }

  /**
   * Streaming chat completion. Yields one parsed JSON object per SSE event,
   * silently dropping `[DONE]` and any event that fails to JSON-parse. Throws
   * `OpenAICompatHTTPError` if the initial response is non-2xx (before any
   * events are yielded). Throws `OpenAICompatTimeoutError` if the timeout
   * fires mid-stream.
   */
  async *chatCompletions(body: unknown): AsyncIterable<unknown> {
    const merged = { ...(body as Record<string, unknown>), stream: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers({ Accept: "text/event-stream" }),
        body: JSON.stringify(merged),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if ((e as { name?: string }).name === "AbortError") {
        throw new OpenAICompatTimeoutError(
          `chat completion stream to ${this.baseUrl} timed out`
        );
      }
      throw e;
    }

    if (!response.ok) {
      clearTimeout(timer);
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // text body
      }
      throw new OpenAICompatHTTPError(
        `HTTP ${response.status} from chat completions`,
        response.status,
        body
      );
    }

    if (!response.body) {
      clearTimeout(timer);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Split on double-newline event boundaries.
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const eventChunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          // Each event chunk is one or more `field: value` lines. We care
          // only about `data: ` lines.
          for (const line of eventChunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice("data: ".length);
            if (payload === "[DONE]") {
              // Terminator — drain remaining buffer and exit.
              return;
            }
            try {
              yield JSON.parse(payload);
            } catch {
              // skip malformed event
            }
          }

          boundary = buffer.indexOf("\n\n");
        }
      }
      // Process trailing buffer (rare — most servers always end with \n\n).
      const trailing = buffer.trim();
      if (trailing.startsWith("data: ")) {
        const payload = trailing.slice("data: ".length);
        if (payload !== "[DONE]") {
          try {
            yield JSON.parse(payload);
          } catch {
            // skip
          }
        }
      }
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") {
        throw new OpenAICompatTimeoutError(
          `chat completion stream to ${this.baseUrl} timed out`
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async embeddings(body: unknown): Promise<unknown> {
    return this.fetchJson("/embeddings", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body)
    });
  }
}
