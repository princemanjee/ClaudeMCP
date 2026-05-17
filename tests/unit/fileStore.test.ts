import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileStore, FileNotFoundError } from "../../src/fileStore.js";

describe("FileStore — upload + dedup", () => {
  let dir: string;
  let store: FileStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-fs-"));
    store = new FileStore({
      dir,
      ttlMs: 60_000,
      maxTotalBytes: 1_000_000,
      sweepIntervalMs: 0
    });
  });

  afterEach(() => {
    store.stop?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a file_ id keyed on SHA-256 of bytes", async () => {
    const bytes = Buffer.from("hello world");
    const meta = await store.upload(bytes, "greeting.txt", "text/plain");
    expect(meta.id).toMatch(/^file_[0-9a-f]{24}$/);
    expect(meta.filename).toBe("greeting.txt");
    expect(meta.mime).toBe("text/plain");
    expect(meta.size).toBe(bytes.length);
    expect(typeof meta.createdAt).toBe("string");
  });

  it("returns the same id for identical bytes (dedup)", async () => {
    const a = await store.upload(Buffer.from("dup"), "first.txt", "text/plain");
    const b = await store.upload(Buffer.from("dup"), "second.txt", "text/plain");
    expect(a.id).toBe(b.id);
    // First-write wins for filename.
    expect(b.filename).toBe("first.txt");
  });

  it("persists bytes and sidecar JSON to dir", async () => {
    const meta = await store.upload(
      Buffer.from("payload"),
      "p.bin",
      "application/octet-stream"
    );
    const hash = meta.id.slice("file_".length);
    expect(existsSync(join(dir, hash))).toBe(true);
    expect(existsSync(join(dir, `${hash}.json`))).toBe(true);
    const sidecar = JSON.parse(readFileSync(join(dir, `${hash}.json`), "utf8"));
    expect(sidecar.id).toBe(meta.id);
    expect(sidecar.size).toBe(7);
  });
});

