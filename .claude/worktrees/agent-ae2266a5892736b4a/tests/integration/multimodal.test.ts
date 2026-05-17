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
  return 13610 + Math.floor(Math.random() * 200);
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
  const workDir = mkdtempSync(join(tmpdir(), "claudemcp-it-multimodal-"));
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

describe("Anthropic shim — multimodal end-to-end", () => {
  let server: SpawnedServer;

  beforeAll(async () => {
    server = await startServer();
  }, 30000);

  afterAll(async () => {
    if (server) await stopServer(server);
  });

  it("POST /v1/messages with an image content block reaches the CLI", async () => {
    // 1x1 transparent PNG — minimal valid image base64.
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2P8z8DwHwAFAQH/CXm7BgAAAABJRU5ErkJggg==";
    const res = await postJson(server.port, "/v1/messages", {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "MOCK_VISION_REQUEST: describe the attached image" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: pngBase64 }
            }
          ]
        }
      ]
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = parsed.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    // The mock echoes the prompt; we should see the image envelope in the
    // echoed text, confirming it was inlined into the folded prompt.
    expect(text).toContain("[image:image/png;base64,");
    expect(text).toContain(pngBase64.slice(0, 16));
  });

  it("POST /v1/messages with a document content block reaches the CLI", async () => {
    const pdfBase64 = "JVBERi0xLjQKJeLjz9MK";
    const res = await postJson(server.port, "/v1/messages", {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "MOCK_VISION_REQUEST: summarize" },
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pdfBase64 }
            }
          ]
        }
      ]
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = parsed.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    expect(text).toContain("[document:application/pdf;base64,");
    expect(text).toContain(pdfBase64.slice(0, 8));
  });

  it("POST /v1/messages with a tool_result re-inlines into the next CLI invocation", async () => {
    const res = await postJson(server.port, "/v1/messages", {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "compute 1 + 2" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_calc1", name: "calculator", input: { x: 1, y: 2 } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_calc1", content: "3" },
            { type: "text", text: "MOCK_TOOL_RESULT_ECHO confirm please" }
          ]
        }
      ]
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = parsed.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    expect(text).toContain("echo[tool_result:toolu_calc1]=3");
  });
});
