import express, { type Express } from "express";
import type { AddressInfo, Server } from "node:net";

export interface MockLmStudioOptions {
  /** Model ids this instance reports from GET /v1/models. */
  models?: string[];
  /** Latency injected before every response, ms. Use to force timeouts. */
  latencyMs?: number;
  /** When true, /v1/chat/completions returns 500 instead of normal output. */
  failChat?: boolean;
  /** When true, /v1/embeddings returns 500 instead of normal output. */
  failEmbeddings?: boolean;
  /** Authorization bearer the mock requires. Empty/undef accepts any. */
  requiredBearer?: string;
}

export interface MockLmStudioHandle {
  port: number;
  url: string;
  app: Express;
  close: () => Promise<void>;
}

/**
 * Boot an in-process Express server mimicking LM Studio's OpenAI-compatible
 * surface. Listens on port 0 (OS-assigned); the returned handle's `port` and
 * `url` are the bound values. Reset between tests by `await handle.close()`.
 *
 * Behavioral triggers (substring match on the request body's first user
 * message's `content` for chat completions, or on first input for embeddings):
 *   "MOCK_ERROR"         — 500 with `{error: {...}}`
 *   "MOCK_INVALID_JSON"  — 200 with a body that isn't valid JSON
 *   "MOCK_HANG"          — never responds (use with client-side timeout to test cancel)
 *   anything else        — normal echo
 */
export function startMockLmStudio(
  opts: MockLmStudioOptions = {}
): Promise<MockLmStudioHandle> {
  const models = opts.models ?? ["mock-chat-model", "mock-embed-model"];
  const latencyMs = opts.latencyMs ?? 0;

  const app = express();
  app.use(express.json({ limit: "8mb" }));

  // Bearer enforcement
  app.use((req, res, next) => {
    if (opts.requiredBearer) {
      const auth = req.header("authorization") ?? "";
      if (auth !== `Bearer ${opts.requiredBearer}`) {
        res.status(401).json({ error: { message: "invalid bearer", type: "auth_error" } });
        return;
      }
    }
    next();
  });

  async function delay(): Promise<void> {
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
  }

  // GET /v1/models
  app.get("/v1/models", async (_req, res) => {
    await delay();
    res.json({
      object: "list",
      data: models.map((id) => ({
        id,
        object: "model",
        owned_by: "lmstudio-mock",
        // Extra fields LM Studio may include — the backend ignores them.
        loaded: true,
        architecture: "mock"
      }))
    });
  });

  // POST /v1/chat/completions
  app.post("/v1/chat/completions", async (req, res) => {
    await delay();

    if (opts.failChat) {
      res.status(500).json({
        error: { message: "mock chat failure", type: "server_error" }
      });
      return;
    }

    const body = req.body as {
      model?: string;
      messages?: Array<{ role: string; content: string | unknown }>;
      stream?: boolean;
      tools?: unknown;
    };
    const firstContent =
      typeof body.messages?.[0]?.content === "string"
        ? body.messages[0].content
        : "";

    if (firstContent.includes("MOCK_ERROR")) {
      res.status(500).json({
        error: { message: "mock chat error trigger", type: "server_error" }
      });
      return;
    }

    if (firstContent.includes("MOCK_HANG")) {
      // Intentionally do not respond; close handler will release on shutdown.
      return;
    }

    const replyText = `echo: ${firstContent}`;
    const modelId = body.model ?? "mock-chat-model";

    // Tool-use trigger: if request includes a tools[] array and the message
    // contains "MOCK_TOOL_USE", emit a tool_call instead of plain text.
    const wantsToolUse =
      Array.isArray(body.tools) &&
      body.tools.length > 0 &&
      firstContent.includes("MOCK_TOOL_USE");

    if (body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const write = (obj: unknown): void => {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };

      // First chunk: role assignment (OpenAI-spec convention).
      write({
        id: "chatcmpl-mock-1",
        object: "chat.completion.chunk",
        model: modelId,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
      });

      if (wantsToolUse) {
        // Single tool call split across two delta chunks to exercise partial-json
        // accumulation in the backend's adapter.
        write({
          id: "chatcmpl-mock-1",
          object: "chat.completion.chunk",
          model: modelId,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_mock_1",
                    type: "function",
                    function: { name: "mock_tool", arguments: '{"a":' }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        });
        write({
          id: "chatcmpl-mock-1",
          object: "chat.completion.chunk",
          model: modelId,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: "1}" } }
                ]
              },
              finish_reason: null
            }
          ]
        });
        write({
          id: "chatcmpl-mock-1",
          object: "chat.completion.chunk",
          model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
        });
      } else {
        // Stream the reply text in ~6-char chunks to make ordering visible.
        const chunks = replyText.match(/.{1,6}/g) ?? [replyText];
        for (const c of chunks) {
          write({
            id: "chatcmpl-mock-1",
            object: "chat.completion.chunk",
            model: modelId,
            choices: [{ index: 0, delta: { content: c }, finish_reason: null }]
          });
        }
        write({
          id: "chatcmpl-mock-1",
          object: "chat.completion.chunk",
          model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: Math.ceil(firstContent.length / 4),
            completion_tokens: Math.ceil(replyText.length / 4),
            total_tokens:
              Math.ceil(firstContent.length / 4) + Math.ceil(replyText.length / 4)
          }
        });
      }

      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // Non-streaming (buffered) response.
    if (wantsToolUse) {
      res.json({
        id: "chatcmpl-mock-1",
        object: "chat.completion",
        model: modelId,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_mock_1",
                  type: "function",
                  function: { name: "mock_tool", arguments: '{"a":1}' }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
      });
      return;
    }

    res.json({
      id: "chatcmpl-mock-1",
      object: "chat.completion",
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: replyText },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: Math.ceil(firstContent.length / 4),
        completion_tokens: Math.ceil(replyText.length / 4),
        total_tokens:
          Math.ceil(firstContent.length / 4) + Math.ceil(replyText.length / 4)
      }
    });
  });

  // POST /v1/embeddings
  app.post("/v1/embeddings", async (req, res) => {
    await delay();
    if (opts.failEmbeddings) {
      res.status(500).json({
        error: { message: "mock embedding failure", type: "server_error" }
      });
      return;
    }
    const body = req.body as { model?: string; input?: string | string[] };
    const inputs = Array.isArray(body.input)
      ? body.input
      : typeof body.input === "string"
        ? [body.input]
        : [];
    if (inputs[0]?.includes("MOCK_ERROR")) {
      res.status(500).json({
        error: { message: "mock embedding error trigger", type: "server_error" }
      });
      return;
    }
    // Deterministic 4-d vector keyed off input length.
    res.json({
      object: "list",
      model: body.model ?? "mock-embed-model",
      data: inputs.map((s, i) => ({
        object: "embedding",
        index: i,
        embedding: [s.length / 10, 0.1, 0.2, 0.3]
      })),
      usage: {
        prompt_tokens: inputs.reduce((n, s) => n + Math.ceil(s.length / 4), 0),
        total_tokens: inputs.reduce((n, s) => n + Math.ceil(s.length / 4), 0)
      }
    });
  });

  return new Promise<MockLmStudioHandle>((resolve, reject) => {
    const server: Server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;
      const url = `http://127.0.0.1:${port}/v1`;
      const close = (): Promise<void> =>
        new Promise<void>((res2, rej2) => {
          server.close((err) => (err ? rej2(err) : res2()));
        });
      resolve({ port, url, app, close });
    });
    server.once("error", reject);
  });
}
