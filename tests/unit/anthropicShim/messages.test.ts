import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackendRegistry } from "../../../src/backends/registry.js";
import { createMessagesHandler } from "../../../src/anthropicShim/messages.js";
import { Archive } from "../../../src/archive.js";
import { ResponseCache } from "../../../src/responseCache.js";
import type {
  Backend,
  BackendCapabilities,
  NormalizedEvent,
  NormalizedRequest
} from "../../../src/backends/types.js";

interface TestHarness {
  archive: Archive;
  cache: ResponseCache;
  cleanup: () => void;
}

const liveHarnesses: TestHarness[] = [];

function makeHarness(): TestHarness {
  const dir = mkdtempSync(join(tmpdir(), "claudemcp-msg-h-"));
  const archive = new Archive(join(dir, "archive.sqlite"));
  const cache = new ResponseCache({
    file: join(dir, "cache.json"),
    ttlMs: 60_000,
    maxEntries: 100
  });
  const h: TestHarness = {
    archive,
    cache,
    cleanup: () => {
      try {
        archive.close();
      } catch {
        // ignore double-close
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
  liveHarnesses.push(h);
  return h;
}

afterEach(() => {
  while (liveHarnesses.length > 0) {
    const h = liveHarnesses.pop();
    h?.cleanup();
  }
});

interface Recorded {
  request?: NormalizedRequest;
}

function stubClaude(opts: {
  models?: string[];
  events?: NormalizedEvent[];
  countTokensReturn?: number;
  recorded?: Recorded;
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
  const events = opts.events ?? [
    { kind: "message_start", model: "claude-sonnet-4-6" },
    { kind: "text_delta", index: 0, text: "ok" },
    {
      kind: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 }
    }
  ];
  return {
    id: "claude",
    capabilitiesFor: () => caps,
    listModels: async () => (opts.models ?? ["claude-sonnet-4-6"]).map((id) => ({ id })),
    invoke: async function* (req: NormalizedRequest) {
      if (opts.recorded) opts.recorded.request = req;
      for (const e of events) yield e;
    },
    countTokens: async () => opts.countTokensReturn ?? 1
  };
}

function buildApp(opts: {
  apiKey: string;
  backend: Backend;
  defaultBackend?: "claude" | "gemini" | "lmstudio" | "ollama";
  harness?: TestHarness;
}): express.Express {
  const harness = opts.harness ?? makeHarness();
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
    "/v1/messages",
    createMessagesHandler({
      registry,
      archive: harness.archive,
      responseCache: harness.cache,
      config: {
        apiKey: opts.apiKey,
        router: { defaultBackend: opts.defaultBackend ?? "claude" }
      }
    })
  );
  return app;
}

describe("POST /v1/messages — auth", () => {
  it("returns 401 with Anthropic-shaped envelope on missing key", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      type: "error",
      error: { type: "authentication_error", message: expect.any(String) }
    });
  });

  it("returns 401 with Anthropic-shaped envelope on wrong key", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "wrong")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(401);
  });

  it("accepts x-api-key header", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(200);
  });

  it("accepts Authorization: Bearer", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("Authorization", "Bearer sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/messages — request validation", () => {
  it("returns 400 with invalid_request_error envelope on missing model", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: expect.stringMatching(/model/i) }
    });
  });

  it("accepts image content blocks (Plan 04 scope: passthrough to backend)", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "X" } }
            ]
          }
        ]
      });
    expect(res.status).toBe(200);
  });

  it("accepts non-empty tools array (Plan 04 scope: passthrough to backend)", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "calc", input_schema: {} }]
      });
    expect(res.status).toBe(200);
  });

  it("accepts non-empty stop_sequences (Plan 04 scope: passthrough to backend)", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        stop_sequences: ["STOP"]
      });
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/messages — routing", () => {
  it("returns 404 with not_found_error envelope on unknown model", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "qwen3-coder-30b",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(404);
    expect(res.body.error.type).toBe("not_found_error");
  });

  it("routes claude-* models to the Claude backend even without probe", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/messages — non-streaming response", () => {
  it("returns the Anthropic non-streaming body shape", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }
    });
    expect(res.body.id).toMatch(/^msg_/);
  });

  it("forwards the translated NormalizedRequest to the backend", async () => {
    const recorded: Recorded = {};
    const app = buildApp({
      apiKey: "sk-test",
      backend: stubClaude({ recorded })
    });
    await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        system: "be brief",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(recorded.request).toEqual({
      model: "claude-sonnet-4-6",
      system: "be brief",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] }
      ]
    });
  });
});

