import { describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import request from "supertest";
import { BackendRegistry } from "../../../src/backends/registry.js";
import { createEmbeddingsHandler } from "../../../src/openaiShim/embeddings.js";
import type {
  Backend,
  BackendCapabilities,
  BackendId,
  NormalizedEmbeddingRequest,
  NormalizedEmbeddingResponse
} from "../../../src/backends/types.js";

function stubBackend(opts: {
  id: BackendId;
  models?: string[];
  embeddings?: number[][];
  embed?: Backend["embed"];
  hasEmbed?: boolean;
}): Backend {
  const caps: BackendCapabilities = {
    toolUse: false,
    multimodal: false,
    thinking: false,
    cacheControl: "none",
    samplingParams: { temperature: false, topP: false, topK: false },
    stopSequences: "server-side-cut",
    embeddings: opts.hasEmbed ?? !!opts.embed ?? true
  };
  const b: Backend = {
    id: opts.id,
    capabilitiesFor: () => caps,
    listModels: async () =>
      (opts.models ?? ["embed-model-a"]).map((id) => ({ id })),
    invoke: async function* () {},
    countTokens: async () => 0
  };
  if (opts.hasEmbed !== false) {
    b.embed =
      opts.embed ??
      (async (
        req: NormalizedEmbeddingRequest
      ): Promise<NormalizedEmbeddingResponse> => ({
        model: req.model,
        embeddings: opts.embeddings ?? req.input.map(() => [0.1, 0.2, 0.3, 0.4])
      }));
  }
  return b;
}

async function buildApp(opts: {
  apiKey: string;
  backends: Backend[];
  defaultBackend?: BackendId;
  legacyBackendUrl?: string;
  legacyApiKey?: string;
  legacyTimeoutMs?: number;
}): Promise<express.Express> {
  const registry = new BackendRegistry({
    claude: 100,
    gemini: 90,
    lmstudio: 50,
    ollama: 40
  });
  for (const b of opts.backends) registry.register(b);
  await registry.probe();

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.post(
    "/v1/embeddings",
    createEmbeddingsHandler({
      registry,
      config: {
        apiKey: opts.apiKey,
        router: { defaultBackend: opts.defaultBackend ?? "claude" },
        embeddings: {
          legacyBackendUrl: opts.legacyBackendUrl ?? "",
          legacyApiKey: opts.legacyApiKey ?? "",
          legacyTimeoutMs: opts.legacyTimeoutMs ?? 30000
        }
      }
    })
  );
  return app;
}

describe("POST /v1/embeddings — auth", () => {
  it("returns 401 with authentication_error on missing key", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "lmstudio", models: ["nomic-embed-text"] })]
    });
    const res = await request(app)
      .post("/v1/embeddings")
      .send({ model: "nomic-embed-text", input: "hi" });
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/embeddings — request validation", () => {
  it("returns 400 on missing model", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "lmstudio", models: ["nomic-embed-text"] })]
    });
    const res = await request(app)
      .post("/v1/embeddings")
      .set("Authorization", "Bearer sk-test")
      .send({ input: "hi" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/model/i);
  });

  it("returns 400 on missing input", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "lmstudio", models: ["nomic-embed-text"] })]
    });
    const res = await request(app)
      .post("/v1/embeddings")
      .set("Authorization", "Bearer sk-test")
      .send({ model: "nomic-embed-text" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/input/i);
  });

  it("returns 400 on numeric input (token-id input not supported)", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "lmstudio", models: ["nomic-embed-text"] })]
    });
    const res = await request(app)
      .post("/v1/embeddings")
      .set("Authorization", "Bearer sk-test")
      .send({ model: "nomic-embed-text", input: [1, 2, 3] });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/embeddings — routing", () => {
  it("routes by model id to the embed-capable backend", async () => {
    const lmstudio = stubBackend({ id: "lmstudio", models: ["nomic-embed-text"] });
    const app = await buildApp({ apiKey: "sk-test", backends: [lmstudio] });
    const res = await request(app)
      .post("/v1/embeddings")
      .set("Authorization", "Bearer sk-test")
      .send({ model: "nomic-embed-text", input: "hello" });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      object: "embedding",
      embedding: expect.any(Array),
      index: 0
    });
    expect(res.body.model).toBe("nomic-embed-text");
  });

  it("returns 404 not_found_error on unknown model", async () => {
    const lmstudio = stubBackend({ id: "lmstudio", models: ["nomic-embed-text"] });
    const app = await buildApp({ apiKey: "sk-test", backends: [lmstudio] });
    const res = await request(app)
      .post("/v1/embeddings")
      .set("Authorization", "Bearer sk-test")
      .send({ model: "no-such-embed", input: "hi" });
    expect(res.status).toBe(404);
    expect(res.body.error.type).toBe("not_found_error");
  });

  it("returns 400 'model does not support embeddings' when resolved backend has no embed()", async () => {
    const claude = stubBackend({
      id: "claude",
      models: ["claude-sonnet-4-6"],
      hasEmbed: false
    });
    const app = await buildApp({ apiKey: "sk-test", backends: [claude] });
    const res = await request(app)
      .post("/v1/embeddings")
      .set("Authorization", "Bearer sk-test")
      .send({ model: "claude-sonnet-4-6", input: "hi" });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("invalid_request_error");
    expect(res.body.error.message).toMatch(/does not support embeddings/i);
  });

  it("honors lmstudio/ prefix override", async () => {
    const lmstudio = stubBackend({ id: "lmstudio", models: ["nomic-embed-text"] });
    const app = await buildApp({ apiKey: "sk-test", backends: [lmstudio] });
    const res = await request(app)
      .post("/v1/embeddings")
      .set("Authorization", "Bearer sk-test")
      .send({ model: "lmstudio/nomic-embed-text", input: "hi" });
    expect(res.status).toBe(200);
  });

  it("accepts input as a string array", async () => {
    const lmstudio = stubBackend({
      id: "lmstudio",
      models: ["nomic-embed-text"],
      embeddings: [
        [0.1, 0.2, 0.3, 0.4],
        [0.5, 0.6, 0.7, 0.8]
      ]
    });
    const app = await buildApp({ apiKey: "sk-test", backends: [lmstudio] });
    const res = await request(app)
      .post("/v1/embeddings")
      .set("Authorization", "Bearer sk-test")
      .send({ model: "nomic-embed-text", input: ["a", "b"] });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].index).toBe(0);
    expect(res.body.data[1].index).toBe(1);
    expect(res.body.data[0].embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(res.body.data[1].embedding).toEqual([0.5, 0.6, 0.7, 0.8]);
  });
});

