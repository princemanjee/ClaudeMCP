import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackendRegistry } from "../../../src/backends/registry.js";
import { createCountTokensHandler } from "../../../src/geminiShim/countTokens.js";
import { FileStore } from "../../../src/fileStore.js";
import type {
  Backend,
  BackendCapabilities,
  BackendId,
  NormalizedRequest
} from "../../../src/backends/types.js";

let dir: string;
let store: FileStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudemcp-ct-"));
  store = new FileStore({
    dir,
    ttlMs: 60_000,
    maxTotalBytes: 1_000_000,
    sweepIntervalMs: 0
  });
});

afterEach(() => {
  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

function stubBackend(opts: {
  id: BackendId;
  models?: string[];
  countTokensReturn?: number;
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
    listModels: async () =>
      (opts.models ?? [`${opts.id}-default`]).map((id) => ({ id })),
    invoke: async function* (_req: NormalizedRequest) {
      // unused
    },
    countTokens: async () => opts.countTokensReturn ?? 1
  };
}

function buildApp(opts: {
  apiKey: string;
  backends: Backend[];
  defaultBackend?: BackendId;
}): express.Express {
  const registry = new BackendRegistry({
    claude: 100,
    gemini: 90,
    lmstudio: 50,
    ollama: 40
  });
  for (const b of opts.backends) registry.register(b);
  const handler = createCountTokensHandler({
    registry,
    fileStore: store,
    config: {
      apiKey: opts.apiKey,
      router: { defaultBackend: opts.defaultBackend ?? "gemini" }
    }
  });
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.post("/v1beta/models/:model\\:countTokens", handler);
  return app;
}

describe("Gemini /v1beta/models/:model:countTokens", () => {
  it("returns 401 on missing auth", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"], countTokensReturn: 42 })]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:countTokens")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(401);
    expect(res.body.error.status).toBe("UNAUTHENTICATED");
  });

  it("returns 400 on empty contents", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"] })]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:countTokens")
      .set("x-goog-api-key", "sk-test")
      .send({ contents: [] });
    expect(res.status).toBe(400);
  });

  it("returns 404 on unknown model", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"] })]
    });
    const res = await request(app)
      .post("/v1beta/models/totally-unknown-xyz:countTokens")
      .set("x-goog-api-key", "sk-test")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(404);
  });

  it("returns 200 with {totalTokens: <n>} shape", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"], countTokensReturn: 42 })]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:countTokens")
      .set("x-goog-api-key", "sk-test")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ totalTokens: 42 });
  });

  it("returns 400 on cachedContent", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"] })]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:countTokens")
      .set("x-goog-api-key", "sk-test")
      .send({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        cachedContent: "cache_abc"
      });
    expect(res.status).toBe(400);
  });

  it("dispatches cross-backend: claude model reaches claude stub", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend({ id: "gemini", models: ["gemini-pro"], countTokensReturn: 99 }),
        stubBackend({
          id: "claude",
          models: ["claude-opus-4-7"],
          countTokensReturn: 77
        })
      ]
    });
    const res = await request(app)
      .post("/v1beta/models/claude-opus-4-7:countTokens")
      .set("x-goog-api-key", "sk-test")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(200);
    expect(res.body.totalTokens).toBe(77);
  });

  // Google SDK's `model.countTokens(...)` wraps the request body as
  // `{generateContentRequest: {contents: [...]}}`. The shim must unwrap one
  // level so the bare `{contents}` translator path still applies.
  it("accepts Google SDK's {generateContentRequest: {contents}} envelope", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend({ id: "gemini", models: ["gemini-pro"], countTokensReturn: 17 })
      ]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:countTokens")
      .set("x-goog-api-key", "sk-test")
      .send({
        generateContentRequest: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }]
        }
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ totalTokens: 17 });
  });

  it("still accepts bare {contents} after envelope-unwrap fix", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend({ id: "gemini", models: ["gemini-pro"], countTokensReturn: 5 })
      ]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:countTokens")
      .set("x-goog-api-key", "sk-test")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ totalTokens: 5 });
  });
});
