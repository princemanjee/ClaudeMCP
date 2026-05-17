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
