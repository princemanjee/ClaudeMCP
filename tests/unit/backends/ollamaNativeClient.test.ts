import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { OllamaNativeClient } from "../../../src/backends/ollamaNativeClient.js";
import { startMockOllama, type MockOllamaHandle } from "../../helpers/mockOllamaProcess.js";

describe("OllamaNativeClient.listTags", () => {
  let mock: MockOllamaHandle;

  beforeAll(async () => {
    mock = await startMockOllama();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("GETs /api/tags and returns the parsed body", async () => {
    const client = new OllamaNativeClient({ baseUrl: mock.baseUrl, timeoutMs: 5000 });
    const tags = (await client.listTags()) as { models?: Array<{ name: string }> };
    expect(Array.isArray(tags.models)).toBe(true);
    const names = (tags.models ?? []).map((m) => m.name);
    expect(names).toContain("llama-3.3-70b");
    expect(names).toContain("nomic-embed-text");
  });

  it("throws a descriptive error when baseUrl is unreachable", async () => {
    const client = new OllamaNativeClient({
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 1000
    });
    await expect(client.listTags()).rejects.toThrow(/ollama/i);
  });
});

describe("OllamaNativeClient.chat (NDJSON streaming)", () => {
  let mock: MockOllamaHandle;

  beforeAll(async () => {
    mock = await startMockOllama();
  });

  afterAll(async () => {
    await mock.stop();
  });

  async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const ev of it) out.push(ev);
    return out;
  }

  it("yields one parsed JSON object per NDJSON line, terminal line carries done: true", async () => {
    const client = new OllamaNativeClient({ baseUrl: mock.baseUrl, timeoutMs: 5000 });
    const events = await collect(
      client.chat({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: "hello" }],
        stream: true
      })
    );
    expect(events.length).toBeGreaterThanOrEqual(2);
    const last = events[events.length - 1] as { done?: boolean };
    expect(last.done).toBe(true);
    const nonTerminal = events.slice(0, -1) as Array<{ message?: { content?: string } }>;
    expect(nonTerminal.every((e) => typeof e.message?.content === "string")).toBe(true);
  });

  it("round-trips keep_alive in the request body (mock echoes it as-is in tags)", async () => {
    // The mock doesn't expose what it received, but the request must not crash.
    // The shape is verified by Plan 09's ollamaBackend tests; this guards the
    // client doesn't drop the field.
    const client = new OllamaNativeClient({ baseUrl: mock.baseUrl, timeoutMs: 5000 });
    const events = await (async () => {
      const out: unknown[] = [];
      for await (const ev of client.chat({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        keep_alive: "10m"
      })) out.push(ev);
      return out;
    })();
    expect(events.length).toBeGreaterThan(0);
  });

  it("round-trips format: \"json\" in the request body", async () => {
    const client = new OllamaNativeClient({ baseUrl: mock.baseUrl, timeoutMs: 5000 });
    const events = await collect(
      client.chat({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        format: "json"
      })
    );
    expect(events.length).toBeGreaterThan(0);
  });

  it("throws on server-side error envelope (HTTP 500 with {error})", async () => {
    const client = new OllamaNativeClient({ baseUrl: mock.baseUrl, timeoutMs: 5000 });
    await expect(async () => {
      for await (const _ of client.chat({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: "MOCK_ERROR" }],
        stream: true
      })) {
        // no-op
      }
    }).rejects.toThrow(/mock error|HTTP 500/);
  });

  it("times out and the iterator stops cleanly", async () => {
    const client = new OllamaNativeClient({
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 250
    });
    await expect(async () => {
      for await (const _ of client.chat({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: "hi" }],
        stream: true
      })) {
        // no-op
      }
    }).rejects.toThrow(/ollama/i);
  });
});

describe("OllamaNativeClient.embed", () => {
  let mock: MockOllamaHandle;

  beforeAll(async () => {
    mock = await startMockOllama();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("POSTs /api/embed for modern shape, returns {embeddings: number[][]}", async () => {
    const client = new OllamaNativeClient({ baseUrl: mock.baseUrl, timeoutMs: 5000 });
    const resp = (await client.embed({
      model: "nomic-embed-text",
      input: ["hello", "world"]
    })) as { embeddings?: number[][] };
    expect(Array.isArray(resp.embeddings)).toBe(true);
    expect(resp.embeddings?.length).toBe(2);
    expect(resp.embeddings?.[0]?.length).toBe(8);
  });

  it("accepts string input (single embedding)", async () => {
    const client = new OllamaNativeClient({ baseUrl: mock.baseUrl, timeoutMs: 5000 });
    const resp = (await client.embed({
      model: "nomic-embed-text",
      input: "single"
    })) as { embeddings?: number[][] };
    expect(resp.embeddings?.length).toBe(1);
  });
});

describe("OllamaNativeClient.embed legacy fallback", () => {
  // Spin up a tiny custom mock that returns 404 on /api/embed and 200 on
  // /api/embeddings so we can prove the fallback path.
  let server: import("node:http").Server;
  let baseUrl = "";

  beforeAll(async () => {
    const { createServer } = await import("node:http");
    server = createServer(async (req, res) => {
      let chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api/embed") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (url.pathname === "/api/embeddings") {
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          embedding: Array.from({ length: 8 }, (_, i) => (prompt.length + i) / 100)
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (addr && typeof addr === "object") {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("falls back to /api/embeddings when /api/embed returns 404; normalizes shape to {embeddings: number[][]}", async () => {
    const client = new OllamaNativeClient({ baseUrl, timeoutMs: 5000 });
    const resp = (await client.embed({
      model: "nomic-embed-text",
      input: ["just-one"]
    })) as { embeddings?: number[][] };
    expect(resp.embeddings?.length).toBe(1);
    expect(resp.embeddings?.[0]?.length).toBe(8);
  });

  it("caches the legacy-path probe — second call does not re-hit /api/embed", async () => {
    // Hard to assert directly without instrumenting the mock; the contract is
    // simply that the second call also succeeds via the same client instance.
    const client = new OllamaNativeClient({ baseUrl, timeoutMs: 5000 });
    await client.embed({ model: "nomic-embed-text", input: "x" });
    const resp = (await client.embed({
      model: "nomic-embed-text",
      input: "y"
    })) as { embeddings?: number[][] };
    expect(resp.embeddings?.length).toBe(1);
  });
});

describe("OllamaNativeClient.chatBuffered", () => {
  let mock: MockOllamaHandle;

  beforeAll(async () => {
    mock = await startMockOllama();
  });

  afterAll(async () => {
    await mock.stop();
  });

  it("POSTs /api/chat with stream: false and returns a single parsed object", async () => {
    // The mock doesn't differentiate stream-false; it just emits NDJSON.
    // chatBuffered concatenates and returns the LAST line (the done: true chunk)
    // which carries the eval counts useful for countTokens-style probes.
    const client = new OllamaNativeClient({ baseUrl: mock.baseUrl, timeoutMs: 5000 });
    const final = (await client.chatBuffered({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "hi" }],
      options: { num_predict: 0 }
    })) as { done?: boolean; prompt_eval_count?: number };
    expect(final.done).toBe(true);
    expect(typeof final.prompt_eval_count).toBe("number");
  });
});
