import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { BackendRegistry } from "../../../src/backends/registry.js";
import { createChatCompletionsHandler } from "../../../src/openaiShim/chatCompletions.js";
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

function stubBackend(opts: {
  id: BackendId;
  models?: string[];
  events?: NormalizedEvent[];
  recorded?: Recorded;
  throwOnInvoke?: Error;
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
  const events =
    opts.events ?? [
      { kind: "message_start", model: opts.models?.[0] ?? "test-model" },
      { kind: "text_delta", index: 0, text: "ok answer text here" },
      {
        kind: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 2 }
      }
    ];
  return {
    id: opts.id,
    capabilitiesFor: () => caps,
    listModels: async () =>
      (opts.models ?? ["test-model"]).map((id) => ({ id })),
    invoke: async function* (req: NormalizedRequest) {
      if (opts.recorded) opts.recorded.request = req;
      if (opts.throwOnInvoke) throw opts.throwOnInvoke;
      for (const e of events) yield e;
    },
    countTokens: async () => 1
  };
}

async function buildApp(opts: {
  apiKey: string;
  backends: Backend[];
  defaultBackend?: BackendId;
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
    "/v1/chat/completions",
    createChatCompletionsHandler({
      registry,
      config: {
        apiKey: opts.apiKey,
        router: { defaultBackend: opts.defaultBackend ?? "claude" }
      }
    })
  );
  return app;
}

describe("POST /v1/chat/completions — auth", () => {
  it("returns 401 with authentication_error envelope on missing key", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "claude" })]
    });
    const res = await request(app)
      .post("/v1/chat/completions")
      .send({ model: "claude-code-cli", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe("authentication_error");
  });

  it("accepts Authorization: Bearer", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "claude" })]
    });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({ model: "claude-code-cli", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
  });

  it("accepts x-api-key", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "claude" })]
    });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("x-api-key", "sk-test")
      .send({ model: "claude-code-cli", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/chat/completions — request validation", () => {
  it("returns 400 on missing messages", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "claude" })]
    });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({ model: "claude-code-cli" });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("invalid_request_error");
    expect(res.body.error.message).toMatch(/messages/i);
  });

  it("returns 400 on image_url content part (multimodal Non-goal)", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "claude" })]
    });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({
        model: "claude-code-cli",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image_url", image_url: { url: "data:image/png;base64,X" } }
            ]
          }
        ]
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/image_url|multimodal/i);
  });

  it("returns 400 on n > 1", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "claude" })]
    });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({ model: "claude-code-cli", n: 2, messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
  });

  it("returns 400 on response_format present", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "claude" })]
    });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({
        model: "claude-code-cli",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/chat/completions — routing", () => {
  it("returns 404 with not_found_error envelope on unknown model", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "claude", models: ["claude-sonnet-4-6"] })]
    });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({ model: "no-such-model", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(404);
    expect(res.body.error.type).toBe("not_found_error");
  });

  it("routes claude-* models to the Claude backend", async () => {
    const claude = stubBackend({ id: "claude", models: ["claude-opus-4-7"] });
    const app = await buildApp({ apiKey: "sk-test", backends: [claude] });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({ model: "claude-opus-4-7", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
  });

  it("routes gemini-* models to the Gemini backend", async () => {
    const gemini = stubBackend({ id: "gemini", models: ["gemini-pro"] });
    const app = await buildApp({ apiKey: "sk-test", backends: [gemini] });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({ model: "gemini-pro", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
  });

  it("routes a registered LM Studio model to the LM Studio backend", async () => {
    const lmstudio = stubBackend({
      id: "lmstudio",
      models: ["qwen3-coder-30b"]
    });
    const app = await buildApp({ apiKey: "sk-test", backends: [lmstudio] });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({ model: "qwen3-coder-30b", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
  });

  it("routes a registered Ollama model to the Ollama backend", async () => {
    const ollama = stubBackend({ id: "ollama", models: ["llama-3.3-70b"] });
    const app = await buildApp({ apiKey: "sk-test", backends: [ollama] });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({ model: "llama-3.3-70b", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
  });

  it("honors prefix-syntax override (lmstudio/qwen3-coder-30b)", async () => {
    const claude = stubBackend({ id: "claude", models: ["claude-sonnet-4-6"] });
    const recorded: Recorded = {};
    const lmstudio = stubBackend({
      id: "lmstudio",
      models: ["qwen3-coder-30b"],
      recorded
    });
    const app = await buildApp({ apiKey: "sk-test", backends: [claude, lmstudio] });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({
        model: "lmstudio/qwen3-coder-30b",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(200);
    expect(recorded.request?.model).toBe("qwen3-coder-30b");
  });

  it("model omitted or set to claude-code-cli falls back to defaultBackend", async () => {
    const claude = stubBackend({ id: "claude", models: ["claude-sonnet-4-6"] });
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [claude],
      defaultBackend: "claude"
    });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/chat/completions — non-streaming response", () => {
  it("returns OpenAI chat.completion body shape", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "claude", models: ["claude-sonnet-4-6"] })]
    });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: "chat.completion",
      model: "claude-sonnet-4-6",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: expect.stringContaining("ok answer")
          },
          finish_reason: "stop"
        }
      ]
    });
    expect(res.body.id).toMatch(/^chatcmpl-/);
    expect(typeof res.body.created).toBe("number");
  });

  it("populates usage from message_stop.usage", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "claude", models: ["claude-sonnet-4-6"] })]
    });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.body.usage).toEqual({
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3
    });
  });

  it("forwards the translated NormalizedRequest to the backend", async () => {
    const recorded: Recorded = {};
    const claude = stubBackend({
      id: "claude",
      models: ["claude-sonnet-4-6"],
      recorded
    });
    const app = await buildApp({ apiKey: "sk-test", backends: [claude] });
    await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hi" }
        ]
      });
    expect(recorded.request?.model).toBe("claude-sonnet-4-6");
    expect(recorded.request?.system).toContain("be brief");
    expect(recorded.request?.messages).toHaveLength(1);
    expect(recorded.request?.messages[0]?.role).toBe("user");
  });

  it("emits finish_reason 'tool_calls' when assistant response contains <tool_use>", async () => {
    const toolEvents: NormalizedEvent[] = [
      { kind: "message_start", model: "claude-sonnet-4-6" },
      {
        kind: "text_delta",
        index: 0,
        text: '<tool_use>{"name":"search","arguments":{"q":"x"}}</tool_use>'
      },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const claude = stubBackend({
      id: "claude",
      models: ["claude-sonnet-4-6"],
      events: toolEvents
    });
    const app = await buildApp({ apiKey: "sk-test", backends: [claude] });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.body.choices[0].finish_reason).toBe("tool_calls");
    expect(res.body.choices[0].message.tool_calls).toHaveLength(1);
    expect(res.body.choices[0].message.tool_calls[0].function.name).toBe(
      "search"
    );
    expect(res.body.choices[0].message.tool_calls[0].function.arguments).toBe(
      '{"q":"x"}'
    );
    expect(res.body.choices[0].message.content).toBeNull();
  });
});

