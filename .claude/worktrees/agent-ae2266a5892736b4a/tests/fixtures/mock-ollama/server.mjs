#!/usr/bin/env node
// Hermetic mock of an Ollama server. Serves BOTH the native /api/* surface
// and the OpenAI-compatibility /v1/* surface so a single fixture process
// can stand in for either mode used by Plan 09's OllamaBackend.
//
// Bound on port 0 (kernel-assigned). On listen, prints
//   LISTENING_ON_PORT <n>
// on stdout so the spawning test can parse the assigned port.
//
// Triggers (keyed off the last user message's content):
//   "MOCK_ERROR"        → 500 with {"error": "mock error"}
//   "MOCK_TOOL_CALL"    → response contains a tool_calls block (echo tool)
//   "MOCK_LONG_STREAM"  → 20 short text chunks
//   (anything else)     → 2-3 normal text chunks echoing the prompt

import { createServer } from "node:http";

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  let bodyChunks = [];
  for await (const c of req) bodyChunks.push(c);
  const rawBody = Buffer.concat(bodyChunks).toString("utf8");
  let body = {};
  if (rawBody.length > 0) {
    try { body = JSON.parse(rawBody); } catch { body = {}; }
  }

  // ---- /api/tags (native model list) -----------------------------------
  if (req.method === "GET" && url.pathname === "/api/tags") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      models: [
        {
          name: "llama-3.3-70b",
          modified_at: "2026-04-01T00:00:00Z",
          size: 40_000_000_000,
          digest: "deadbeef",
          details: {
            format: "gguf",
            family: "llama",
            families: ["llama"],
            parameter_size: "70B",
            quantization_level: "Q4_K_M"
          }
        },
        {
          name: "nomic-embed-text",
          modified_at: "2026-04-01T00:00:00Z",
          size: 274_000_000,
          digest: "cafebabe",
          details: {
            format: "gguf",
            family: "nomic",
            families: ["nomic"],
            parameter_size: "137M",
            quantization_level: "F16"
          }
        }
      ]
    }));
    return;
  }

  // ---- /v1/models (OpenAI-compat model list) ---------------------------
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [
        { id: "llama-3.3-70b", object: "model", owned_by: "ollama" },
        { id: "nomic-embed-text", object: "model", owned_by: "ollama" }
      ]
    }));
    return;
  }

  // ---- /api/embed (native modern embeddings) ---------------------------
  if (req.method === "POST" && url.pathname === "/api/embed") {
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      model: body.model ?? "nomic-embed-text",
      embeddings: inputs.map((s) => Array.from({ length: 8 }, (_, i) => (s.length + i) / 100)),
      total_duration: 1000,
      load_duration: 100,
      prompt_eval_count: inputs.reduce((n, s) => n + Math.ceil(s.length / 4), 0)
    }));
    return;
  }

  // ---- /api/embeddings (native legacy embeddings) ----------------------
  if (req.method === "POST" && url.pathname === "/api/embeddings") {
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      embedding: Array.from({ length: 8 }, (_, i) => (prompt.length + i) / 100)
    }));
    return;
  }

  // ---- /v1/embeddings (OpenAI-compat embeddings) -----------------------
  if (req.method === "POST" && url.pathname === "/v1/embeddings") {
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: inputs.map((s, idx) => ({
        object: "embedding",
        index: idx,
        embedding: Array.from({ length: 8 }, (_, i) => (s.length + i) / 100)
      })),
      model: body.model ?? "nomic-embed-text",
      usage: { prompt_tokens: inputs.reduce((n, s) => n + Math.ceil(s.length / 4), 0), total_tokens: 0 }
    }));
    return;
  }

  // Pull the last user message's content for trigger detection.
  function lastUserContent(reqBody) {
    if (!Array.isArray(reqBody?.messages)) return "";
    const lastUser = [...reqBody.messages].reverse().find((m) => m?.role === "user");
    if (!lastUser) return "";
    if (typeof lastUser.content === "string") return lastUser.content;
    // OpenAI-style array of parts
    if (Array.isArray(lastUser.content)) {
      return lastUser.content
        .map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
        .join(" ");
    }
    return "";
  }

  const prompt = lastUserContent(body);
  const wantsError = prompt.includes("MOCK_ERROR");
  const wantsToolCall = prompt.includes("MOCK_TOOL_CALL");
  const wantsLongStream = prompt.includes("MOCK_LONG_STREAM");

  // ---- /api/chat (native streaming) ------------------------------------
  if (req.method === "POST" && url.pathname === "/api/chat") {
    if (wantsError) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "mock error" }));
      return;
    }

    res.writeHead(200, { "content-type": "application/x-ndjson" });

    const reply = `echo: ${prompt}`;
    const chunkSize = wantsLongStream ? 2 : Math.max(1, Math.ceil(reply.length / 3));
    const chunks = reply.match(new RegExp(`.{1,${chunkSize}}`, "g")) ?? [reply];

    if (wantsToolCall) {
      // Native tool-call shape: tool_calls arrives on a single chunk just before done.
      res.write(JSON.stringify({
        model: body.model ?? "llama-3.3-70b",
        created_at: new Date().toISOString(),
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_mock_0",
              function: {
                name: "echo",
                arguments: JSON.stringify({ text: prompt })
              }
            }
          ]
        },
        done: false
      }) + "\n");
      res.write(JSON.stringify({
        model: body.model ?? "llama-3.3-70b",
        created_at: new Date().toISOString(),
        done: true,
        done_reason: "stop",
        total_duration: 1000,
        load_duration: 100,
        prompt_eval_count: Math.ceil(prompt.length / 4),
        eval_count: 5
      }) + "\n");
      res.end();
      return;
    }

    for (const chunk of chunks) {
      res.write(JSON.stringify({
        model: body.model ?? "llama-3.3-70b",
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: chunk },
        done: false
      }) + "\n");
    }
    res.write(JSON.stringify({
      model: body.model ?? "llama-3.3-70b",
      created_at: new Date().toISOString(),
      done: true,
      done_reason: "stop",
      total_duration: 1000,
      load_duration: 100,
      prompt_eval_count: Math.ceil(prompt.length / 4),
      eval_count: Math.ceil(reply.length / 4)
    }) + "\n");
    res.end();
    return;
  }

  // ---- /v1/chat/completions (OpenAI-compat streaming) -------------------
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    if (wantsError) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock error", type: "mock_error_type" } }));
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream" });

    const reply = `echo: ${prompt}`;
    const chunkSize = wantsLongStream ? 2 : Math.max(1, Math.ceil(reply.length / 3));
    const chunks = reply.match(new RegExp(`.{1,${chunkSize}}`, "g")) ?? [reply];

    if (wantsToolCall) {
      res.write(`data: ${JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        model: body.model ?? "llama-3.3-70b",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_mock_0",
                  type: "function",
                  function: { name: "echo", arguments: JSON.stringify({ text: prompt }) }
                }
              ]
            },
            finish_reason: null
          }
        ]
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        model: body.model ?? "llama-3.3-70b",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: 5, total_tokens: 0 }
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        model: body.model ?? "llama-3.3-70b",
        choices: [{ index: 0, delta: { role: "assistant", content: chunk }, finish_reason: null }]
      })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      model: body.model ?? "llama-3.3-70b",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: Math.ceil(reply.length / 4),
        total_tokens: 0
      }
    })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: `unknown endpoint: ${req.method} ${url.pathname}` }));
});

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  if (addr && typeof addr === "object") {
    process.stdout.write(`LISTENING_ON_PORT ${addr.port}\n`);
  }
});

// Allow graceful shutdown on SIGTERM/SIGINT so tests can clean up.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
