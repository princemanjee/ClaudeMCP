import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFilesHandlers } from "../../../src/geminiShim/files.js";
import { FileStore } from "../../../src/fileStore.js";

let dir: string;
let store: FileStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudemcp-gfiles-"));
  store = new FileStore({
    dir,
    ttlMs: 60_000,
    maxTotalBytes: 1_000_000,
    sweepIntervalMs: 0
  });
});

afterEach(() => {
  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

function buildApp(apiKey: string): express.Express {
  const handlers = createFilesHandlers({
    fileStore: store,
    config: { apiKey }
  });
  const app = express();
  app.post("/v1beta/files", handlers.upload);
  app.get("/v1beta/files", handlers.list);
  // Mount the :id[:]download route BEFORE the bare :id route — the bare route
  // is greedy and otherwise swallows the `:download` suffix in its param.
  app.get("/v1beta/files/:id[:]download", handlers.download);
  app.get("/v1beta/files/:id", handlers.getMetadata);
  app.delete("/v1beta/files/:id", handlers.delete);
  return app;
}

describe("Gemini /v1beta/files — upload", () => {
  it("returns 401 on missing auth", async () => {
    const app = buildApp("sk-test");
    const res = await request(app)
      .post("/v1beta/files")
      .attach("file", Buffer.from("hi"), { filename: "h.txt", contentType: "text/plain" });
    expect(res.status).toBe(401);
  });

  it("returns GeminiFileResource with name: files/<24hex>", async () => {
    const app = buildApp("sk-test");
    const res = await request(app)
      .post("/v1beta/files")
      .set("x-goog-api-key", "sk-test")
      .attach("file", Buffer.from("hi"), { filename: "h.txt", contentType: "text/plain" });
    expect(res.status).toBe(200);
    expect(res.body.file.name).toMatch(/^files\/[0-9a-f]{24}$/);
    expect(res.body.file.mimeType).toBe("text/plain");
    expect(res.body.file.displayName).toBe("h.txt");
    expect(res.body.file.state).toBe("ACTIVE");
  });

  it("uri field points at :download", async () => {
    const app = buildApp("sk-test");
    const res = await request(app)
      .post("/v1beta/files")
      .set("x-goog-api-key", "sk-test")
      .attach("file", Buffer.from("payload"), { filename: "p.txt", contentType: "text/plain" });
    expect(res.body.file.uri).toContain(":download");
    expect(res.body.file.uri).toContain(res.body.file.name);
  });
});

describe("Gemini /v1beta/files — list", () => {
  it("returns 401 on missing auth", async () => {
    const app = buildApp("sk-test");
    const res = await request(app).get("/v1beta/files");
    expect(res.status).toBe(401);
  });

  it("returns {files: [...]} happy path", async () => {
    const app = buildApp("sk-test");
    await store.upload(Buffer.from("a"), "a.txt", "text/plain");
    await store.upload(Buffer.from("b"), "b.txt", "text/plain");
    const res = await request(app).get("/v1beta/files").set("x-goog-api-key", "sk-test");
    expect(res.status).toBe(200);
    expect(res.body.files.length).toBe(2);
  });

  it("pagination advances offset on pageToken", async () => {
    const app = buildApp("sk-test");
    for (let i = 0; i < 5; i++) {
      await store.upload(Buffer.from(`data-${i}`), `f${i}.txt`, "text/plain");
    }
    const first = await request(app)
      .get("/v1beta/files?pageSize=2")
      .set("x-goog-api-key", "sk-test");
    expect(first.body.files.length).toBe(2);
    expect(first.body.nextPageToken).toBeDefined();

    const second = await request(app)
      .get(`/v1beta/files?pageSize=2&pageToken=${first.body.nextPageToken}`)
      .set("x-goog-api-key", "sk-test");
    expect(second.body.files.length).toBe(2);
    // Different files than the first page
    expect(second.body.files[0].name).not.toBe(first.body.files[0].name);
  });
});

describe("Gemini /v1beta/files/:id — metadata", () => {
  it("returns 401 on missing auth", async () => {
    const app = buildApp("sk-test");
    const res = await request(app).get("/v1beta/files/aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(res.status).toBe(401);
  });

  it("returns GeminiFileResource on a known file", async () => {
    const app = buildApp("sk-test");
    const meta = await store.upload(Buffer.from("hi"), "h.txt", "text/plain");
    const hash = meta.id.slice("file_".length);
    const res = await request(app)
      .get(`/v1beta/files/${hash}`)
      .set("x-goog-api-key", "sk-test");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(`files/${hash}`);
    expect(res.body.mimeType).toBe("text/plain");
  });

  it("returns 404 on unknown id", async () => {
    const app = buildApp("sk-test");
    const res = await request(app)
      .get("/v1beta/files/aaaaaaaaaaaaaaaaaaaaaaaa")
      .set("x-goog-api-key", "sk-test");
    expect(res.status).toBe(404);
  });
});

describe("Gemini /v1beta/files/:id:download — download", () => {
  it("returns 401 on missing auth", async () => {
    const app = buildApp("sk-test");
    const res = await request(app).get(
      "/v1beta/files/aaaaaaaaaaaaaaaaaaaaaaaa:download"
    );
    expect(res.status).toBe(401);
  });

  it("returns the original bytes with the upload's Content-Type", async () => {
    const app = buildApp("sk-test");
    const bytes = Buffer.from("hello-payload");
    const meta = await store.upload(bytes, "h.txt", "text/plain");
    const hash = meta.id.slice("file_".length);
    const res = await request(app)
      .get(`/v1beta/files/${hash}:download`)
      .set("x-goog-api-key", "sk-test")
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect((res.body as Buffer).toString("utf8")).toBe("hello-payload");
  });
});

describe("Gemini /v1beta/files/:id — delete", () => {
  it("returns 401 on missing auth", async () => {
    const app = buildApp("sk-test");
    const res = await request(app).delete("/v1beta/files/aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(res.status).toBe(401);
  });

  it("deletes the file (subsequent GET returns 404)", async () => {
    const app = buildApp("sk-test");
    const meta = await store.upload(Buffer.from("hi"), "h.txt", "text/plain");
    const hash = meta.id.slice("file_".length);
    const del = await request(app)
      .delete(`/v1beta/files/${hash}`)
      .set("x-goog-api-key", "sk-test");
    expect(del.status).toBe(200);
    const get = await request(app)
      .get(`/v1beta/files/${hash}`)
      .set("x-goog-api-key", "sk-test");
    expect(get.status).toBe(404);
  });
});

describe("Gemini /v1beta/files — cross-shim ID acceptance", () => {
  it("accepts file_<hash> form (Anthropic format) on GET", async () => {
    const app = buildApp("sk-test");
    const meta = await store.upload(Buffer.from("payload"), "h.txt", "text/plain");
    const hash = meta.id.slice("file_".length);

    // Hit it with the bare hash (Gemini style)
    const geminiRes = await request(app)
      .get(`/v1beta/files/${hash}`)
      .set("x-goog-api-key", "sk-test");
    expect(geminiRes.status).toBe(200);

    // Hit it with file_<hash> (Anthropic style)
    const anthRes = await request(app)
      .get(`/v1beta/files/${meta.id}`)
      .set("x-goog-api-key", "sk-test");
    expect(anthRes.status).toBe(200);
    expect(anthRes.body.name).toBe(geminiRes.body.name);
  });
});
