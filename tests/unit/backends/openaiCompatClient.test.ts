import { afterEach, describe, expect, it } from "vitest";
import {
  OpenAICompatClient,
  OpenAICompatHTTPError,
  OpenAICompatTimeoutError
} from "../../../src/backends/openaiCompatClient.js";
import {
  startMockLmStudio,
  type MockLmStudioHandle
} from "../../fixtures/mock-lmstudio/inProcess.js";

describe("OpenAICompatClient — constructor + listModels", () => {
  let handle: MockLmStudioHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("constructs with baseUrl and reads back the configured fields", () => {
    const c = new OpenAICompatClient({
      baseUrl: "http://example.test/v1",
      apiKey: "secret",
      timeoutMs: 12345
    });
    expect(c.baseUrl).toBe("http://example.test/v1");
    expect(c.timeoutMs).toBe(12345);
  });

  it("strips a trailing slash from baseUrl", () => {
    const c = new OpenAICompatClient({
      baseUrl: "http://example.test/v1/",
      timeoutMs: 100
    });
    expect(c.baseUrl).toBe("http://example.test/v1");
  });

  it("listModels returns data[] from the server", async () => {
    handle = await startMockLmStudio({ models: ["a", "b", "c"] });
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 5000 });
    const data = (await c.listModels()) as Array<{ id: string }>;
    expect(data.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("listModels forwards Authorization bearer when apiKey is set", async () => {
    handle = await startMockLmStudio({
      models: ["only-with-bearer"],
      requiredBearer: "topsecret"
    });
    const c = new OpenAICompatClient({
      baseUrl: handle.url,
      apiKey: "topsecret",
      timeoutMs: 5000
    });
    const data = (await c.listModels()) as Array<{ id: string }>;
    expect(data.map((m) => m.id)).toEqual(["only-with-bearer"]);
  });

  it("listModels throws OpenAICompatHTTPError on 401", async () => {
    handle = await startMockLmStudio({
      models: ["x"],
      requiredBearer: "right-bearer"
    });
    const c = new OpenAICompatClient({
      baseUrl: handle.url,
      apiKey: "wrong-bearer",
      timeoutMs: 5000
    });
    await expect(c.listModels()).rejects.toBeInstanceOf(OpenAICompatHTTPError);
    try {
      await c.listModels();
    } catch (e) {
      expect(e).toBeInstanceOf(OpenAICompatHTTPError);
      const err = e as OpenAICompatHTTPError;
      expect(err.status).toBe(401);
      expect(err.body).toMatchObject({ error: { type: "auth_error" } });
    }
  });

  it("listModels throws OpenAICompatTimeoutError when client timeout fires", async () => {
    handle = await startMockLmStudio({ latencyMs: 5000 });
    const c = new OpenAICompatClient({ baseUrl: handle.url, timeoutMs: 100 });
    await expect(c.listModels()).rejects.toBeInstanceOf(
      OpenAICompatTimeoutError
    );
  });
});
