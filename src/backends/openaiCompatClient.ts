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

  // Methods chatCompletions, chatCompletionsBuffered, embeddings land in
  // subsequent tasks.
}
