import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import http from "node:http";
import { Archive } from "../../src/archive.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const MOCK_CLAUDE_JS = join(PROJECT_ROOT, "tests", "fixtures", "mock-claude", "index.mjs");

interface Spawned {
  proc: ChildProcess;
  port: number;
  workDir: string;
  dbPath: string;
  cfgPath: string;
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
  const workDir = mkdtempSync(join(tmpdir(), "claudemcp-arc-it-"));
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
      archive: { dbPath, compressionLevel: 3 },
      files: { dir: join(workDir, "files"), ttlMs: 60000, maxTotalBytes: 1_000_000 },
      cache: { file: join(workDir, "cache.json"), ttlMs: 60000, maxEntries: 100 }
    })
  );
  const port = 14310 + Math.floor(Math.random() * 200);
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
  return { proc, port, workDir, dbPath, cfgPath };
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

async function postMessages(port: number, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/messages",
        method: "POST",
        headers: {
          "x-api-key": "sk-integration",
          "content-type": "application/json",
          "content-length": String(payload.length)
        }
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function getJson(
  port: number,
  path: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { "x-api-key": "sk-integration" }
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

describe("Archive integration", () => {
  let s: Spawned;

  beforeAll(async () => {
    s = await startServer();
  }, 30_000);

  afterAll(async () => {
    await stopServer(s);
  });

  it("any /v1/messages call gets archived with the right backend tag", async () => {
    const status = await postMessages(s.port, {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "archive integration test prompt" }]
    });
    expect(status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const res = await getJson(s.port, "/admin/archive?limit=10&offset=0");
    expect(res.status).toBe(200);
    const data = res.body.data as Array<{ backend: string }>;
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0]?.backend).toBe("claude");
  });

  it("substring search via /admin/archive/search finds the entry", async () => {
    const res = await getJson(
      s.port,
      "/admin/archive/search?q=" + encodeURIComponent("archive integration test prompt")
    );
    expect(res.status).toBe(200);
    expect((res.body.data as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("scripts/archive-prune.ts --before YYYY-MM-DD removes old entries", async () => {
    // Seed an old entry directly via the archive class — we hold the server's
    // db open, but better-sqlite3 with WAL allows concurrent readers + a
    // single writer; opening a second handle for a one-off insert is fine
    // for the test.
    const archive = new Archive(s.dbPath);
    archive.recordEntry({
      requestHash: "z".repeat(64),
      logId: "log_ancient",
      endpoint: "/v1/messages",
      backend: "claude",
      modelResolved: "claude-sonnet-4-6",
      sessionId: null,
      timestamp: "2020-01-01T00:00:00Z",
      status: "ok",
      durationMs: 1,
      inputTokens: null,
      outputTokens: null,
      requestBody: { messages: [{ role: "user", content: "ancient" }] },
      responseBody: { id: "msg_ancient" }
    });
    archive.close();

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(PROJECT_ROOT, "scripts", "archive-prune.ts"),
        "--config",
        s.cfgPath,
        "--before",
        "2024-01-01"
      ],
      { encoding: "utf8" }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/removed \d+ entries/);

    const archive2 = new Archive(s.dbPath);
    try {
      const remaining = archive2.list({
        limit: 100,
        offset: 0
      });
      // The ancient entry should be gone; the live entries from earlier in
      // this describe block remain.
      expect(remaining.data.find((e) => e.logId === "log_ancient")).toBeUndefined();
    } finally {
      archive2.close();
    }
  });
});
