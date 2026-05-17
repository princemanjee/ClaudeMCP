import { afterEach, describe, expect, it } from "vitest";
import { LMStudioBackend } from "../../../src/backends/lmstudioBackend.js";
import {
  startMockLmStudio,
  type MockLmStudioHandle
} from "../../fixtures/mock-lmstudio/inProcess.js";

describe("LMStudioBackend skeleton", () => {
  let handle: MockLmStudioHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  async function makeBackend(): Promise<LMStudioBackend> {
    handle = await startMockLmStudio({ models: ["qwen3-coder-30b", "nomic-embed-text"] });
    return new LMStudioBackend({
      enabled: true,
      instances: [
        {
          name: "local",
          baseUrl: handle.url,
          apiKey: "",
          priority: 50,
          timeoutMs: 5000,
          useNativeApi: null
        }
      ]
    });
  }

  it("has id 'lmstudio'", async () => {
    const b = await makeBackend();
    expect(b.id).toBe("lmstudio");
  });

  it("capabilitiesFor returns the LM Studio surface (samplingParams all true, embeddings true)", async () => {
    const b = await makeBackend();
    const caps = b.capabilitiesFor("qwen3-coder-30b");
    expect(caps.toolUse).toBe(true);
    expect(caps.multimodal).toBe(true); // conservative; per-model narrowing is future
    expect(caps.thinking).toBe(false);
    expect(caps.cacheControl).toBe("none");
    expect(caps.samplingParams).toEqual({
      temperature: true,
      topP: true,
      topK: true
    });
    expect(caps.stopSequences).toBe("native");
    expect(caps.embeddings).toBe(true); // first backend to flip this on
  });

  it("listModels returns the live probed model ids from the single instance", async () => {
    const b = await makeBackend();
    const models = await b.listModels();
    expect(models.map((m) => m.id).sort()).toEqual(
      ["nomic-embed-text", "qwen3-coder-30b"].sort()
    );
    for (const m of models) {
      expect(typeof m.id).toBe("string");
      // contextWindow may be undefined when the server doesn't report it.
    }
  });

  it("listModels returns an empty array gracefully when the server lists nothing", async () => {
    await handle?.close();
    handle = await startMockLmStudio({ models: [] });
    const b = new LMStudioBackend({
      enabled: true,
      instances: [
        {
          name: "local",
          baseUrl: handle.url,
          apiKey: "",
          priority: 50,
          timeoutMs: 5000,
          useNativeApi: null
        }
      ]
    });
    expect(await b.listModels()).toEqual([]);
  });

  it("countTokens estimates via char/4 fallback", async () => {
    const b = await makeBackend();
    // 23 chars → ceil(23/4) = 6
    const n = await b.countTokens({
      model: "qwen3-coder-30b",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello world hello world" }] }
      ]
    });
    expect(n).toBe(6);
  });

  it("countTokens sums system + multi-block messages", async () => {
    const b = await makeBackend();
    const n = await b.countTokens({
      model: "qwen3-coder-30b",
      system: "you are helpful", // 15 chars → 4
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] }, // 5 → 2
        { role: "assistant", content: [{ type: "text", text: "ok" }] }, // 2 → 1
        { role: "user", content: [{ type: "text", text: "again" }] } // 5 → 2
      ]
    });
    expect(n).toBe(4 + 2 + 1 + 2);
  });

  it("invoke throws — lands in Task 6", async () => {
    const b = await makeBackend();
    await expect(async () => {
      for await (const _ of b.invoke({
        model: "qwen3-coder-30b",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      })) {
        // no-op
      }
    }).rejects.toThrow(/invoke/);
  });

  it("embed throws — lands in Task 7", async () => {
    const b = await makeBackend();
    await expect(
      b.embed!({ model: "nomic-embed-text", input: ["hello"] })
    ).rejects.toThrow(/embed/);
  });

  it("rejects an empty instances[] in the constructor", () => {
    expect(
      () =>
        new LMStudioBackend({ enabled: true, instances: [] })
    ).toThrow(/instance/i);
  });

  it("rejects duplicate instance names in the constructor", () => {
    expect(
      () =>
        new LMStudioBackend({
          enabled: true,
          instances: [
            {
              name: "dup",
              baseUrl: "http://a.test/v1",
              apiKey: "",
              priority: 50,
              timeoutMs: 5000,
              useNativeApi: null
            },
            {
              name: "dup",
              baseUrl: "http://b.test/v1",
              apiKey: "",
              priority: 50,
              timeoutMs: 5000,
              useNativeApi: null
            }
          ]
        })
    ).toThrow(/unique/i);
  });
});
