import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { BackendRegistry } from "../../../src/backends/registry.js";
import { createGeminiModelsHandlers } from "../../../src/geminiShim/models.js";
import type {
  Backend,
  BackendCapabilities,
  BackendId,
  ModelDescriptor,
  NormalizedRequest
} from "../../../src/backends/types.js";

function stubBackend(opts: {
  id: BackendId;
  models: ModelDescriptor[];
  failsList?: boolean;
}): Backend {
  const caps: BackendCapabilities = {
    toolUse: true,
    multimodal: true,
    thinking: false,
    cacheControl: "none",
    samplingParams: { temperature: true, topP: true, topK: true },
    stopSequences: "native",
    embeddings: false
  };
  return {
    id: opts.id,
    capabilitiesFor: () => caps,
    listModels: async () => {
      if (opts.failsList) throw new Error("listModels failed");
      return opts.models.map((m) => ({ ...m }));
    },
    invoke: async function* (_req: NormalizedRequest) {
      // unused
    },
    countTokens: async () => 1
  };
}

function buildApp(opts: {
  apiKey: string;
  backends: Backend[];
}): express.Express {
  const registry = new BackendRegistry({
    claude: 100,
    gemini: 90,
    lmstudio: 50,
    ollama: 40
  });
  for (const b of opts.backends) registry.register(b);
  const handlers = createGeminiModelsHandlers({
    registry,
    config: { apiKey: opts.apiKey }
  });
  const app = express();
  app.get("/v1beta/models", handlers.list);
  app.get("/v1beta/models/:id", handlers.get);
  return app;
}

describe("Gemini /v1beta/models — list", () => {
  it("returns 401 on missing auth", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend({
          id: "gemini",
          models: [{ id: "gemini-pro" }]
        })
      ]
    });
    const res = await request(app).get("/v1beta/models");
    expect(res.status).toBe(401);
  });

  it("returns {models: [...]} with required fields", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend({
          id: "gemini",
          models: [
            { id: "gemini-pro", description: "Most capable" }
          ]
        })
      ]
    });
    const res = await request(app).get("/v1beta/models").set("x-goog-api-key", "sk-test");
    expect(res.status).toBe(200);
    expect(res.body.models).toBeDefined();
    for (const m of res.body.models) {
      expect(m.name).toBeDefined();
      expect(m.displayName).toBeDefined();
      expect(m.description).toBeDefined();
      expect(m.supportedGenerationMethods).toBeDefined();
    }
  });

  it("each name is prefixed with models/", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend({
          id: "gemini",
          models: [{ id: "gemini-pro" }, { id: "gemini-flash" }]
        })
      ]
    });
    const res = await request(app).get("/v1beta/models").set("x-goog-api-key", "sk-test");
    for (const m of res.body.models) {
      expect(m.name.startsWith("models/")).toBe(true);
    }
  });

  it("returns both claude-* and gemini-* models (cross-backend)", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend({
          id: "gemini",
          models: [{ id: "gemini-pro" }, { id: "gemini-flash" }]
        }),
        stubBackend({
          id: "claude",
          models: [{ id: "claude-opus-4-7" }, { id: "claude-sonnet-4-6" }]
        })
      ]
    });
    const res = await request(app).get("/v1beta/models").set("x-goog-api-key", "sk-test");
    const names = res.body.models.map((m: { name: string }) => m.name);
    expect(names).toContain("models/gemini-pro");
    expect(names).toContain("models/gemini-flash");
    expect(names).toContain("models/claude-opus-4-7");
    expect(names).toContain("models/claude-sonnet-4-6");
  });

  it("empty list when registry has no probed models", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: [] })]
    });
    const res = await request(app).get("/v1beta/models").set("x-goog-api-key", "sk-test");
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
  });

  it("deduplicates models that appear in multiple backends", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend({ id: "gemini", models: [{ id: "shared" }] }),
        stubBackend({ id: "claude", models: [{ id: "shared" }] })
      ]
    });
    const res = await request(app).get("/v1beta/models").set("x-goog-api-key", "sk-test");
    const sharedEntries = res.body.models.filter(
      (m: { name: string }) => m.name === "models/shared"
    );
    expect(sharedEntries.length).toBe(1);
  });
});

describe("Gemini /v1beta/models/:id — get", () => {
  it("returns 401 on missing auth", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: [{ id: "gemini-pro" }] })]
    });
    const res = await request(app).get("/v1beta/models/gemini-pro");
    expect(res.status).toBe(401);
  });

  it("returns single entry with bare id", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend({
          id: "gemini",
          models: [{ id: "gemini-pro", description: "best" }]
        })
      ]
    });
    const res = await request(app)
      .get("/v1beta/models/gemini-pro")
      .set("x-goog-api-key", "sk-test");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("models/gemini-pro");
  });

  it("returns 404 on unknown model", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: [{ id: "gemini-pro" }] })]
    });
    const res = await request(app)
      .get("/v1beta/models/totally-unknown")
      .set("x-goog-api-key", "sk-test");
    expect(res.status).toBe(404);
  });
});
