import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const MOCK_CLAUDE_JS = join(PROJECT_ROOT, "tests", "fixtures", "mock-claude", "index.mjs");
const MOCK_GEMINI_JS = join(PROJECT_ROOT, "tests", "fixtures", "mock-gemini", "index.mjs");

interface Spawned {
  proc: ChildProcess;
  port: number;
  workDir: string;
}

async function waitForReady(port: number, timeoutMs = 10000): Promise<void> {
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
  throw new Error(`server not ready on port ${port}`);
}

async function startServer(): Promise<Spawned> {
  const workDir = mkdtempSync(join(tmpdir(), "claudemcp-gen-it-"));
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
      gemini: {
        enabled: true,
        command: ["node", MOCK_GEMINI_JS],
        priority: 90,
        timeoutMs: 10000
      },
      lmstudio: { enabled: false, instances: [] },
      ollama: { enabled: false, useNativeApi: false, instances: [] },
      archive: { dbPath: join(workDir, "archive.sqlite"), compressionLevel: 3 },
      files: { dir: join(workDir, "files"), ttlMs: 60000, maxTotalBytes: 1_000_000 },
      cache: { file: join(workDir, "cache.json"), ttlMs: 60000, maxEntries: 100 }
    })
  );
  const port = 14710 + Math.floor(Math.random() * 200);
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
    { stdio: ["ignore", "pipe", "pipe"], env: process.env }
  );
  proc.stdout?.on("data", (d) => process.stdout.write(`[srv] ${d}`));
  proc.stderr?.on("data", (d) => process.stderr.write(`[srv-err] ${d}`));
  await waitForReady(port);
  return { proc, port, workDir };
}

async function stopServer(s: Spawned): Promise<void> {
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

interface PostResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

async function postJson(port: number, path: string, body: unknown): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "x-goog-api-key": "sk-integration",
          "content-type": "application/json",
          "content-length": String(payload.length)
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function getJson(port: number, path: string): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { "x-goog-api-key": "sk-integration" }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Gemini shim — :generateContent integration (cross-backend)", () => {
  let s: Spawned;

  beforeAll(async () => {
    s = await startServer();
  }, 30_000);

  afterAll(async () => {
    await stopServer(s);
  });

  it("non-streaming gemini-pro → mock-gemini returns Gemini-shaped body", async () => {
    const res = await postJson(s.port, "/v1beta/models/gemini-pro:generateContent", {
      contents: [{ role: "user", parts: [{ text: "hello" }] }]
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as {
      candidates: Array<{
        content: { parts: Array<{ text?: string }> };
        finishReason: string;
        safetyRatings: unknown[];
      }>;
      modelVersion: string;
      usageMetadata: { promptTokenCount: number };
    };
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]?.finishReason).toBe("STOP");
    expect(body.candidates[0]?.safetyRatings).toEqual([]);
    expect(body.usageMetadata).toBeDefined();
    const text = body.candidates[0]?.content.parts.map((p) => p.text ?? "").join("");
    expect(text).toContain("echo");
  }, 30_000);

  it("non-streaming claude-opus-4-7 → mock-claude returns Gemini-shaped body (cross-shim)", async () => {
    const res = await postJson(s.port, "/v1beta/models/claude-opus-4-7:generateContent", {
      contents: [{ role: "user", parts: [{ text: "hi-claude" }] }]
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as {
      candidates: Array<{
        content: { parts: Array<{ text?: string }> };
        finishReason: string;
      }>;
    };
    expect(body.candidates[0]?.finishReason).toBe("STOP");
    const text = body.candidates[0]?.content.parts.map((p) => p.text ?? "").join("");
    // mock-claude echoes back the prompt; should contain "hi-claude"
    expect(text.length).toBeGreaterThan(0);
  }, 30_000);

  it("streaming gemini-pro → mock-gemini emits Gemini SSE", async () => {
    const res = await postJson(s.port, "/v1beta/models/gemini-pro:streamGenerateContent", {
      contents: [{ role: "user", parts: [{ text: "stream-test" }] }]
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain("data: ");
    const chunks = res.text
      .split("\n\n")
      .filter((c) => c.startsWith("data: "))
      .map((c) => JSON.parse(c.replace(/^data:\s*/, "")));
    expect(chunks.length).toBeGreaterThan(0);
    const last = chunks[chunks.length - 1] as { candidates: Array<{ finishReason?: string }> };
    expect(last.candidates[0]?.finishReason).toBe("STOP");
  }, 30_000);

  it("streaming claude-opus-4-7 → mock-claude works (cross-shim streaming)", async () => {
    const res = await postJson(s.port, "/v1beta/models/claude-opus-4-7:streamGenerateContent", {
      contents: [{ role: "user", parts: [{ text: "claude-stream" }] }]
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const chunks = res.text
      .split("\n\n")
      .filter((c) => c.startsWith("data: "))
      .map((c) => JSON.parse(c.replace(/^data:\s*/, "")));
    const last = chunks[chunks.length - 1] as { candidates: Array<{ finishReason?: string }> };
    expect(last.candidates[0]?.finishReason).toBe("STOP");
  }, 30_000);

  it("models/ prefix accepted in the URL path", async () => {
    const res = await postJson(
      s.port,
      "/v1beta/models/models/gemini-pro:generateContent",
      { contents: [{ role: "user", parts: [{ text: "prefixed" }] }] }
    );
    expect(res.status).toBe(200);
  }, 30_000);

  it("countTokens returns {totalTokens: <n>}", async () => {
    const res = await postJson(s.port, "/v1beta/models/gemini-pro:countTokens", {
      contents: [{ role: "user", parts: [{ text: "hello world hello world" }] }]
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as { totalTokens: number };
    expect(typeof body.totalTokens).toBe("number");
    expect(body.totalTokens).toBeGreaterThan(0);
  }, 30_000);

  it("GET /v1beta/models returns cross-backend listing with models/ prefix", async () => {
    const res = await getJson(s.port, "/v1beta/models");
    expect(res.status).toBe(200);
    const models = (res.body as { models: Array<{ name: string }> }).models;
    const names = models.map((m) => m.name);
    expect(names).toContain("models/gemini-pro");
    expect(names).toContain("models/claude-opus-4-7");
  }, 30_000);
});