describe("FileStore — get + list + delete", () => {
  let dir: string;
  let store: FileStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-fs-"));
    store = new FileStore({
      dir,
      ttlMs: 60_000,
      maxTotalBytes: 1_000_000,
      sweepIntervalMs: 0
    });
  });

  afterEach(() => {
    store.stop?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("get() returns bytes + metadata for a known id", async () => {
    const stored = await store.upload(Buffer.from("body"), "f.txt", "text/plain");
    const fetched = await store.get(stored.id);
    expect(fetched.bytes.equals(Buffer.from("body"))).toBe(true);
    expect(fetched.metadata.id).toBe(stored.id);
  });

  it("get() throws FileNotFoundError on unknown id", async () => {
    await expect(store.get("file_000000000000000000000000")).rejects.toBeInstanceOf(
      FileNotFoundError
    );
  });

  it("get() bumps lastAccessedAt", async () => {
    const stored = await store.upload(Buffer.from("touch"), "t.txt", "text/plain");
    const before = stored.lastAccessedAt;
    await new Promise((r) => setTimeout(r, 10));
    await store.get(stored.id);
    const after = (await store.get(stored.id)).metadata.lastAccessedAt;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime()
    );
  });

  it("list() returns entries with limit/offset pagination, newest first", async () => {
    const a = await store.upload(Buffer.from("a"), "a.txt", "text/plain");
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.upload(Buffer.from("b"), "b.txt", "text/plain");
    await new Promise((r) => setTimeout(r, 5));
    const c = await store.upload(Buffer.from("c"), "c.txt", "text/plain");

    const all = await store.list({ limit: 10, offset: 0 });
    expect(all.data.map((e) => e.id)).toEqual([c.id, b.id, a.id]);
    expect(all.has_more).toBe(false);

    const page1 = await store.list({ limit: 2, offset: 0 });
    expect(page1.data.map((e) => e.id)).toEqual([c.id, b.id]);
    expect(page1.has_more).toBe(true);

    const page2 = await store.list({ limit: 2, offset: 2 });
    expect(page2.data.map((e) => e.id)).toEqual([a.id]);
    expect(page2.has_more).toBe(false);
  });

  it("delete() removes the bytes and the sidecar", async () => {
    const stored = await store.upload(Buffer.from("bye"), "b.txt", "text/plain");
    await store.delete(stored.id);
    const hash = stored.id.slice("file_".length);
    expect(existsSync(join(dir, hash))).toBe(false);
    expect(existsSync(join(dir, `${hash}.json`))).toBe(false);
    await expect(store.get(stored.id)).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("delete() is idempotent (no throw on second call)", async () => {
    const stored = await store.upload(Buffer.from("bye"), "b.txt", "text/plain");
    await store.delete(stored.id);
    await expect(store.delete(stored.id)).resolves.toBeUndefined();
  });
});

describe("FileStore — resolveForInline", () => {
  let dir: string;
  let store: FileStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-fs-"));
    store = new FileStore({
      dir,
      ttlMs: 60_000,
      maxTotalBytes: 1_000_000,
      sweepIntervalMs: 0
    });
  });

  afterEach(() => {
    store.stop?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces a normalized image content block when mime is image/*", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const stored = await store.upload(png, "x.png", "image/png");
    const block = await store.resolveForInline(stored.id, "image");
    expect(block).toEqual({
      type: "image",
      mediaType: "image/png",
      data: png.toString("base64")
    });
  });

  it("produces a normalized document content block when mime is application/*", async () => {
    const pdf = Buffer.from("%PDF-1.4\n%fake");
    const stored = await store.upload(pdf, "x.pdf", "application/pdf");
    const block = await store.resolveForInline(stored.id, "document");
    expect(block).toEqual({
      type: "document",
      mediaType: "application/pdf",
      data: pdf.toString("base64")
    });
  });

  it("throws FileNotFoundError when the id is unknown", async () => {
    await expect(
      store.resolveForInline("file_aaaaaaaaaaaaaaaaaaaaaaaa", "image")
    ).rejects.toBeInstanceOf(FileNotFoundError);
  });
});

describe("FileStore — eviction", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-fs-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("TTL sweep removes entries whose lastAccessedAt is older than ttlMs", async () => {
    const store = new FileStore({
      dir,
      ttlMs: 50,
      maxTotalBytes: 10_000_000,
      sweepIntervalMs: 0
    });
    const stored = await store.upload(Buffer.from("aged"), "a.txt", "text/plain");
    await new Promise((r) => setTimeout(r, 80));
    store.runEviction();
    await expect(store.get(stored.id)).rejects.toBeInstanceOf(FileNotFoundError);
    store.stop();
  });

  it("LRU pass evicts oldest-accessed entries when total size exceeds cap", async () => {
    const store = new FileStore({
      dir,
      ttlMs: 60_000,
      maxTotalBytes: 6, // tiny cap so 2-byte uploads trip eviction
      sweepIntervalMs: 0
    });
    const a = await store.upload(Buffer.from("aa"), "a", "text/plain");
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.upload(Buffer.from("bb"), "b", "text/plain");
    await new Promise((r) => setTimeout(r, 5));
    const c = await store.upload(Buffer.from("cc"), "c", "text/plain");
    await new Promise((r) => setTimeout(r, 5));
    const d = await store.upload(Buffer.from("dd"), "d", "text/plain");

    store.runEviction();

    // Total 8 bytes > cap 6; LRU evicts oldest (a), leaving 6 bytes — under cap.
    await expect(store.get(a.id)).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(store.get(b.id)).resolves.toBeTruthy();
    await expect(store.get(c.id)).resolves.toBeTruthy();
    await expect(store.get(d.id)).resolves.toBeTruthy();
    store.stop();
  });

  it("TTL pass runs before LRU pass so expired entries don't get re-ranked", async () => {
    const store = new FileStore({
      dir,
      ttlMs: 50,
      maxTotalBytes: 100,
      sweepIntervalMs: 0
    });
    await store.upload(Buffer.from("expired"), "e", "text/plain");
    await new Promise((r) => setTimeout(r, 80));
    const fresh = await store.upload(Buffer.from("fresh"), "f", "text/plain");
    store.runEviction();
    await expect(store.get(fresh.id)).resolves.toBeTruthy();
    store.stop();
  });
});

describe("FileStore — cross-format ID resolution", () => {
  let dir: string;
  let store: FileStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-fs-xfmt-"));
    store = new FileStore({
      dir,
      ttlMs: 24 * 60 * 60 * 1000,
      maxTotalBytes: 10 * 1024 * 1024,
      sweepIntervalMs: 0
    });
  });

  afterEach(() => {
    store.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolveById accepts the Anthropic format (file_<24hex>)", async () => {
    const meta = await store.upload(Buffer.from("hello"), "h.txt", "text/plain");
    const { metadata, bytes } = await store.resolveById(meta.id);
    expect(metadata.id).toBe(meta.id);
    expect(bytes.toString("utf8")).toBe("hello");
  });

  it("resolveById accepts the Gemini format (files/<24hex>) and resolves to the same content", async () => {
    const meta = await store.upload(Buffer.from("hello"), "h.txt", "text/plain");
    const hash = meta.id.slice("file_".length);
    const geminiId = `files/${hash}`;
    const { metadata, bytes } = await store.resolveById(geminiId);
    expect(metadata.id).toBe(meta.id);
    expect(bytes.toString("utf8")).toBe("hello");
  });

  it("resolveById throws FileNotFoundError on a well-formed ID with no backing content", async () => {
    await expect(store.resolveById("files/aaaaaaaaaaaaaaaaaaaaaaaa")).rejects.toBeInstanceOf(
      FileNotFoundError
    );
    await expect(store.resolveById("file_aaaaaaaaaaaaaaaaaaaaaaaa")).rejects.toBeInstanceOf(
      FileNotFoundError
    );
  });

  it("resolveById throws FileNotFoundError on malformed IDs", async () => {
    await expect(store.resolveById("not-an-id")).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(store.resolveById("")).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(store.resolveById("files/")).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(store.resolveById("file_")).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(store.resolveById("file_aaaaaaaaaaaaaaaaaaaaaaa")).rejects.toBeInstanceOf(
      FileNotFoundError
    );
  });

  it("resolveForInline still works with either format (delegates through resolveById)", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const meta = await store.upload(png, "a.png", "image/png");
    const hash = meta.id.slice("file_".length);

    const blockA = await store.resolveForInline(meta.id, "image");
    const blockB = await store.resolveForInline(`files/${hash}`, "image");
    expect(blockA).toEqual(blockB);
  });
});
