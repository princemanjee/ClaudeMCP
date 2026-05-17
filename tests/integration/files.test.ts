import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
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
  const workDir = mkdtempSync(join(tmpdir(), "claudemcp-files-it-"));
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
  const port = 13310 + Math.floor(Math.random() * 200);
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
  return { proc, port, workDir, dbPath };
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

async function uploadFile(
  port: number,
  bytes: Buffer,
  filename: string,
  mime: string
): Promise<string> {
  const boundary = "----claudemcp-test-boundary";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/files",
        method: "POST",
        headers: {
          "x-api-key": "sk-integration",
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(body.length)
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(parsed.id as string);
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function postMessages(
  port: number,
  body: unknown
): Promise<{ status: number; body: unknown }> {
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
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("Files API + /v1/messages round-trip", () => {
  let s: Spawned;

  beforeAll(async () => {
    s = await startServer();
  }, 30_000);

  afterAll(async () => {
    await stopServer(s);
  });

  it("upload then reference: translator inlines bytes (visible in archive)", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const fileId = await uploadFile(s.port, png, "test.png", "image/png");
    expect(fileId).toMatch(/^file_[0-9a-f]{24}$/);

    const res = await postMessages(s.port, {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image",
              source: { type: "file", file_id: fileId }
            }
          ]
        }
      ]
    });
    expect(res.status).toBe(200);

    // Give the fire-and-forget archive write a moment.
    await new Promise((r) => setTimeout(r, 250));

    const archive = new Archive(s.dbPath);
    try {
      const page = archive.list({ limit: 10, offset: 0 });
      expect(page.data.length).toBeGreaterThanOrEqual(1);
      const stringified = JSON.stringify(page.data[0]?.requestBody);
      expect(stringified).toContain(png.toString("base64"));
    } finally {
      archive.close();
    }
  });

  it("delete file then subsequent reference returns 400", async () => {
    const bytes = Buffer.from("delete-me");
    const fileId = await uploadFile(s.port, bytes, "d.txt", "text/plain");
    // delete it
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: s.port,
          path: `/v1/files/${fileId}`,
          method: "DELETE",
          headers: { "x-api-key": "sk-integration" }
        },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else reject(new Error(`status ${res.statusCode}`));
        }
      );
      req.on("error", reject);
      req.end();
    });
    const res = await postMessages(s.port, {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "file", file_id: fileId }
            }
          ]
        }
      ]
    });
    expect(res.status).toBe(400);
  });
});
