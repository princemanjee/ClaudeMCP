import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const MOCK_CLAUDE_JS = join(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "mock-claude",
  "index.mjs"
);

interface SpawnedServer {
  proc: ChildProcess;
  port: number;
  workDir: string;
}

function pickPort(): number {
  // Disjoint range from messages.test.ts to avoid collisions when both
  // suites run in parallel.
  return 13410 + Math.floor(Math.random() * 200);
}

async function waitForReady(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject(new Error(`status ${res.statusCode}`));
        });
        req.on("error", reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server did not become ready on port ${port}`);
}

async function startServer(): Promise<SpawnedServer> {
  const workDir = mkdtempSync(join(tmpdir(), "claudemcp-it-tooluse-"));
  const dbPath = join(workDir, "archive.sqlite");
  const cfgPath = join(workDir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      apiKey: "sk-integration",
      claude: {
        enabled: true,
        command: ["node", MOCK_CLAUDE_JS],
        priority: 100,
        timeoutMs: 10000
      },
      gemini: { enabled: false, command: "gemini" },
      lmstudio: { enabled: false, instances: [] },
      ollama: { enabled: false, useNativeApi: false, instances: [] },
      archive: { dbPath, compressionLevel: 3 }
    })
  );

  const port = pickPort();
  const proc = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(PROJECT_ROOT, "src", "bin.ts"),
      "--config",
      cfgPath,
      "--port",
      String(port)
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    }
  );

  proc.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
  proc.stderr?.on("data", (d) => process.stderr.write(`[server-err] ${d}`));

  await waitForReady(port);
  return { proc, port, workDir };
}

async function stopServer(s: SpawnedServer): Promise<void> {
  return new Promise((resolve) => {
    s.proc.once("exit", () => {
      rmSync(s.workDir, { recursive: true, force: true });
      resolve();
    });
    s.proc.kill("SIGTERM");
    setTimeout(() => {
      if (!s.proc.killed) s.proc.kill("SIGKILL");
    }, 4000);
  });
}

function postJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.length),
          "x-api-key": "sk-integration",
          ...headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers
          })
        );
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("Anthropic shim — tool_use end-to-end", () => {
  let server: SpawnedServer;

  beforeAll(async () => {
    server = await startServer();
  }, 30000);

  afterAll(async () => {
    if (server) await stopServer(server);
  });

  it("POST /v1/messages with tools and a MOCK_TOOL_USE prompt returns a tool_use content block", async () => {
    const res = await postJson(server.port, "/v1/messages", {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: 'Please call: MOCK_TOOL_USE(calculator,toolu_99,{"a":5,"b":7})'
        }
      ],
      tools: [
        {
          name: "calculator",
          description: "Adds two numbers",
          input_schema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"]
          }
        }
      ]
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as {
      type: string;
      content: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
      stop_reason: string;
    };
    expect(parsed.type).toBe("message");
    expect(parsed.stop_reason).toBe("tool_use");
    const toolUse = parsed.content.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect(toolUse?.id).toBe("toolu_99");
    expect(toolUse?.name).toBe("calculator");
    expect(toolUse?.input).toEqual({ a: 5, b: 7 });
  });

  it("POST /v1/messages with stream:true emits content_block_start/delta/stop for tool_use", async () => {
    const res = await postJson(server.port, "/v1/messages", {
      model: "claude-sonnet-4-6",
      stream: true,
      messages: [
        {
          role: "user",
          content: 'MOCK_TOOL_USE(search,toolu_55,{"q":"hello"})'
        }
      ],
      tools: [
        {
          name: "search",
          input_schema: { type: "object", properties: { q: { type: "string" } } }
        }
      ]
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const eventBlocks = res.body
      .split("\n\n")
      .filter((b) => b.startsWith("event: "));
    const events = eventBlocks.map((b) => {
      const lines = b.split("\n");
      const event = lines[0]?.replace(/^event:\s*/, "") ?? "";
      const data = lines[1]?.replace(/^data:\s*/, "") ?? "";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
    const eventNames = events.map((e) => e.event);
    expect(eventNames).toContain("content_block_start");
    expect(eventNames).toContain("content_block_delta");
    expect(eventNames).toContain("content_block_stop");

    // Find the content_block_start for the tool_use.
    const start = events.find(
      (e) =>
        e.event === "content_block_start" &&
        (e.data["content_block"] as { type: string }).type === "tool_use"
    );
    expect(start).toBeDefined();
    expect((start?.data["content_block"] as { id: string }).id).toBe("toolu_55");

    // Find the input_json_delta.
    const delta = events.find(
      (e) =>
        e.event === "content_block_delta" &&
        (e.data["delta"] as { type: string }).type === "input_json_delta"
    );
    expect(delta).toBeDefined();
    const partial = (delta?.data["delta"] as { partial_json: string }).partial_json;
    expect(JSON.parse(partial)).toEqual({ q: "hello" });

    // Last event is message_stop.
    expect(eventNames[eventNames.length - 1]).toBe("message_stop");
  });

  it("POST /v1/messages with stop_sequences cuts mid-stream and returns stop_reason 'stop_sequence'", async () => {
    const res = await postJson(server.port, "/v1/messages", {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "MOCK_STOP_SEQUENCE_AT(HALT)" }],
      stop_sequences: ["HALT"]
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as {
      content: Array<{ type: string; text?: string }>;
      stop_reason: string;
    };
    expect(parsed.stop_reason).toBe("stop_sequence");
    const text = parsed.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    expect(text).not.toContain("HALT");
    expect(text).not.toContain("AFTER-SHOULD-BE-DROPPED");
  });
});
