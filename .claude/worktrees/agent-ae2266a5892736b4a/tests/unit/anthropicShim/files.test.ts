import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";
import { FileStore } from "../../../src/fileStore.js";
import { createFilesHandlers } from "../../../src/anthropicShim/files.js";

function buildApp(): { app: express.Express; store: FileStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "claudemcp-files-h-"));
  const store = new FileStore({
    dir,
    ttlMs: 60_000,
    maxTotalBytes: 10_000_000,
    sweepIntervalMs: 0
  });
  const app = express();
  const handlers = createFilesHandlers({
    fileStore: store,
    config: { apiKey: "sk-test" }
  });
  app.post("/v1/files", handlers.upload);
  app.get("/v1/files", handlers.list);
  app.get("/v1/files/:id", handlers.getMetadata);
  app.get("/v1/files/:id/content", handlers.download);
  app.delete("/v1/files/:id", handlers.delete);
  return {
    app,
    store,
    cleanup: () => {
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("POST /v1/files — multipart upload", () => {
  it("rejects missing auth with 401", async () => {
    const { app, cleanup } = buildApp();
    try {
      const res = await request(app)
        .post("/v1/files")
        .attach("file", Buffer.from("body"), {
          filename: "f.txt",
          contentType: "text/plain"
        });
      expect(res.status).toBe(401);
      expect(res.body.error.type).toBe("authentication_error");
    } finally {
      cleanup();
    }
  });

  it("accepts a valid multipart upload and returns the file id", async () => {
    const { app, cleanup } = buildApp();
    try {
      const res = await request(app)
        .post("/v1/files")
        .set("x-api-key", "sk-test")
        .attach("file", Buffer.from("hello"), {
          filename: "greeting.txt",
          contentType: "text/plain"
        });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        type: "file",
        filename: "greeting.txt",
        mime_type: "text/plain",
        size_bytes: 5
      });
      expect(res.body.id).toMatch(/^file_[0-9a-f]{24}$/);
    } finally {
      cleanup();
    }
  });

  it("dedup: uploading the same bytes twice returns the same id", async () => {
    const { app, cleanup } = buildApp();
    try {
      const a = await request(app)
        .post("/v1/files")
        .set("x-api-key", "sk-test")
        .attach("file", Buffer.from("same"), { filename: "a.txt", contentType: "text/plain" });
      const b = await request(app)
        .post("/v1/files")
        .set("x-api-key", "sk-test")
        .attach("file", Buffer.from("same"), { filename: "b.txt", contentType: "text/plain" });
      expect(a.body.id).toBe(b.body.id);
    } finally {
      cleanup();
    }
  });

  it("returns 400 on a non-multipart request", async () => {
    const { app, cleanup } = buildApp();
    try {
      const res = await request(app)
        .post("/v1/files")
        .set("x-api-key", "sk-test")
        .set("content-type", "application/json")
        .send({ not: "multipart" });
      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe("invalid_request_error");
    } finally {
      cleanup();
    }
  });
});

describe("GET /v1/files — list with pagination", () => {
  it("returns has_more=false for a small list", async () => {
    const { app, store, cleanup } = buildApp();
    try {
      await store.upload(Buffer.from("a"), "a.txt", "text/plain");
      await store.upload(Buffer.from("b"), "b.txt", "text/plain");
      const res = await request(app).get("/v1/files").set("x-api-key", "sk-test");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.has_more).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("honors limit and offset", async () => {
    const { app, store, cleanup } = buildApp();
    try {
      for (const c of ["a", "b", "c"]) {
        await store.upload(Buffer.from(c), `${c}.txt`, "text/plain");
      }
      const res = await request(app)
        .get("/v1/files?limit=1&offset=1")
        .set("x-api-key", "sk-test");
      expect(res.body.data).toHaveLength(1);
      expect(res.body.has_more).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("GET /v1/files/{id} — metadata", () => {
  it("returns metadata envelope on a known id", async () => {
    const { app, store, cleanup } = buildApp();
    try {
      const stored = await store.upload(Buffer.from("meta"), "m.txt", "text/plain");
      const res = await request(app)
        .get(`/v1/files/${stored.id}`)
        .set("x-api-key", "sk-test");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(stored.id);
      expect(res.body.type).toBe("file");
    } finally {
      cleanup();
    }
  });

  it("returns 404 on an unknown id", async () => {
    const { app, cleanup } = buildApp();
    try {
      const res = await request(app)
        .get("/v1/files/file_000000000000000000000000")
        .set("x-api-key", "sk-test");
      expect(res.status).toBe(404);
    } finally {
      cleanup();
    }
  });
});

describe("GET /v1/files/{id}/content — download", () => {
  it("returns the raw bytes with the recorded mime type", async () => {
    const { app, store, cleanup } = buildApp();
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const stored = await store.upload(png, "x.png", "image/png");
      const res = await request(app)
        .get(`/v1/files/${stored.id}/content`)
        .set("x-api-key", "sk-test");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/image\/png/);
      expect(Buffer.compare(res.body, png)).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("DELETE /v1/files/{id}", () => {
  it("removes the file and returns the Anthropic-shaped delete envelope", async () => {
    const { app, store, cleanup } = buildApp();
    try {
      const stored = await store.upload(Buffer.from("bye"), "b.txt", "text/plain");
      const res = await request(app)
        .delete(`/v1/files/${stored.id}`)
        .set("x-api-key", "sk-test");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: stored.id, type: "file_deleted" });
      const after = await request(app)
        .get(`/v1/files/${stored.id}`)
        .set("x-api-key", "sk-test");
      expect(after.status).toBe(404);
    } finally {
      cleanup();
    }
  });
});
