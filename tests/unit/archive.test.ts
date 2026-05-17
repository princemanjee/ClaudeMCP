import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Archive } from "../../src/archive.js";

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
});
