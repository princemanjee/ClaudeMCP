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
  const workDir = mkdtempSync(join(tmpdir(), "claudemcp-xshim-"));
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
  const port = 14910 + Math.floor(Math.random() * 200);
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

interface UploadResult {
  status: number;
  body: Record<string, unknown>;
}

function multipartPayload(filename: string, mime: string, bytes: Buffer): {
  body: Buffer;
  contentType: string;
} {
  const boundary = "----claudemcp-test-boundary";
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadAnthropic(
  port: number,
  bytes: Buffer,
  filename: string,
  mime: string
): Promise<UploadResult> {
  const { body, contentType } = multipartPayload(filename, mime, bytes);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/files",
        method: "POST",
        headers: {
          "x-api-key": "sk-integration",
          "content-type": contentType,
          "content-length": String(body.length)
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
          });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function uploadGemini(
  port: number,
  bytes: Buffer,
  filename: string,
  mime: string
): Promise<UploadResult> {
  const { body, contentType } = multipartPayload(filename, mime, bytes);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1beta/files",
        method: "POST",
        headers: {
          "x-goog-api-key": "sk-integration",
          "content-type": contentType,
          "content-length": String(body.length)
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
          });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

interface PostResult {
  status: number;
  text: string;
}

async function postJsonAnthropic(
  port: number,
  path: string,
  body: unknown
): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
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
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function postJsonGemini(
  port: number,
  path: string,
  body: unknown
): Promise<PostResult> {
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
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function downloadBytes(
  port: number,
  path: string,
  apiKeyHeader: "x-api-key" | "x-goog-api-key"
): Promise<{ status: number; bytes: Buffer; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { [apiKeyHeader]: "sk-integration" }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            bytes: Buffer.concat(chunks),
            contentType: res.headers["content-type"]
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Cross-shim file references", () => {
  let s: Spawned;

  beforeAll(async () => {
    s = await startServer();
  }, 30_000);

  afterAll(async () => {
    await stopServer(s);
  });

  it("upload via Anthropic shim, reference via Gemini shim", async () => {
    const bytes = Buffer.from("ANTHROPIC-UPLOAD-PAYLOAD");
    const up = await uploadAnthropic(s.port, bytes, "a.txt", "text/plain");
    expect(up.status).toBe(200);
    const anthId = up.body["id"] as string;
    expect(anthId).toMatch(/^file_[0-9a-f]{24}$/);
    const hash = anthId.slice("file_".length);

    // Reference it from Gemini :generateContent using files/<hash>
    const gen = await postJsonGemini(s.port, "/v1beta/models/gemini-pro:generateContent", {
      contents: [
        {
          role: "user",
          parts: [
            { text: "describe" },
            {
              fileData: {
                mimeType: "text/plain",
                fileUri: `files/${hash}`
              }
            }
          ]
        }
      ]
    });
    expect(gen.status).toBe(200);
  }, 30_000);

  it("upload via Gemini shim, reference via Anthropic shim", async () => {
    const bytes = Buffer.from("GEMINI-UPLOAD-PAYLOAD");
    const up = await uploadGemini(s.port, bytes, "g.txt", "text/plain");
    expect(up.status).toBe(200);
    const geminiName = (up.body["file"] as { name: string }).name;
    expect(geminiName).toMatch(/^files\/[0-9a-f]{24}$/);
    const hash = geminiName.slice("files/".length);

    // Reference it from Anthropic /v1/messages using file_<hash>
    const msg = await postJsonAnthropic(s.port, "/v1/messages", {
      model: "claude-opus-4-7",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "document",
              source: { type: "file", file_id: `file_${hash}` }
            }
          ]
        }
      ]
    });
    expect(msg.status).toBe(200);
  }, 30_000);

  it("upload via /v1/files; download via Gemini :download succeeds with original bytes", async () => {
    const bytes = Buffer.from("DOWNLOAD-TEST-PAYLOAD");
    const up = await uploadAnthropic(s.port, bytes, "d.txt", "text/plain");
    const anthId = up.body["id"] as string;
    const hash = anthId.slice("file_".length);

    const dl = await downloadBytes(
      s.port,
      `/v1beta/files/${hash}:download`,
      "x-goog-api-key"
    );
    expect(dl.status).toBe(200);
    expect(dl.bytes.toString("utf8")).toBe("DOWNLOAD-TEST-PAYLOAD");
  }, 30_000);

  it("Anthropic-format ID accepted in Gemini's fileData.fileUri", async () => {
    const bytes = Buffer.from("ANTH-FMT-IN-GEMINI");
    const up = await uploadAnthropic(s.port, bytes, "x.txt", "text/plain");
    const anthId = up.body["id"] as string;
    expect(anthId.startsWith("file_")).toBe(true);

    // Use the file_<hash> form directly as fileUri (no re-shaping to files/<hash>)
    const gen = await postJsonGemini(s.port, "/v1beta/models/gemini-pro:generateContent", {
      contents: [
        {
          role: "user",
          parts: [
            { text: "summarize" },
            {
              fileData: {
                mimeType: "text/plain",
                fileUri: anthId
              }
            }
          ]
        }
      ]
    });
    expect(gen.status).toBe(200);
  }, 30_000);
});
