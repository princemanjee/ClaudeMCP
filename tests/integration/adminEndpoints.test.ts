import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type Express } from "express";
import request from "supertest";
import { buildApp, type ServerDeps } from "../../src/server.js";
import { ConfigSnapshotStore } from "../../src/admin/configSnapshot.js";
import { Archive } from "../../src/archive.js";
import { FileStore } from "../../src/fileStore.js";
import { ResponseCache } from "../../src/responseCache.js";
import { BackendRegistry } from "../../src/backends/registry.js";
import { loadConfig } from "../../src/config.js";

const BASE_CONFIG = {
  apiKey: "sk-integration",
  claude: { enabled: false, command: "claude", priority: 100, timeoutMs: 600000 },
  gemini: { enabled: false, command: "gemini", priority: 90, timeoutMs: 600000 },
  lmstudio: { enabled: false, instances: [] },
  ollama: { enabled: false, useNativeApi: false, instances: [] },
  adminUi: { enabled: true, bindLocalhost: true, sessionTtlMs: 3600000 }
};

interface Setup {
  dir: string;
  cfgPath: string;
  deps: ServerDeps;
}

function setup(overrides: Record<string, unknown> = {}): Setup {
  const dir = mkdtempSync(join(tmpdir(), "claudemcp-admin-it-"));
  const cfgPath = join(dir, "default.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      ...BASE_CONFIG,
      ...overrides,
      archive: { dbPath: join(dir, "archive.sqlite"), compressionLevel: 3 },
      files: { dir: join(dir, "files"), ttlMs: 60000, maxTotalBytes: 1_000_000 },
      cache: {
        file: join(dir, "cache.json"),
        ttlMs: 60000,
        maxEntries: 100
      }
    })
  );
  const config = loadConfig(cfgPath);
  const archive = new Archive(config.archive.dbPath);
  const fileStore = new FileStore({
    dir: config.files.dir,
    ttlMs: config.files.ttlMs,
    maxTotalBytes: config.files.maxTotalBytes,
    sweepIntervalMs: 0
  });
  const responseCache = new ResponseCache({
    file: config.cache.file,
    ttlMs: config.cache.ttlMs,
    maxEntries: config.cache.maxEntries
  });
  const registry = new BackendRegistry({
    claude: 100,
    gemini: 90,
    lmstudio: 50,
    ollama: 40
  });
  const configSnapshot = new ConfigSnapshotStore({ initial: config, path: cfgPath });
  return {
    dir,
    cfgPath,
    deps: {
      config,
      registry,
      archive,
      fileStore,
      responseCache,
      configSnapshot
    }
  };
}

function teardown(s: Setup): void {
  s.deps.archive.close();
  s.deps.fileStore.stop?.();
  rmSync(s.dir, { recursive: true, force: true });
}

function appWith(deps: ServerDeps, trustProxy = false): Express {
  const app = buildApp(deps);
  if (trustProxy) app.set("trust proxy", true);
  return app;
}

describe("admin endpoints — bindLocalhost enforcement", () => {
  let s: Setup;

  beforeEach(() => {
    s = setup();
  });

  afterEach(() => {
    teardown(s);
  });

  it("rejects a forwarded-from-127.0.0.2 request when bindLocalhost is true", async () => {
    const app = appWith(s.deps, true);
    const res = await request(app)
      .get("/admin/config")
      .set("x-api-key", "sk-integration")
      .set("X-Forwarded-For", "127.0.0.2");
    expect(res.status).toBe(403);
  });

  it("passes through after PATCHing bindLocalhost: false", async () => {
    const app = appWith(s.deps, true);
    const patched = await request(app)
      .patch("/admin/config")
      .set("x-api-key", "sk-integration")
      .send({ adminUi: { bindLocalhost: false } });
    expect(patched.status).toBe(200);
    expect(s.deps.configSnapshot.current().adminUi.bindLocalhost).toBe(false);
    const followup = await request(app)
      .get("/admin/config")
      .set("x-api-key", "sk-integration")
      .set("X-Forwarded-For", "127.0.0.2");
    expect(followup.status).toBe(200);
  });
});