describe("POST /v1/chat/completions — streaming response", () => {
  it("emits Content-Type: text/event-stream", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "claude", models: ["claude-sonnet-4-6"] })]
    });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({
        model: "claude-sonnet-4-6",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
  });

  it("ends with data: [DONE] terminator", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "claude", models: ["claude-sonnet-4-6"] })]
    });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({
        model: "claude-sonnet-4-6",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.text).toContain("data: [DONE]");
  });

  it("each non-DONE chunk is JSON-parseable after data: prefix strip", async () => {
    const app = await buildApp({
      apiKey: "sk-test",
      backends: [stubBackend({ id: "claude", models: ["claude-sonnet-4-6"] })]
    });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({
        model: "claude-sonnet-4-6",
        stream: true,
        messages: [{ role: "user", content: "hi" }]
      });
    const lines = res.text
      .split("\n\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("data: ") && !l.endsWith("[DONE]"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const json = JSON.parse(line.slice("data: ".length));
      expect(json.object).toBe("chat.completion.chunk");
      expect(json.id).toMatch(/^chatcmpl-/);
    }
  });
});

describe("POST /v1/chat/completions — backend errors", () => {
  it("returns 502 api_error when backend.invoke throws (non-streaming)", async () => {
    const claude = stubBackend({
      id: "claude",
      models: ["claude-sonnet-4-6"],
      throwOnInvoke: new Error("boom")
    });
    const app = await buildApp({ apiKey: "sk-test", backends: [claude] });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.status).toBe(502);
    expect(res.body.error.type).toBe("api_error");
    expect(res.body.error.message).toMatch(/boom|pipeline/i);
  });

  it("returns 502 phrasing matches the legacy 'Claude pipeline failed: ...' shape for back-compat", async () => {
    const claude = stubBackend({
      id: "claude",
      models: ["claude-sonnet-4-6"],
      throwOnInvoke: new Error("spawn ENOENT")
    });
    const app = await buildApp({ apiKey: "sk-test", backends: [claude] });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer sk-test")
      .send({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
    expect(res.body.error.message).toMatch(/pipeline failed/i);
  });
});
