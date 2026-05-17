import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { bindLocalhostMiddleware } from "../../../src/admin/bindLocalhost.js";

function buildApp(getEnabled: () => boolean, trustProxy = false): express.Express {
  const app = express();
  if (trustProxy) app.set("trust proxy", true);
  app.use(bindLocalhostMiddleware(getEnabled));
  app.get("/probe", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe("bindLocalhostMiddleware — disabled", () => {
  it("passes every request through when getEnabled() returns false", async () => {
    const res = await request(buildApp(() => false))
      .get("/probe")
      .set("X-Forwarded-For", "10.0.0.5");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("bindLocalhostMiddleware — enabled", () => {
  it("accepts 127.0.0.1 (the supertest default)", async () => {
    const res = await request(buildApp(() => true)).get("/probe");
    expect(res.status).toBe(200);
  });

  it("rejects a request whose forwarded ip is 127.0.0.2", async () => {
    const app = buildApp(() => true, true);
    const res = await request(app)
      .get("/probe")
      .set("X-Forwarded-For", "127.0.0.2");
    expect(res.status).toBe(403);
    expect(res.body.type).toBe("error");
    expect(res.body.error.type).toBe("authentication_error");
    expect(res.body.error.message).toMatch(/localhost/i);
  });

  it("rejects a request whose forwarded ip is 10.0.0.5", async () => {
    const app = buildApp(() => true, true);
    const res = await request(app)
      .get("/probe")
      .set("X-Forwarded-For", "10.0.0.5");
    expect(res.status).toBe(403);
  });

  it("rejects a request whose forwarded ip is 192.168.1.20", async () => {
    const app = buildApp(() => true, true);
    const res = await request(app)
      .get("/probe")
      .set("X-Forwarded-For", "192.168.1.20");
    expect(res.status).toBe(403);
  });

  it("accepts ::1", async () => {
    // Supertest's underlying superagent does not let us spoof req.ip directly
    // without trust-proxy + X-Forwarded-For. Use the forwarded variant.
    const app = buildApp(() => true, true);
    const res = await request(app)
      .get("/probe")
      .set("X-Forwarded-For", "::1");
    expect(res.status).toBe(200);
  });

  it("accepts ::ffff:127.0.0.1 (IPv4-mapped IPv6)", async () => {
    const app = buildApp(() => true, true);
    const res = await request(app)
      .get("/probe")
      .set("X-Forwarded-For", "::ffff:127.0.0.1");
    expect(res.status).toBe(200);
  });

  it("re-evaluates getEnabled() per request (toggle without reconstruction)", async () => {
    let enabled = true;
    const app = buildApp(() => enabled, true);
    const blocked = await request(app)
      .get("/probe")
      .set("X-Forwarded-For", "10.0.0.5");
    expect(blocked.status).toBe(403);
    enabled = false;
    const allowed = await request(app)
      .get("/probe")
      .set("X-Forwarded-For", "10.0.0.5");
    expect(allowed.status).toBe(200);
  });
});
