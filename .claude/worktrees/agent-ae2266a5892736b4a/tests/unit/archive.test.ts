import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Archive, type ArchiveEntry } from "../../src/archive.js";

describe("Archive schema management", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-arc-"));
    dbPath = join(dir, "archive.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the entries table on first open", () => {
    const archive = new Archive(dbPath);
    archive.close();

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='entries'"
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("entries");
    db.close();
  });

  it("creates all expected indexes", () => {
    const archive = new Archive(dbPath);
    archive.close();

    const db = new Database(dbPath, { readonly: true });
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='entries' ORDER BY name"
      )
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_hash");
    expect(names).toContain("idx_time");
    expect(names).toContain("idx_session");
    expect(names).toContain("idx_backend");
    db.close();
  });

  it("is idempotent on reopen", () => {
    new Archive(dbPath).close();
    new Archive(dbPath).close(); // must not throw
    const db = new Database(dbPath, { readonly: true });
    const count = db
      .prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='entries'"
      )
      .get() as { c: number };
    expect(count.c).toBe(1);
    db.close();
  });

  it("schema columns match the spec", () => {
    const archive = new Archive(dbPath);
    archive.close();

    const db = new Database(dbPath, { readonly: true });
    const cols = db
      .prepare("PRAGMA table_info(entries)")
      .all() as { name: string; type: string; notnull: number }[];
    const colMap = new Map(cols.map((c) => [c.name, c]));

    for (const required of [
      "id",
      "request_hash",
      "log_id",
      "endpoint",
      "backend",
      "model_resolved",
      "session_id",
      "timestamp",
      "status",
      "duration_ms",
      "input_tokens",
      "output_tokens",
      "request_body",
      "response_body"
    ]) {
      expect(colMap.has(required), `missing column ${required}`).toBe(true);
    }

    expect(colMap.get("backend")?.notnull).toBe(1);
    expect(colMap.get("request_body")?.type.toUpperCase()).toBe("BLOB");
    db.close();
  });

  it("creates parent directory if missing", () => {
    const nested = join(dir, "nested", "deeper", "archive.sqlite");
    new Archive(nested).close();
    expect(() => new Database(nested, { readonly: true }).close()).not.toThrow();
  });

  it("WAL mode pragma succeeded (smoke check)", () => {
    const archive = new Archive(dbPath);
    archive.close();

    const db = new Database(dbPath, { readonly: true });
    const mode = db.pragma("journal_mode", { simple: true }) as string;
    expect(mode).toBe("wal");
    db.close();
  });
});

describe("Archive.recordEntry — typed writer", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-arc-w-"));
    dbPath = join(dir, "archive.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function sampleEntry(overrides: Partial<ArchiveEntry> = {}): ArchiveEntry {
    return {
      requestHash: "h".repeat(64),
      logId: "log_abc",
      endpoint: "/v1/messages",
      backend: "claude",
      modelResolved: "claude-sonnet-4-6",
      sessionId: null,
      timestamp: new Date().toISOString(),
      status: "ok",
      durationMs: 123,
      inputTokens: 10,
      outputTokens: 20,
      requestBody: { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] },
      responseBody: { id: "msg_test", content: [{ type: "text", text: "hello" }] },
      ...overrides
    };
  }

  it("recordEntry inserts a row and returns its id", () => {
    const archive = new Archive(dbPath);
    try {
      const id = archive.recordEntry(sampleEntry());
      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
    } finally {
      archive.close();
    }
  });

  it("recordEntry zstd-compresses request_body so it round-trips", () => {
    const archive = new Archive(dbPath);
    try {
      const id = archive.recordEntry(sampleEntry());
      const row = archive.getById(id);
      expect(row?.requestBody).toEqual({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }]
      });
      expect(row?.responseBody).toEqual({
        id: "msg_test",
        content: [{ type: "text", text: "hello" }]
      });
    } finally {
      archive.close();
    }
  });

  it("recordEntry honors nullable sessionId / modelResolved", () => {
    const archive = new Archive(dbPath);
    try {
      const id = archive.recordEntry(sampleEntry({ sessionId: null, modelResolved: null }));
      const row = archive.getById(id);
      expect(row?.sessionId).toBeNull();
      expect(row?.modelResolved).toBeNull();
    } finally {
      archive.close();
    }
  });

  it("recordEntry handles 'error' status entries (debugging value)", () => {
    const archive = new Archive(dbPath);
    try {
      const id = archive.recordEntry(
        sampleEntry({
          status: "error",
          responseBody: { type: "error", error: { type: "api_error", message: "boom" } }
        })
      );
      const row = archive.getById(id);
      expect(row?.status).toBe("error");
      expect(row?.responseBody).toEqual({
        type: "error",
        error: { type: "api_error", message: "boom" }
      });
    } finally {
      archive.close();
    }
  });

  it("concurrent inserts are serialized cleanly", () => {
    const archive = new Archive(dbPath);
    try {
      const ids: number[] = [];
      for (let i = 0; i < 20; i++) {
        ids.push(archive.recordEntry(sampleEntry({ logId: `log_${i}` })));
      }
      expect(new Set(ids).size).toBe(20);
    } finally {
      archive.close();
    }
  });
});

