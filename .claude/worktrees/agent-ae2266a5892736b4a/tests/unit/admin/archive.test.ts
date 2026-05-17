import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";
import { Archive, type ArchiveEntry } from "../../../src/archive.js";
import { createAdminArchiveHandlers } from "../../../src/admin/archive.js";

function buildApp(archive: Archive): express.Express {
  const app = express();
  const h = createAdminArchiveHandlers({
    archive,
    config: { apiKey: "sk-test" }
  });
  app.get("/admin/archive", h.list);
  app.get("/admin/archive/search", h.search);
  app.get("/admin/archive/:id", h.getById);
  return app;
}

function seedEntry(archive: Archive, override: Partial<ArchiveEntry>): number {
  return archive.recordEntry({
    requestHash: "h".repeat(64),
    logId: "log_x",
    endpoint: "/v1/messages",
    backend: "claude",
    modelResolved: "claude-sonnet-4-6",
    sessionId: null,
    timestamp: new Date().toISOString(),
    status: "ok",
    durationMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    requestBody: { messages: [{ role: "user", content: "default-prompt" }] },
    responseBody: { id: "msg_x" },
    ...override
  });
}

describe("/admin/archive — auth", () => {
  let dir: string;
  let archive: Archive;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-admin-arc-"));
    archive = new Archive(join(dir, "archive.sqlite"));
  });

  afterEach(() => {
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns 401 on missing api key", async () => {
    const res = await request(buildApp(archive)).get("/admin/archive");
    expect(res.status).toBe(401);
  });

  it("returns 401 on wrong api key", async () => {
    const res = await request(buildApp(archive))
      .get("/admin/archive")
      .set("x-api-key", "wrong");
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/archive — list + filters", () => {
  let dir: string;
  let archive: Archive;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-admin-arc-"));
    archive = new Archive(join(dir, "archive.sqlite"));
  });

  afterEach(() => {
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists entries with default pagination", async () => {
    seedEntry(archive, { logId: "a" });
    seedEntry(archive, { logId: "b", backend: "gemini" });
    const res = await request(buildApp(archive))
      .get("/admin/archive")
      .set("x-api-key", "sk-test");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.has_more).toBe(false);
  });

  it("filters by backend", async () => {
    seedEntry(archive, { logId: "a" });
    seedEntry(archive, { logId: "b", backend: "gemini" });
    const res = await request(buildApp(archive))
      .get("/admin/archive?backend=gemini")
      .set("x-api-key", "sk-test");
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].logId).toBe("b");
  });

  it("filters by session + since combined", async () => {
    seedEntry(archive, {
      logId: "old",
      sessionId: "s1",
      timestamp: "2026-05-10T00:00:00Z"
    });
    seedEntry(archive, {
      logId: "new",
      sessionId: "s1",
      timestamp: "2026-05-15T00:00:00Z"
    });
    seedEntry(archive, {
      logId: "other",
      sessionId: "s2",
      timestamp: "2026-05-15T00:00:00Z"
    });
    const res = await request(buildApp(archive))
      .get("/admin/archive?session=s1&since=2026-05-12T00:00:00Z")
      .set("x-api-key", "sk-test");
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].logId).toBe("new");
  });

  it("honors limit + offset", async () => {
    for (const log of ["a", "b", "c", "d"]) seedEntry(archive, { logId: log });
    const res = await request(buildApp(archive))
      .get("/admin/archive?limit=2&offset=1")
      .set("x-api-key", "sk-test");
    expect(res.body.data).toHaveLength(2);
    expect(res.body.has_more).toBe(true);
  });
});

describe("GET /admin/archive/{id}", () => {
  let dir: string;
  let archive: Archive;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-admin-arc-"));
    archive = new Archive(join(dir, "archive.sqlite"));
  });

  afterEach(() => {
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the full decompressed entry", async () => {
    const id = seedEntry(archive, { logId: "g" });
    const res = await request(buildApp(archive))
      .get(`/admin/archive/${id}`)
      .set("x-api-key", "sk-test");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.requestBody).toEqual({
      messages: [{ role: "user", content: "default-prompt" }]
    });
  });

  it("returns 404 on unknown id", async () => {
    const res = await request(buildApp(archive))
      .get("/admin/archive/999999")
      .set("x-api-key", "sk-test");
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/archive/search", () => {
  let dir: string;
  let archive: Archive;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-admin-arc-"));
    archive = new Archive(join(dir, "archive.sqlite"));
  });

  afterEach(() => {
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds the matching entry by substring", async () => {
    seedEntry(archive, {
      logId: "needle",
      requestBody: { messages: [{ role: "user", content: "find me please" }] }
    });
    seedEntry(archive, {
      logId: "noise",
      requestBody: { messages: [{ role: "user", content: "irrelevant" }] }
    });
    const res = await request(buildApp(archive))
      .get("/admin/archive/search?q=find%20me")
      .set("x-api-key", "sk-test");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].logId).toBe("needle");
  });

  it("returns 400 on missing q parameter", async () => {
    const res = await request(buildApp(archive))
      .get("/admin/archive/search")
      .set("x-api-key", "sk-test");
    expect(res.status).toBe(400);
  });
});