describe("POST /v1/embeddings — encoding_format base64", () => {
  it("returns base64-encoded float32 strings when encoding_format: 'base64'", async () => {
    const lmstudio = stubBackend({
      id: "lmstudio",
      models: ["nomic-embed-text"],
      embeddings: [[1.0, 2.0]]
    });
    const app = await buildApp({ apiKey: "sk-test", backends: [lmstudio] });
    const res = await request(app)
      .post("/v1/embeddings")
      .set("Authorization", "Bearer sk-test")
      .send({
        model: "nomic-embed-text",
        input: "hi",
        encoding_format: "base64"
      });
    expect(res.status).toBe(200);
    expect(typeof res.body.data[0].embedding).toBe("string");
    const buf = Buffer.from(res.body.data[0].embedding as string, "base64");
    expect(buf.length).toBe(2 * 4); // 2 float32s = 8 bytes
    expect(buf.readFloatLE(0)).toBeCloseTo(1.0);
    expect(buf.readFloatLE(4)).toBeCloseTo(2.0);
  });
});

describe("POST /v1/embeddings — backend errors", () => {
  it("returns 502 api_error when embed throws", async () => {
    const lmstudio = stubBackend({
      id: "lmstudio",
      models: ["nomic-embed-text"],
      embed: async () => {
        throw new Error("LM Studio returned 500");
      }
    });
    const app = await buildApp({ apiKey: "sk-test", backends: [lmstudio] });
    const res = await request(app)
      .post("/v1/embeddings")
      .set("Authorization", "Bearer sk-test")
      .send({ model: "nomic-embed-text", input: "hi" });
    expect(res.status).toBe(502);
    expect(res.body.error.type).toBe("api_error");
  });
});

describe("POST /v1/embeddings — legacyBackendUrl bypass", () => {
  it("HTTP-proxies to legacyBackendUrl when set, bypassing registry", async () => {
    const captured: { body?: unknown; authHeader?: string; path?: string } = {};
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        captured.body = JSON.parse(body);
        captured.authHeader = req.headers.authorization;
        captured.path = req.url;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", embedding: [0.9, 0.8], index: 0 }],
            model: "from-legacy-proxy"
          })
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve())
    );
    const port = (server.address() as { port: number }).port;
    try {
      const app = await buildApp({
        apiKey: "sk-test",
        backends: [
          stubBackend({
            id: "claude",
            models: ["claude-sonnet-4-6"],
            hasEmbed: false
          })
        ],
        legacyBackendUrl: `http://127.0.0.1:${port}`,
        legacyApiKey: "sk-legacy"
      });
      const res = await request(app)
        .post("/v1/embeddings")
        .set("Authorization", "Bearer sk-test")
        .send({ model: "anything-the-proxy-handles", input: "hi" });
      expect(res.status).toBe(200);
      expect(res.body.model).toBe("from-legacy-proxy");
      expect(captured.path).toBe("/v1/embeddings");
      expect(captured.body).toMatchObject({
        model: "anything-the-proxy-handles",
        input: "hi"
      });
      expect(captured.authHeader).toBe("Bearer sk-legacy");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns the upstream status code verbatim when legacy proxy responds with non-2xx", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: "upstream broke" } }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve())
    );
    const port = (server.address() as { port: number }).port;
    try {
      const app = await buildApp({
        apiKey: "sk-test",
        backends: [],
        legacyBackendUrl: `http://127.0.0.1:${port}`
      });
      const res = await request(app)
        .post("/v1/embeddings")
        .set("Authorization", "Bearer sk-test")
        .send({ model: "any", input: "hi" });
      expect(res.status).toBe(500);
      expect(res.body.error?.message).toBe("upstream broke");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
