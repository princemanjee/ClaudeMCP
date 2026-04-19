import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/server.js";
import type { OpenAIChatCompletionResponse } from "../src/openaiShim/types.js";

const MOCK = resolve("tests/fixtures/mock-claude.mjs");

let tmpDir: string;
let configPath: string;
let logFile: string;
let storeFile: string;
let close: (() => Promise<void>) | null = null;
let port = 0;

async function startServer(
  overrides: Record<string, unknown> = {},
): Promise<void> {
  port = 31000 + Math.floor(Math.random() * 1000);
  const config = {
    port,
    host: "127.0.0.1",
    logFile,
    sessionStoreFile: storeFile,
    claudeCommand: ["node", MOCK],
    ask: { timeoutMs: 5000, allowedTools: "" },
    task: {
      defaultSessionMode: "session" as const,
      defaultWorkDir: tmpDir,
      timeoutMs: 5000,
      allowedTools: "Read",
      dangerouslySkipPermissions: true,
      sessionTtlMs: 60_000,
    },
    openai: {
      enabled: true,
      requireAuthHeader: null,
      timeoutMs: 10_000,
    },
    ...overrides,
  };
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  const started = await main(["--config", configPath]);
  close = started.close;
}

async function postCompletion(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-mcp-oai-"));
  configPath = join(tmpDir, "config.json");
  logFile = join(tmpDir, "activity.log");
  storeFile = join(tmpDir, "sessions.json");
  delete process.env.MOCK_CLAUDE_SCENARIO;
});

afterEach(async () => {
  if (close) {
    await close();
    close = null;
  }
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MOCK_CLAUDE_SCENARIO;
});

describe("openai integration", () => {
  test("non-streaming answer path returns chat.completion body", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "openai-answer";
    await startServer();
    const res = await postCompletion({
      model: "any",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OpenAIChatCompletionResponse;
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.role).toBe("assistant");
    expect(body.choices[0]?.message.content).toContain("mock answer");
    expect(body.choices[0]?.finish_reason).toBe("stop");
  });

  test("non-streaming tool-call path returns tool_calls in message", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "openai-tool-call";
    await startServer();
    const res = await postCompletion({
      model: "any",
      messages: [{ role: "user", content: "search please" }],
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            description: "Search the web",
            parameters: { type: "object" },
          },
        },
      ],
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OpenAIChatCompletionResponse;
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
    const calls = body.choices[0]?.message.tool_calls;
    expect(calls?.length).toBe(1);
    expect(calls?.[0]?.function.name).toBe("search");
    expect(calls?.[0]?.function.arguments).toContain("mock");
  });

  test("non-streaming parallel tool calls", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "openai-parallel";
    await startServer();
    const res = await postCompletion({
      model: "any",
      messages: [{ role: "user", content: "do two things" }],
      tools: [
        {
          type: "function",
          function: { name: "a", parameters: { type: "object" } },
        },
        {
          type: "function",
          function: { name: "b", parameters: { type: "object" } },
        },
      ],
      stream: false,
    });
    const body = (await res.json()) as OpenAIChatCompletionResponse;
    const calls = body.choices[0]?.message.tool_calls ?? [];
    expect(calls.length).toBe(2);
    expect(calls[0]?.function.name).toBe("a");
    expect(calls[1]?.function.name).toBe("b");
  });

  test("streaming answer path returns valid SSE", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "openai-answer";
    await startServer();
    const res = await postCompletion({
      model: "any",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain('"role":"assistant"');
    expect(text).toContain("data: [DONE]");
    expect(text).toContain('"finish_reason":"stop"');
  });

  test("auth: returns 401 when requireAuthHeader is set and header is missing", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "openai-answer";
    await startServer({
      openai: {
        enabled: true,
        requireAuthHeader: "Bearer secret",
        timeoutMs: 10_000,
      },
    });
    const res = await postCompletion({
      model: "any",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(401);
  });

  test("auth: accepts matching header", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "openai-answer";
    await startServer({
      openai: {
        enabled: true,
        requireAuthHeader: "Bearer secret",
        timeoutMs: 10_000,
      },
    });
    const res = await postCompletion(
      { model: "any", messages: [{ role: "user", content: "hi" }] },
      { Authorization: "Bearer secret" },
    );
    expect(res.status).toBe(200);
  });

  test("rejects empty messages with 400", async () => {
    await startServer();
    const res = await postCompletion({ model: "any", messages: [] });
    expect(res.status).toBe(400);
  });

  test("session resume across two turns: second call reuses Claude session", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "openai-answer";
    await startServer();
    const first = await postCompletion({
      model: "any",
      messages: [{ role: "user", content: "turn 1" }],
      stream: false,
    });
    const firstBody = (await first.json()) as OpenAIChatCompletionResponse;
    const firstAssistantContent = firstBody.choices[0]?.message.content ?? "";

    const second = await postCompletion({
      model: "any",
      messages: [
        { role: "user", content: "turn 1" },
        { role: "assistant", content: firstAssistantContent },
        { role: "user", content: "turn 2" },
      ],
      stream: false,
    });
    expect(second.status).toBe(200);

    const entries = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const openaiEntries = entries.filter(
      (e) => e.tool === "openai_completion",
    );
    expect(openaiEntries.length).toBe(2);
    expect(openaiEntries[0].openaiMode).toBe("fresh");
    expect(openaiEntries[1].openaiMode).toBe("resumed");
  });
});