describe("Archive — query + prune", () => {
  let dir: string;
  let dbPath: string;
  let archive: Archive;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-arc-q-"));
    dbPath = join(dir, "archive.sqlite");
    archive = new Archive(dbPath);
  });

  afterEach(() => {
    archive.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(): { ids: number[] } {
    const ids: number[] = [];
    ids.push(
      archive.recordEntry({
        requestHash: "a".repeat(64),
        logId: "log_a",
        endpoint: "/v1/messages",
        backend: "claude",
        modelResolved: "claude-sonnet-4-6",
        sessionId: "s_one",
        timestamp: "2026-05-10T00:00:00Z",
        status: "ok",
        durationMs: 100,
        inputTokens: 1,
        outputTokens: 1,
        requestBody: { messages: [{ role: "user", content: "hello world" }] },
        responseBody: { id: "msg_a" }
      })
    );
    ids.push(
      archive.recordEntry({
        requestHash: "b".repeat(64),
        logId: "log_b",
        endpoint: "/v1/messages",
        backend: "gemini",
        modelResolved: "gemini-pro",
        sessionId: "s_two",
        timestamp: "2026-05-15T00:00:00Z",
        status: "ok",
        durationMs: 200,
        inputTokens: 2,
        outputTokens: 2,
        requestBody: { messages: [{ role: "user", content: "another prompt" }] },
        responseBody: { id: "msg_b" }
      })
    );
    return { ids };
  }

  it("list() returns entries with pagination, newest first", () => {
    seed();
    const page = archive.list({ limit: 10, offset: 0 });
    expect(page.data.map((e) => e.logId)).toEqual(["log_b", "log_a"]);
    expect(page.has_more).toBe(false);
  });

  it("list() filters by backend", () => {
    seed();
    const onlyGemini = archive.list({ limit: 10, offset: 0, backend: "gemini" });
    expect(onlyGemini.data.map((e) => e.logId)).toEqual(["log_b"]);
  });

  it("list() filters by session", () => {
    seed();
    const sOne = archive.list({ limit: 10, offset: 0, sessionId: "s_one" });
    expect(sOne.data.map((e) => e.logId)).toEqual(["log_a"]);
  });

  it("list() filters by since / until", () => {
    seed();
    const recent = archive.list({
      limit: 10,
      offset: 0,
      since: "2026-05-12T00:00:00Z"
    });
    expect(recent.data.map((e) => e.logId)).toEqual(["log_b"]);
    const old = archive.list({ limit: 10, offset: 0, until: "2026-05-12T00:00:00Z" });
    expect(old.data.map((e) => e.logId)).toEqual(["log_a"]);
  });

  it("searchText() finds substring hits in the decompressed request body", () => {
    seed();
    const hits = archive.searchText("hello world", { limit: 10, offset: 0 });
    expect(hits.data.map((e) => e.logId)).toEqual(["log_a"]);
  });

  it("searchText() returns empty page when no hits", () => {
    seed();
    const hits = archive.searchText("nothing-matches", { limit: 10, offset: 0 });
    expect(hits.data).toEqual([]);
    expect(hits.has_more).toBe(false);
  });

  it("deleteOlderThan() drops entries with timestamp < cutoff", () => {
    seed();
    const removed = archive.deleteOlderThan("2026-05-12T00:00:00Z");
    expect(removed).toBe(1);
    const remaining = archive.list({ limit: 10, offset: 0 });
    expect(remaining.data.map((e) => e.logId)).toEqual(["log_b"]);
  });

  it("deleteBySession() drops entries matching the session id", () => {
    seed();
    const removed = archive.deleteBySession("s_one");
    expect(removed).toBe(1);
    const remaining = archive.list({ limit: 10, offset: 0 });
    expect(remaining.data.map((e) => e.logId)).toEqual(["log_b"]);
  });
});
