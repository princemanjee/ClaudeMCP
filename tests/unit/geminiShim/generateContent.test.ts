import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackendRegistry } from "../../../src/backends/registry.js";
import { createGenerateContentHandlers } from "../../../src/geminiShim/generateContent.js";
import { FileStore } from "../../../src/fileStore.js";
import type {
  Backend,
  BackendCapabilities,
  BackendId,
  NormalizedEvent,
  NormalizedRequest
} from "../../../src/backends/types.js";

interface Recorded {
  request?: NormalizedRequest;
}

let dir: string;
let store: FileStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudemcp-gen-"));
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
  events?: NormalizedEvent[];
  countTokensReturn?: number;
  recorded?: Recorded;
  shouldThrow?: boolean;
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
  const defaultEvents: NormalizedEvent[] = [
    { kind: "message_start", model: opts.models?.[0] ?? "test-model" },
    { kind: "text_delta", index: 0, text: `hello from ${opts.id}` },
    {
      kind: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 4 }
    }
  ];
  const events = opts.events ?? defaultEvents;
  return {
    id: opts.id,
    capabilitiesFor: () => caps,
    listModels: async () =>
      (opts.models ?? [`${opts.id}-default`]).map((id) => ({ id })),
    invoke: async function* (req: NormalizedRequest) {
      if (opts.recorded) opts.recorded.request = req;
      if (opts.shouldThrow) throw new Error("stub backend crashed");
      for (const e of events) yield e;
    },
    countTokens: async () => opts.countTokensReturn ?? 1
  };
}

function buildApp(opts: {
  apiKey: string;
  backends: Backend[];
  defaultBackend?: BackendId;
  streaming?: boolean;
}): express.Express {
  const registry = new BackendRegistry({
    claude: 100,
    gemini: 90,
    lmstudio: 50,
    ollama: 40
  });
  for (const b of opts.backends) registry.register(b);
  const handlers = createGenerateContentHandlers({
    registry,
    fileStore: store,
    config: {
      apiKey: opts.apiKey,
      router: { defaultBackend: opts.defaultBackend ?? "gemini" }
    }
  });
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.post("/v1beta/models/:model\\:generateContent", handlers.generate);
  app.post(
    "/v1beta/models/:model\\:streamGenerateContent",
    handlers.streamGenerate
  );
  return app;
}

describe("Gemini /v1beta/models/:model:generateContent — auth", () => {
  it("returns 401 with UNAUTHENTICATED envelope on missing key", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"] })]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:generateContent")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(401);
    expect(res.body.error.status).toBe("UNAUTHENTICATED");
  });

  it("returns 401 with wrong key", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"] })]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:generateContent")
      .set("x-goog-api-key", "wrong")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(401);
  });

  it("accepts x-goog-api-key header", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"] })]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:generateContent")
      .set("x-goog-api-key", "sk-test")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(200);
  });

  it("accepts ?key= query param", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"] })]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:generateContent?key=sk-test")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(200);
  });
});

describe("Gemini /v1beta/models/:model:generateContent — validation", () => {
  it("returns 400 INVALID_ARGUMENT on empty contents", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"] })]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:generateContent")
      .set("x-goog-api-key", "sk-test")
      .send({ contents: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.status).toBe("INVALID_ARGUMENT");
  });

  it("returns 400 on cachedContent", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"] })]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:generateContent")
      .set("x-goog-api-key", "sk-test")
      .send({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        cachedContent: "cache_abc"
      });
    expect(res.status).toBe(400);
  });

  it("returns 400 on responseMimeType: application/json", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"] })]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:generateContent")
      .set("x-goog-api-key", "sk-test")
      .send({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { responseMimeType: "application/json" }
      });
    expect(res.status).toBe(400);
  });

  it("returns 400 on candidateCount > 1", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"] })]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:generateContent")
      .set("x-goog-api-key", "sk-test")
      .send({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { candidateCount: 5 }
      });
    expect(res.status).toBe(400);
  });
});