describe("POST /v1/messages — streaming response", () => {
  it("emits Content-Type: text/event-stream", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
  });

  it("emits the documented Anthropic event sequence", async () => {
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}) });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      });
    const text = res.text;
    const eventNames = text
      .split("\n\n")
      .filter((b) => b.length > 0)
      .map((b) => {
        const first = b.split("\n")[0] ?? "";
        return first.replace(/^event:\s*/, "");
      });
    expect(eventNames).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop"
    ]);
  });
});

describe("POST /v1/messages — backend errors", () => {
  it("surfaces backend.invoke throws as 500 with api_error envelope", async () => {
    const failing: Backend = {
      id: "claude",
      capabilitiesFor: () => ({
        toolUse: false,
        multimodal: false,
        thinking: false,
        cacheControl: "none",
        samplingParams: { temperature: false, topP: false, topK: false },
        stopSequences: "server-side-cut",
        embeddings: false
      }),
      listModels: async () => [{ id: "claude-sonnet-4-6" }],
      invoke: async function* (): AsyncIterable<NormalizedEvent> {
        throw new Error("backend boom");
      },
      countTokens: async () => 0
    };
    const app = buildApp({ apiKey: "sk-test", backend: failing });
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      type: "error",
      error: { type: "api_error", message: expect.stringContaining("backend boom") }
    });
  });
});

async function flushFireAndForget(): Promise<void> {
  // Give the setImmediate-scheduled archive write multiple ticks to complete.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 10));
}

describe("POST /v1/messages — response cache", () => {
  it("on hit, skips backend invocation and returns cached body", async () => {
    let invocations = 0;
    const base = stubClaude({
      events: [
        { kind: "message_start", model: "claude-sonnet-4-6" },
        { kind: "text_delta", index: 0, text: "first-call" },
        {
          kind: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 }
        }
      ]
    });
    const wrapped: Backend = {
      ...base,
      invoke: async function* (req: NormalizedRequest) {
        invocations++;
        for await (const ev of base.invoke(req)) yield ev;
      }
    };
    const app = buildApp({ apiKey: "sk-test", backend: wrapped });

    const body = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: "cache me",
              cache_control: { type: "ephemeral" }
            }
          ]
        }
      ]
    };

    const first = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send(body);
    expect(first.status).toBe(200);
    await flushFireAndForget();

    const second = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send(body);
    expect(second.status).toBe(200);

    expect(invocations).toBe(1); // Second call hit the cache.
    expect(second.body.content).toEqual([{ type: "text", text: "first-call" }]);
  });
});

describe("POST /v1/messages — archive write", () => {
  it("writes an entry per request, including the resolved backend tag", async () => {
    const harness = makeHarness();
    const app = buildApp({ apiKey: "sk-test", backend: stubClaude({}), harness });

    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "log me" }]
      });
    expect(res.status).toBe(200);
    await flushFireAndForget();

    const page = harness.archive.list({ limit: 10, offset: 0 });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.backend).toBe("claude");
    expect(page.data[0]?.endpoint).toBe("/v1/messages");
  });

  it("archives error entries when the backend throws", async () => {
    const failing: Backend = {
      id: "claude",
      capabilitiesFor: () => ({
        toolUse: false,
        multimodal: false,
        thinking: false,
        cacheControl: "none",
        samplingParams: { temperature: false, topP: false, topK: false },
        stopSequences: "server-side-cut",
        embeddings: false
      }),
      listModels: async () => [{ id: "claude-sonnet-4-6" }],
      invoke: async function* (): AsyncIterable<NormalizedEvent> {
        throw new Error("backend boom");
      },
      countTokens: async () => 0
    };
    const harness = makeHarness();
    const app = buildApp({ apiKey: "sk-test", backend: failing, harness });

    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", "sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "fail me" }]
      });
    expect(res.status).toBe(500);
    await flushFireAndForget();

    const page = harness.archive.list({ limit: 10, offset: 0 });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.status).toBe("error");
  });
});
