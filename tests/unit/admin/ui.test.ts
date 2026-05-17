import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { type Express, type RequestHandler } from "express";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  createAdminUiHandler,
  isLoopback,
  readSessionCookie
} from "../../../src/admin/ui.js";
import { SessionStore } from "../../../src/admin/session.js";

interface BuildAppOpts {
  apiKey?: string;
  bindLocalhost?: boolean;
  sessionTtlMs?: number;
  forceRemoteIp?: string;
  uiAssetDir?: string;
  sessionStore?: SessionStore;
}

function buildApp(opts: BuildAppOpts = {}): { app: Express; store: SessionStore } {
  const app = express();
  // Simulate cookie-parser (the real cookie-parser lives in server.ts).
  const cookieMiddleware: RequestHandler = (req, _res, next) => {
    const header = req.headers["cookie"];
    const cookies: Record<string, string> = {};
    if (typeof header === "string") {
      for (const part of header.split(";")) {
        const [k, v] = part.trim().split("=");
        if (k && typeof v === "string") cookies[k] = v;
      }
    }
    (req as express.Request & { cookies: Record<string, string> }).cookies =
      cookies;
    next();
  };
  app.use(cookieMiddleware);

  // Optional override for `req.ip`.
  if (typeof opts.forceRemoteIp === "string") {
    const force = opts.forceRemoteIp;
    app.use((req, _res, next) => {
      Object.defineProperty(req, "ip", { get: () => force, configurable: true });
      next();
    });
  }

  const store = opts.sessionStore ?? new SessionStore({ ttlMs: opts.sessionTtlMs ?? 60_000 });
  const router = createAdminUiHandler({
    sessionStore: store,
    config: {
      apiKey: opts.apiKey ?? "secret",
      adminUi: {
        enabled: true,
        bindLocalhost: opts.bindLocalhost ?? false,
        sessionTtlMs: opts.sessionTtlMs ?? 60_000
      }
    },
    checkApiKey: (presented, expected) => presented === expected,
    uiAssetDir: opts.uiAssetDir
  });
  app.use("/admin/ui", router);
  return { app, store };
}

function makeFakeAssetDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "claudemcp-ui-fixture-"));
  writeFileSync(
    path.join(dir, "index.html"),
    "<!doctype html><html><body><div id=app>fixture</div></body></html>"
  );
  writeFileSync(path.join(dir, "app.js"), "/* fixture */ window.x = 1;");
  writeFileSync(path.join(dir, "styles.css"), "body { color: pink; }");
  mkdirSync(path.join(dir, "themes"));
  writeFileSync(path.join(dir, "themes", "light.css"), "[data-theme=light]{}");
  writeFileSync(path.join(dir, "themes", "dark.css"), "[data-theme=dark]{}");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("isLoopback()", () => {
  it("accepts 127.0.0.1 / ::1 / ::ffff:127.0.0.1", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects 0.0.0.0 / 8.8.8.8 / empty / undefined / arbitrary", () => {
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("8.8.8.8")).toBe(false);
    expect(isLoopback("")).toBe(false);
    expect(isLoopback("10.0.0.1")).toBe(false);
  });
});

