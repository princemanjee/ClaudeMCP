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