describe("admin endpoints — round-trip every route", () => {
  let s: Setup;

  beforeEach(() => {
    s = setup({ adminUi: { enabled: true, bindLocalhost: false, sessionTtlMs: 3600000 } });
  });

  afterEach(() => {
    teardown(s);
  });

  it("GET /admin/backends returns an empty data array (no backends registered)", async () => {
    const app = appWith(s.deps);
    const res = await request(app)
      .get("/admin/backends")
      .set("x-api-key", "sk-integration");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("POST /admin/backends/reprobe returns _meta.reprobeScope: all", async () => {
    const app = appWith(s.deps);
    const res = await request(app)
      .post("/admin/backends/reprobe")
      .set("x-api-key", "sk-integration")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body._meta.reprobeScope).toBe("all");
  });

  it("POST /admin/backends/test returns ok:false against an unreachable URL", async () => {
    const app = appWith(s.deps);
    const res = await request(app)
      .post("/admin/backends/test")
      .set("x-api-key", "sk-integration")
      .send({ baseUrl: "http://127.0.0.1:1" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.latencyMs).toBe("number");
  });

  it("GET /admin/config returns redacted apiKey", async () => {
    const app = appWith(s.deps);
    const res = await request(app)
      .get("/admin/config")
      .set("x-api-key", "sk-integration");
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toBe("***");
  });

  it("PUT /admin/config replaces snapshot", async () => {
    const app = appWith(s.deps);
    const res = await request(app)
      .put("/admin/config")
      .set("x-api-key", "sk-integration")
      .send({ ...BASE_CONFIG, apiKey: "sk-rotated" });
    expect(res.status).toBe(200);
    expect(s.deps.configSnapshot.current().apiKey).toBe("sk-rotated");
  });

  it("PATCH /admin/config merges a sub-tree", async () => {
    const app = appWith(s.deps);
    const res = await request(app)
      .patch("/admin/config")
      .set("x-api-key", "sk-integration")
      .send({ claude: { timeoutMs: 750000 } });
    expect(res.status).toBe(200);
    expect(s.deps.configSnapshot.current().claude.timeoutMs).toBe(750000);
  });

  it("GET /admin/archive (Plan 05 mounted via Plan 11's router) still works", async () => {
    const app = appWith(s.deps);
    const res = await request(app)
      .get("/admin/archive")
      .set("x-api-key", "sk-integration");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe("admin endpoints — config PUT changes next request behavior", () => {
  let s: Setup;

  beforeEach(() => {
    s = setup({ adminUi: { enabled: true, bindLocalhost: false, sessionTtlMs: 3600000 } });
  });

  afterEach(() => {
    teardown(s);
  });

  it("after PUT with new apiKey, the new key authenticates and old does not (for /admin/config)", async () => {
    const app = appWith(s.deps);
    const put = await request(app)
      .put("/admin/config")
      .set("x-api-key", "sk-integration")
      .send({ ...BASE_CONFIG, apiKey: "sk-newer" });
    expect(put.status).toBe(200);

    // The /admin/config GET re-reads the snapshot, so the new key wins.
    const newKeyGet = await request(app)
      .get("/admin/config")
      .set("x-api-key", "sk-newer");
    expect(newKeyGet.status).toBe(200);

    const oldKeyGet = await request(app)
      .get("/admin/config")
      .set("x-api-key", "sk-integration");
    expect(oldKeyGet.status).toBe(401);
  });

  it("after PUT, pre-existing handlers (e.g., /admin/archive) STILL accept the old key — documented scope boundary", async () => {
    const app = appWith(s.deps);
    await request(app)
      .put("/admin/config")
      .set("x-api-key", "sk-integration")
      .send({ ...BASE_CONFIG, apiKey: "sk-newer" });
    // /admin/archive was constructed with the original apiKey captured at
    // boot, so the old key still works there until server restart.
    const oldKeyArchive = await request(app)
      .get("/admin/archive")
      .set("x-api-key", "sk-integration");
    expect(oldKeyArchive.status).toBe(200);
  });
});