describe("createAdminUiHandler — localhost bind enforcement", () => {
  let fixture: ReturnType<typeof makeFakeAssetDir>;

  beforeEach(() => {
    fixture = makeFakeAssetDir();
  });
  afterEach(() => fixture.cleanup());

  it("bindLocalhost=true allows 127.0.0.1", async () => {
    const { app } = buildApp({
      forceRemoteIp: "127.0.0.1",
      bindLocalhost: true,
      uiAssetDir: fixture.dir
    });
    const res = await request(app).get("/admin/ui/");
    expect(res.status).toBe(200);
  });

  it("bindLocalhost=true allows ::1", async () => {
    const { app } = buildApp({
      forceRemoteIp: "::1",
      bindLocalhost: true,
      uiAssetDir: fixture.dir
    });
    const res = await request(app).get("/admin/ui/");
    expect(res.status).toBe(200);
  });

  it("bindLocalhost=true allows ::ffff:127.0.0.1", async () => {
    const { app } = buildApp({
      forceRemoteIp: "::ffff:127.0.0.1",
      bindLocalhost: true,
      uiAssetDir: fixture.dir
    });
    const res = await request(app).get("/admin/ui/");
    expect(res.status).toBe(200);
  });

  it("bindLocalhost=true rejects 8.8.8.8 with 403", async () => {
    const { app } = buildApp({
      forceRemoteIp: "8.8.8.8",
      bindLocalhost: true,
      uiAssetDir: fixture.dir
    });
    const res = await request(app).get("/admin/ui/");
    expect(res.status).toBe(403);
    expect(res.body?.error?.type).toBe("permission_error");
  });

  it("bindLocalhost=false bypasses the gate", async () => {
    const { app } = buildApp({
      forceRemoteIp: "8.8.8.8",
      bindLocalhost: false,
      uiAssetDir: fixture.dir
    });
    const res = await request(app).get("/admin/ui/");
    expect(res.status).toBe(200);
  });

  it("bindLocalhost=true also rejects POST /session from a non-loopback IP", async () => {
    const { app } = buildApp({
      forceRemoteIp: "8.8.8.8",
      bindLocalhost: true,
      apiKey: "secret",
      uiAssetDir: fixture.dir
    });
    const res = await request(app)
      .post("/admin/ui/session")
      .send({ apiKey: "secret" });
    expect(res.status).toBe(403);
  });
});