describe("Gemini /v1beta/models/:model:generateContent — routing", () => {
  it("returns 404 NOT_FOUND on unknown model", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"] })]
    });
    const res = await request(app)
      .post("/v1beta/models/totally-unknown-xyz:generateContent")
      .set("x-goog-api-key", "sk-test")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(404);
    expect(res.body.error.status).toBe("NOT_FOUND");
  });

  it("routes gemini-pro to the gemini stub", async () => {
    const recorded: Recorded = {};
    const app = buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend({
          id: "gemini",
          models: ["gemini-pro"],
          recorded,
          events: [
            { kind: "message_start", model: "gemini-pro" },
            { kind: "text_delta", index: 0, text: "g-resp" },
            { kind: "message_stop", stopReason: "end_turn" }
          ]
        }),
        stubBackend({
          id: "claude",
          models: ["claude-opus-4-7"]
        })
      ]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:generateContent")
      .set("x-goog-api-key", "sk-test")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(200);
    expect(res.body.candidates[0].content.parts[0].text).toBe("g-resp");
    expect(recorded.request?.model).toBe("gemini-pro");
  });

  it("routes claude-opus-4-7 to the claude stub (cross-shim dispatch)", async () => {
    const recorded: Recorded = {};
    const app = buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend({
          id: "gemini",
          models: ["gemini-pro"]
        }),
        stubBackend({
          id: "claude",
          models: ["claude-opus-4-7"],
          recorded,
          events: [
            { kind: "message_start", model: "claude-opus-4-7" },
            { kind: "text_delta", index: 0, text: "c-resp" },
            { kind: "message_stop", stopReason: "end_turn" }
          ]
        })
      ]
    });
    const res = await request(app)
      .post("/v1beta/models/claude-opus-4-7:generateContent")
      .set("x-goog-api-key", "sk-test")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(200);
    expect(res.body.candidates[0].content.parts[0].text).toBe("c-resp");
    expect(recorded.request?.model).toBe("claude-opus-4-7");
  });
});

describe("Gemini /v1beta/models/:model:generateContent — non-streaming response", () => {
  it("returns Gemini-shaped body with finishReason STOP and safetyRatings []", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"] })]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:generateContent")
      .set("x-goog-api-key", "sk-test")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.candidates[0].content.parts).toBeDefined();
    expect(res.body.candidates[0].finishReason).toBe("STOP");
    expect(res.body.candidates[0].safetyRatings).toEqual([]);
    expect(res.body.usageMetadata).toBeDefined();
  });

  it("forwards the translated NormalizedRequest to the backend", async () => {
    const recorded: Recorded = {};
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"], recorded })]
    });
    await request(app)
      .post("/v1beta/models/gemini-pro:generateContent")
      .set("x-goog-api-key", "sk-test")
      .send({
        contents: [{ role: "user", parts: [{ text: "hello world" }] }],
        generationConfig: { temperature: 0.5 }
      });
    expect(recorded.request).toBeDefined();
    expect(recorded.request?.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "hello world"
    });
    expect(recorded.request?.samplingParams?.temperature).toBe(0.5);
  });

  it("modelVersion field reflects the URL-path model id", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"] })]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:generateContent")
      .set("x-goog-api-key", "sk-test")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.body.modelVersion).toBe("gemini-pro");
  });
});

describe("Gemini /v1beta/models/:model:streamGenerateContent — streaming response", () => {
  it("emits Content-Type: text/event-stream", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"] })]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:streamGenerateContent")
      .set("x-goog-api-key", "sk-test")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
  });

  it("emits data: <JSON>\\n\\n chunks with final finishReason STOP", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "gemini", models: ["gemini-pro"] })]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:streamGenerateContent")
      .set("x-goog-api-key", "sk-test")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(200);
    const text = res.text as string;
    expect(text).toContain("data: ");
    // Parse chunks and find the last one — should have finishReason: STOP.
    const chunks = text
      .split("\n\n")
      .filter((c) => c.startsWith("data: "))
      .map((c) => JSON.parse(c.replace(/^data:\s*/, "")));
    const last = chunks[chunks.length - 1];
    expect(last.candidates[0].finishReason).toBe("STOP");
  });
});

describe("Gemini /v1beta/models/:model:generateContent — backend errors", () => {
  it("returns 500 INTERNAL on backend exception", async () => {
    const app = buildApp({
      apiKey: "sk-test",
      backends: [
        stubBackend({
          id: "gemini",
          models: ["gemini-pro"],
          shouldThrow: true
        })
      ]
    });
    const res = await request(app)
      .post("/v1beta/models/gemini-pro:generateContent")
      .set("x-goog-api-key", "sk-test")
      .send({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    expect(res.status).toBe(500);
    expect(res.body.error.status).toBe("INTERNAL");
  });
});
