import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { BackendRegistry } from "../../../src/backends/registry.js";
import { createCountTokensHandler } from "../../../src/anthropicShim/countTokens.js";
import type {
  Backend,
  BackendCapabilities,
  NormalizedEvent,
  NormalizedRequest
} from "../../../src/backends/types.js";

function stubBackend(opts: {
  countTokensReturn: number;
  models?: string[];
}): Backend {
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
    id: "claude",
    capabilitiesFor: () => caps,
    listModels: async () => (opts.models ?? ["claude-sonnet-4-6"]).map((id) => ({ id })),
    invoke: async function* (): AsyncIterable<NormalizedEvent> {
      // unused in this endpoint
    },
    countTokens: async (_req: NormalizedRequest) => opts.countTokensReturn
  };
}

function buildApp(opts: { apiKey: string; backend: Backend }): express.Express {
  const registry = new BackendRegistry({
    claude: 100,
    gemini: 90,
    lmstudio: 50,
    ollama: 40
  });
  registry.register(opts.backend);
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.post(
    "/v1/messages/count_tokens",
    createCountTokensHandler({
      registry,
      config: {
        apiKey: opts.apiKey,
        router: { defaultBackend: "claude" }
      }
    })
  );
  return app;
}

describe("POST /v1/messages/count_tokens", () => {
  it("returns 401 on missing auth", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubBackend({ countTokensReturn: 5 }) });
    const res = await request(app)
      .post("/v1/messages/count_tokens")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(401);
  });

  it("returns 400 on missing model", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubBackend({ countTokensReturn: 5 }) });
    const res = await request(app)
      .post("/v1/messages/count_tokens")
      .set("x-api-key", "sk-test")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
  });

  it("returns 404 on unknown model", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubBackend({ countTokensReturn: 5 }) });
    const res = await request(app)
      .post("/v1/messages/count_tokens")
      .set("x-api-key", "sk-test")
      .send({
        model: "qwen3-coder-30b",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(404);
  });

  it("delegates to backend.countTokens and returns Anthropic-shaped {input_tokens}", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backend: stubBackend({ countTokensReturn: 42 })
    });
    const res = await request(app)
      .post("/v1/messages/count_tokens")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hello world" }]
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ input_tokens: 42 });
  });

  it("rejects out-of-scope content (e.g. image) with 400", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backend: stubBackend({ countTokensReturn: 1 })
    });
    const res = await request(app)
      .post("/v1/messages/count_tokens")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "X" } }
            ]
          }
        ]
      });
    expect(res.status).toBe(400);
  });
});