describe("createAdminUiHandler — static asset serving", () => {
  let fixture: ReturnType<typeof makeFakeAssetDir>;

  beforeEach(() => {
    fixture = makeFakeAssetDir();
  });
  afterEach(() => fixture.cleanup());

  it("GET /admin/ui/ serves index.html", async () => {
    const { app } = buildApp({ uiAssetDir: fixture.dir });
    const res = await request(app).get("/admin/ui/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("<!doctype html>");
    expect(res.text).toContain("fixture");
  });

  it("GET /admin/ui/app.js returns application/javascript content-type", async () => {
    const { app } = buildApp({ uiAssetDir: fixture.dir });
    const res = await request(app).get("/admin/ui/app.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/javascript/);
    expect(res.text).toContain("window.x = 1");
  });

  it("GET /admin/ui/styles.css returns text/css content-type", async () => {
    const { app } = buildApp({ uiAssetDir: fixture.dir });
    const res = await request(app).get("/admin/ui/styles.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/css/);
  });

  it("GET /admin/ui/themes/light.css resolves", async () => {
    const { app } = buildApp({ uiAssetDir: fixture.dir });
    const res = await request(app).get("/admin/ui/themes/light.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/css/);
  });

  it("GET /admin/ui/does-not-exist returns 404", async () => {
    const { app } = buildApp({ uiAssetDir: fixture.dir });
    const res = await request(app).get("/admin/ui/does-not-exist");
    expect(res.status).toBe(404);
  });
});

describe("createAdminUiHandler — POST /session login", () => {
  let fixture: ReturnType<typeof makeFakeAssetDir>;

  beforeEach(() => {
    fixture = makeFakeAssetDir();
  });
  afterEach(() => fixture.cleanup());

  it("missing apiKey returns 401", async () => {
    const { app } = buildApp({ apiKey: "secret", uiAssetDir: fixture.dir });
    const res = await request(app).post("/admin/ui/session").send({});
    expect(res.status).toBe(401);
  });

  it("wrong apiKey returns 401", async () => {
    const { app } = buildApp({ apiKey: "secret", uiAssetDir: fixture.dir });
    const res = await request(app)
      .post("/admin/ui/session")
      .send({ apiKey: "wrong" });
    expect(res.status).toBe(401);
  });

  it("empty-string apiKey returns 401", async () => {
    const { app } = buildApp({ apiKey: "secret", uiAssetDir: fixture.dir });
    const res = await request(app)
      .post("/admin/ui/session")
      .send({ apiKey: "" });
    expect(res.status).toBe(401);
  });

  it("non-string apiKey returns 401", async () => {
    const { app } = buildApp({ apiKey: "secret", uiAssetDir: fixture.dir });
    const res = await request(app)
      .post("/admin/ui/session")
      .send({ apiKey: 42 });
    expect(res.status).toBe(401);
  });

  it("correct apiKey returns 204 + Set-Cookie with all attributes", async () => {
    const { app } = buildApp({
      apiKey: "secret",
      sessionTtlMs: 60_000,
      uiAssetDir: fixture.dir
    });
    const res = await request(app)
      .post("/admin/ui/session")
      .send({ apiKey: "secret" });
    expect(res.status).toBe(204);
    const raw = res.headers["set-cookie"];
    const cookies = Array.isArray(raw) ? raw : raw ? [raw as unknown as string] : [];
    expect(cookies.length).toBe(1);
    const cookieStr = cookies[0]!;
    expect(cookieStr).toMatch(/^claudemcp_session=[0-9a-f]{64}/);
    expect(cookieStr).toMatch(/HttpOnly/);
    expect(cookieStr).toMatch(/SameSite=Strict/);
    expect(cookieStr).toMatch(/Path=\/admin/);
    expect(cookieStr).toMatch(/Max-Age=60/);
  });

  it("issued cookie validates against the SessionStore", async () => {
    const store = new SessionStore({ ttlMs: 60_000 });
    const { app } = buildApp({
      apiKey: "secret",
      sessionStore: store,
      uiAssetDir: fixture.dir
    });
    const res = await request(app)
      .post("/admin/ui/session")
      .send({ apiKey: "secret" });
    const raw = res.headers["set-cookie"];
    const cookies = Array.isArray(raw) ? raw : raw ? [raw as unknown as string] : [];
    const token = (cookies[0] ?? "")
      .split(";")[0]!
      .split("=")[1]!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(store.validate(token)).toBe(true);
  });
});

describe("createAdminUiHandler — DELETE /session logout", () => {
  let fixture: ReturnType<typeof makeFakeAssetDir>;

  beforeEach(() => {
    fixture = makeFakeAssetDir();
  });
  afterEach(() => fixture.cleanup());

  it("revokes the token in the store + clears the cookie", async () => {
    const store = new SessionStore({ ttlMs: 60_000 });
    const { app } = buildApp({
      apiKey: "secret",
      sessionStore: store,
      uiAssetDir: fixture.dir
    });
    const login = await request(app)
      .post("/admin/ui/session")
      .send({ apiKey: "secret" });
    const raw = login.headers["set-cookie"];
    const cookies = Array.isArray(raw) ? raw : raw ? [raw as unknown as string] : [];
    const cookiePair = (cookies[0] ?? "").split(";")[0]!;
    const token = cookiePair.split("=")[1]!;
    expect(store.validate(token)).toBe(true);

    const logout = await request(app)
      .delete("/admin/ui/session")
      .set("Cookie", cookiePair);
    expect(logout.status).toBe(204);
    expect(store.validate(token)).toBe(false);
    const rawLogout = logout.headers["set-cookie"];
    const logoutCookies = Array.isArray(rawLogout)
      ? rawLogout
      : rawLogout
        ? [rawLogout as unknown as string]
        : [];
    expect(logoutCookies[0]).toMatch(/claudemcp_session=;/);
    expect(logoutCookies[0]).toMatch(/Max-Age=0/);
  });

  it("is a no-op when called without a cookie", async () => {
    const { app } = buildApp({ apiKey: "secret", uiAssetDir: fixture.dir });
    const res = await request(app).delete("/admin/ui/session");
    expect(res.status).toBe(204);
  });
});

describe("createAdminUiHandler — expired session contract", () => {
  it("SessionStore.validate returns false past TTL — the handler relies on this", async () => {
    const store = new SessionStore({ ttlMs: 10 });
    const token = store.issue();
    expect(store.validate(token)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.validate(token)).toBe(false);
  });
});

describe("readSessionCookie()", () => {
  it("reads from req.cookies populated by cookie-parser", () => {
    const fakeReq = {
      cookies: { claudemcp_session: "abc123" },
      headers: {}
    } as unknown as express.Request;
    expect(readSessionCookie(fakeReq)).toBe("abc123");
  });

  it("falls back to manual cookie header parsing", () => {
    const fakeReq = {
      headers: { cookie: "foo=bar; claudemcp_session=xyz; baz=qux" }
    } as unknown as express.Request;
    expect(readSessionCookie(fakeReq)).toBe("xyz");
  });

  it("returns undefined when no cookie present", () => {
    const fakeReq = { headers: {} } as unknown as express.Request;
    expect(readSessionCookie(fakeReq)).toBeUndefined();
  });
});
