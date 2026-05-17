import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { BackendRegistry } from "../../../src/backends/registry.js";
import { createOpenAIModelsHandlers } from "../../../src/openaiShim/models.js";
import type {
  Backend,
  BackendCapabilities,
  BackendId,
  ModelDescriptor,
  NormalizedEvent
} from "../../../src/backends/types.js";

function stubBackend(id: BackendId, models: ModelDescriptor[]): Backend {
  const caps: BackendCapabilities = {
    toolUse: false,
    multimodal: false,
    thinking: false,
    cacheControl: "none",
    samplingParams: { temperature: false, topP: false, topK: false },
    stopSequences: "server-side-cut",
    embeddings: false
  };
  return {
    id,
    capabilitiesFor: () => caps,
    listModels: async () => models,
    invoke: async function* (): AsyncIterable<NormalizedEvent> {},
    countTokens: async () => 0
  };
}

async function buildApp(opts: {
  apiKey: string;
  backends: Backend[];
}): Promise<express.Express> {
  const registry = new BackendRegistry({
    claude: 100,
    gemini: 90,
    lmstudio: 50,
    ollama: 40
  });
  for (const b of opts.backends) registry.register(b);
  await registry.probe();

  const handlers = createOpenAIModelsHandlers({
    registry,
    config: { apiKey: opts.apiKey }
  });
  const app = express();
  app.get("/v1/models", handlers.list);
  app.get("/v1/models/:id", handlers.get);
  return app;
}

describe("GET /v1/models (OpenAI envelope)", () => {
  it("returns 401 on missing auth", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend("claude", [{ id: "claude-sonnet-4-6" }])]
    });
    const res = await request(app).get("/v1/models");
    expect(res.status).toBe(401);
  });

  it("returns the OpenAI models list envelope", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend("claude", [
          { id: "claude-opus-4-7" },
          { id: "claude-sonnet-4-6" }
        ])
      ]
    });
    const res = await request(app)
      .get("/v1/models")
      .set("Authorization", "Bearer sk-test");
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(Array.isArray(res.body.data)).toBe(true);
    for (const entry of res.body.data) {
      expect(entry).toMatchObject({
        id: expect.any(String),
        object: "model",
        created: expect.any(Number),
        owned_by: expect.any(String)
      });
    }
  });

  it("lists models across all enabled backends", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend("claude", [{ id: "claude-sonnet-4-6" }]),
        stubBackend("ollama", [{ id: "llama-3.3-70b" }])
      ]
    });
    const res = await request(app)
      .get("/v1/models")
      .set("Authorization", "Bearer sk-test");
    const ids = res.body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("llama-3.3-70b");
  });

  it("owned_by reflects the backend id", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend("lmstudio", [{ id: "nomic-embed-text" }])]
    });
    const res = await request(app)
      .get("/v1/models")
      .set("Authorization", "Bearer sk-test");
    const entry = res.body.data.find(
      (m: { id: string }) => m.id === "nomic-embed-text"
    );
    expect(entry.owned_by).toBe("lmstudio");
  });

  it("returns empty data array when no backend has any models", async () => {
    const app = await buildApp({ apiKey: "sk-test", backends: [] });
    const res = await request(app)
      .get("/v1/models")
      .set("Authorization", "Bearer sk-test");
    expect(res.body).toEqual({ object: "list", data: [] });
  });

  it("deduplicates model ids appearing in multiple backends", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend("lmstudio", [{ id: "shared" }]),
        stubBackend("ollama", [{ id: "shared" }])
      ]
    });
    const res = await request(app)
      .get("/v1/models")
      .set("Authorization", "Bearer sk-test");
    const sharedCount = res.body.data.filter(
      (m: { id: string }) => m.id === "shared"
    ).length;
    expect(sharedCount).toBe(1);
  });
});

describe("GET /v1/models/:id (OpenAI envelope)", () => {
  it("returns 401 on missing auth", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend("claude", [{ id: "claude-sonnet-4-6" }])]
    });
    const res = await request(app).get("/v1/models/claude-sonnet-4-6");
    expect(res.status).toBe(401);
  });

  it("returns the single model entry on hit", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend("claude", [{ id: "claude-sonnet-4-6" }])]
    });
    const res = await request(app)
      .get("/v1/models/claude-sonnet-4-6")
      .set("Authorization", "Bearer sk-test");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "claude-sonnet-4-6",
      object: "model",
      created: expect.any(Number),
      owned_by: "claude"
    });
  });

  it("returns 404 with not_found_error envelope on unknown model", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend("claude", [{ id: "claude-sonnet-4-6" }])]
    });
    const res = await request(app)
      .get("/v1/models/no-such-model")
      .set("Authorization", "Bearer sk-test");
    expect(res.status).toBe(404);
    expect(res.body.error.type).toBe("not_found_error");
  });
});
