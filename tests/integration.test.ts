import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

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
  port = 30000 + Math.floor(Math.random() * 1000);
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
    ...overrides,
  };
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  const started = await main(["--config", configPath]);
  close = started.close;
}

async function mkClient(): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  const transport = new SSEClientTransport(
    new URL(`http://127.0.0.1:${port}/sse`),
  );
  await client.connect(transport);
  return client;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-mcp-int-"));
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

describe("integration", () => {
  test("claude_ask returns the mock output and writes a log entry", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "success";
    await startServer();
    const client = await mkClient();
    const res = await client.callTool({
      name: "claude_ask",
      arguments: { prompt: "hello" },
    });
    const first = res.content[0];
    expect(first).toMatchObject({ type: "text" });
    if (first.type === "text") {
      expect(first.text).toContain("mock reply to: hello");
    }
    expect(existsSync(logFile)).toBe(true);
    const entries = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({
      tool: "claude_ask",
      status: "success",
      prompt: "hello",
    });
    await client.close();
  });

  test("claude_task stores sessionId and resumes it on next call", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "success";
    await startServer();
    const client = await mkClient();
    const first = await client.callTool({
      name: "claude_task",
      arguments: { prompt: "start", sessionMode: "session" },
    });
    const firstMeta = (first as unknown as { _meta?: { sessionId?: string } })
      ._meta;
    const sid = firstMeta?.sessionId;
    expect(sid).toBeTruthy();
    expect(existsSync(storeFile)).toBe(true);
    const stored = JSON.parse(readFileSync(storeFile, "utf8"));
    expect(stored[sid!]).toMatchObject({ sessionId: sid, turnCount: 0 });

    const second = await client.callTool({
      name: "claude_task",
      arguments: { prompt: "continue", sessionMode: "session", sessionId: sid },
    });
    const secondMeta = (second as unknown as { _meta?: { sessionId?: string; mode?: string } })
      ._meta;
    expect(secondMeta?.sessionId).toBe(sid);
    expect(secondMeta?.mode).toBe("resumed");
    const storedAfter = JSON.parse(readFileSync(storeFile, "utf8"));
    expect(storedAfter[sid!].turnCount).toBe(1);
    await client.close();
  });

  test("claude_task returns isError on non-zero exit", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "nonzero";
    await startServer();
    const client = await mkClient();
    const res = await client.callTool({
      name: "claude_task",
      arguments: { prompt: "fail", sessionMode: "stateless" },
    });
    expect(res.isError).toBe(true);
    const entries = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries[0]).toMatchObject({ status: "error", exitCode: 3 });
    await client.close();
  });

  test("timeout is reported as status=timeout", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "slow";
    await startServer({
      task: {
        defaultSessionMode: "stateless",
        defaultWorkDir: tmpDir,
        timeoutMs: 300,
        allowedTools: "Read",
        dangerouslySkipPermissions: true,
        sessionTtlMs: 60_000,
      },
    });
    const client = await mkClient();
    const res = await client.callTool({
      name: "claude_task",
      arguments: { prompt: "zzz", sessionMode: "stateless" },
    });
    expect(res.isError).toBe(true);
    const entries = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(entries[0]?.status).toBe("timeout");
    await client.close();
  }, 10000);

  test("auto-last picks the most recent session", async () => {
    process.env.MOCK_CLAUDE_SCENARIO = "success";
    await startServer();
    const client = await mkClient();
    const first = await client.callTool({
      name: "claude_task",
      arguments: { prompt: "a", sessionMode: "session" },
    });
    const firstSid =
      (first as unknown as { _meta?: { sessionId?: string } })._meta?.sessionId;
    const second = await client.callTool({
      name: "claude_task",
      arguments: { prompt: "b", sessionMode: "auto-last" },
    });
    const secondMeta =
      (second as unknown as { _meta?: { sessionId?: string; mode?: string } })
        ._meta;
    expect(secondMeta?.sessionId).toBe(firstSid);
    expect(secondMeta?.mode).toBe("resumed");
    await client.close();
  });
});
