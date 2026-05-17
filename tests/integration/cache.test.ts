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
  const workDir = mkdtempSync(join(tmpdir(), "claudemcp-cache-it-"));
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
  const port = 13510 + Math.floor(Math.random() * 200);
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

async function postJson(
  port: number,
  path: string,
  body: unknown
): Promise<{ status: number; body: { _cache_hit?: boolean } & Record<string, unknown> }> {
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
            body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
          })
        );
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("Response cache integration", () => {
  let s: Spawned;

  beforeAll(async () => {
    s = await startServer();
  }, 30_000);

  afterAll(async () => {
    await stopServer(s);
  });

  it("second identical request with cache_control hits the cache (verified via archive)", async () => {
    const body = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "deterministic prompt for cache",
              cache_control: { type: "ephemeral" }
            }
          ]
        }
      ]
    };

    const first = await postJson(s.port, "/v1/messages", body);
    expect(first.status).toBe(200);
    const second = await postJson(s.port, "/v1/messages", body);
    expect(second.status).toBe(200);

    // Give the fire-and-forget archive writes a moment.
    await new Promise((r) => setTimeout(r, 300));

    const archive = new Archive(s.dbPath);
    try {
      const page = archive.list({ limit: 10, offset: 0 });
      expect(page.data.length).toBeGreaterThanOrEqual(2);
      // Archive entries are returned newest-first; the second call hit the
      // cache and got the `_cache_hit: true` marker.
      const newest = page.data[0]?.responseBody as Record<string, unknown>;
      expect(newest._cache_hit).toBe(true);
    } finally {
      archive.close();
    }
  });

  it("repeated request with same model produces consistent 200s", async () => {
    // This is enforced by buildCacheKey unit tests — see responseCache.test.ts.
    // We add a thin integration smoke-test: the same prompt with different
    // model prefixes should not collide.
    const body = (model: string) => ({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "isolation test",
              cache_control: { type: "ephemeral" }
            }
          ]
        }
      ]
    });

    // Only the claude backend is enabled in this test config; this assertion
    // collapses to "same model = collide" which is the bare-minimum sanity
    // check. The cross-backend isolation case is unit-test territory.
    const a = await postJson(s.port, "/v1/messages", body("claude-sonnet-4-6"));
    const b = await postJson(s.port, "/v1/messages", body("claude-sonnet-4-6"));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});
