import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { buildApp, type ServerDeps } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";
import { Archive } from "../../src/archive.js";
import { FileStore } from "../../src/fileStore.js";
import { ResponseCache } from "../../src/responseCache.js";
import { BackendRegistry } from "../../src/backends/registry.js";
import { ConfigSnapshotStore } from "../../src/admin/configSnapshot.js";
import { SessionStore } from "../../src/admin/session.js";

interface FixtureOpts {
  apiKey?: string;
  bindLocalhost?: boolean;
  sessionTtlMs?: number;
  adminUiEnabled?: boolean;
}

interface Fixture {
  app: Express;
  deps: ServerDeps;
  cleanup: () => void;
  dir: string;
}

function fixture(opts: FixtureOpts = {}): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "claudemcp-ui-it-"));
  const cfgPath = path.join(dir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      apiKey: opts.apiKey ?? "test-key",
      claude: { enabled: false, command: "claude", priority: 100, timeoutMs: 600000 },
      gemini: { enabled: false, command: "gemini", priority: 90, timeoutMs: 600000 },
      lmstudio: { enabled: false, instances: [] },
      ollama: { enabled: false, useNativeApi: false, instances: [] },
      adminUi: {
        enabled: opts.adminUiEnabled ?? true,
        // bindLocalhost defaults to false so supertest (which reports req.ip as
        // "::ffff:127.0.0.1" anyway) doesn't get blocked when tests don't care.
        bindLocalhost: opts.bindLocalhost ?? false,
        sessionTtlMs: opts.sessionTtlMs ?? 3_600_000
      },
      archive: { dbPath: path.join(dir, "archive.sqlite"), compressionLevel: 3 },
      files: { dir: path.join(dir, "files"), ttlMs: 60_000, maxTotalBytes: 1_000_000 },
      cache: { file: path.join(dir, "cache.json"), ttlMs: 60_000, maxEntries: 100 }
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
  const sessionStore = new SessionStore({ ttlMs: config.adminUi.sessionTtlMs });
  const deps: ServerDeps = {
    config,
    registry,
    archive,
    fileStore,
    responseCache,
    configSnapshot,
    sessionStore
  };
  const app = buildApp(deps);
  return {
    app,
    deps,
    dir,
    cleanup: () => {
      archive.close();
      fileStore.stop?.();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function setCookieList(res: request.Response): string[] {
  const raw = res.headers["set-cookie"];
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return [raw as unknown as string];
}

describe("adminUi integration — static assets", () => {
  let f: Fixture;
  beforeEach(() => { f = fixture(); });
  afterEach(() => f.cleanup());

  it("GET /admin/ui/ serves index.html with the pinned Alpine CDN script tag", async () => {
    const res = await request(f.app).get("/admin/ui/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("https://cdn.jsdelivr.net/npm/alpinejs@");
    expect(res.text).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
  });

  it("GET /admin/ui/app.js returns application/javascript", async () => {
    const res = await request(f.app).get("/admin/ui/app.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/javascript/);
  });

  it("GET /admin/ui/styles.css returns text/css", async () => {
    const res = await request(f.app).get("/admin/ui/styles.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/css/);
  });

  it("GET /admin/ui/themes/light.css resolves", async () => {
    const res = await request(f.app).get("/admin/ui/themes/light.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/css/);
  });

  it("GET /admin/ui/themes/dark.css resolves", async () => {
    const res = await request(f.app).get("/admin/ui/themes/dark.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/css/);
  });
});

describe("adminUi integration — login flow + cookie equivalence", () => {
  let f: Fixture;
  beforeEach(() => { f = fixture({ apiKey: "secret-xyz" }); });
  afterEach(() => f.cleanup());

  it("POST /admin/ui/session with the right apiKey returns 204 + Set-Cookie", async () => {
    const res = await request(f.app)
      .post("/admin/ui/session")
      .send({ apiKey: "secret-xyz" });
    expect(res.status).toBe(204);
    const cookies = setCookieList(res);
    expect(cookies.length).toBe(1);
    expect(cookies[0]).toMatch(/claudemcp_session=[0-9a-f]{64}/);
    expect(cookies[0]).toMatch(/HttpOnly/);
    expect(cookies[0]).toMatch(/SameSite=Strict/);
    expect(cookies[0]).toMatch(/Path=\/admin/);
  });

  it("POST /admin/ui/session with the wrong apiKey returns 401", async () => {
    const res = await request(f.app)
      .post("/admin/ui/session")
      .send({ apiKey: "wrong" });
    expect(res.status).toBe(401);
  });

  it("session cookie authenticates a subsequent GET /admin/backends", async () => {
    const login = await request(f.app)
      .post("/admin/ui/session")
      .send({ apiKey: "secret-xyz" });
    const cookie = (setCookieList(login)[0] ?? "").split(";")[0];
    expect(cookie).toBeTruthy();
    const res = await request(f.app).get("/admin/backends").set("Cookie", cookie!);
    expect(res.status).toBe(200);
  });

  it("x-api-key alone (no cookie) still authenticates /admin/backends", async () => {
    const res = await request(f.app)
      .get("/admin/backends")
      .set("x-api-key", "secret-xyz");
    expect(res.status).toBe(200);
  });

  it("no auth at all → 401 on /admin/backends", async () => {
    const res = await request(f.app).get("/admin/backends");
    expect(res.status).toBe(401);
  });

  it("DELETE /admin/ui/session invalidates the cookie", async () => {
    const login = await request(f.app)
      .post("/admin/ui/session")
      .send({ apiKey: "secret-xyz" });
    const cookie = (setCookieList(login)[0] ?? "").split(";")[0];
    expect(cookie).toBeTruthy();
    const del = await request(f.app)
      .delete("/admin/ui/session")
      .set("Cookie", cookie!);
    expect(del.status).toBe(204);
    const res = await request(f.app).get("/admin/backends").set("Cookie", cookie!);
    expect(res.status).toBe(401);
  });
});

describe("adminUi integration — session expiration", () => {
  it("expired session cookie returns 401 on /admin/backends", async () => {
    const f = fixture({ apiKey: "secret", sessionTtlMs: 50 });
    try {
      const login = await request(f.app)
        .post("/admin/ui/session")
        .send({ apiKey: "secret" });
      const cookie = (setCookieList(login)[0] ?? "").split(";")[0];
      expect(cookie).toBeTruthy();
      // Wait past TTL.
      await new Promise((resolve) => setTimeout(resolve, 80));
      const res = await request(f.app).get("/admin/backends").set("Cookie", cookie!);
      expect(res.status).toBe(401);
    } finally {
      f.cleanup();
    }
  });
});

describe("adminUi integration — localhost bind enforcement", () => {
  it("bindLocalhost=true rejects non-loopback X-Forwarded-For with 403", async () => {
    const f = fixture({ apiKey: "secret", bindLocalhost: true });
    f.app.set("trust proxy", true);
    try {
      const res = await request(f.app)
        .get("/admin/ui/")
        .set("X-Forwarded-For", "8.8.8.8");
      expect(res.status).toBe(403);
    } finally {
      f.cleanup();
    }
  });

  it("bindLocalhost=true accepts the default loopback address", async () => {
    const f = fixture({ apiKey: "secret", bindLocalhost: true });
    try {
      const res = await request(f.app).get("/admin/ui/");
      expect(res.status).toBe(200);
    } finally {
      f.cleanup();
    }
  });
});

describe("adminUi integration — disabled UI", () => {
  it("adminUi.enabled=false skips the SPA mount", async () => {
    const f = fixture({ adminUiEnabled: false });
    try {
      const res = await request(f.app).get("/admin/ui/");
      // With the mount skipped, the request falls through. The sessionAuth +
      // bindLocalhost middlewares still run under /admin, then nothing matches:
      // the response is a 404 from Express's default handler.
      expect([401, 404]).toContain(res.status);
    } finally {
      f.cleanup();
    }
  });
});
