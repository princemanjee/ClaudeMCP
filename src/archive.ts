import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

// Schema version: 1.
//
// This schema is applied idempotently via CREATE TABLE IF NOT EXISTS and
// CREATE INDEX IF NOT EXISTS. There is no automatic migration path — if you
// change the schema, existing databases will silently retain the old shape.
// To reset: delete the dbPath file (default data/archive.sqlite) and let the
// next process startup recreate it. Plan 05 writers must not assume any
// column they add here will be present on databases created by earlier
// versions of the code.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS entries (
  id              INTEGER PRIMARY KEY,
  request_hash    TEXT NOT NULL,
  log_id          TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  backend         TEXT NOT NULL,
  model_resolved  TEXT,
  session_id      TEXT,
  timestamp       TEXT NOT NULL,
  status          TEXT NOT NULL,
  duration_ms     INTEGER,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  request_body    BLOB NOT NULL,
  response_body   BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hash    ON entries(request_hash);
CREATE INDEX IF NOT EXISTS idx_time    ON entries(timestamp);
CREATE INDEX IF NOT EXISTS idx_session ON entries(session_id);
CREATE INDEX IF NOT EXISTS idx_backend ON entries(backend);
`;

// ---- Public types -------------------------------------------------------

export type ArchiveStatus = "ok" | "error" | "timeout";

export interface ArchiveEntry {
  requestHash: string;
  logId: string;
  endpoint: string;
  backend: string;
  modelResolved: string | null;
  sessionId: string | null;
  timestamp: string; // ISO-8601
  status: ArchiveStatus;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  requestBody: unknown; // JSON-serializable
  responseBody: unknown; // JSON-serializable
}

export interface StoredArchiveEntry extends ArchiveEntry {
  id: number;
}

export interface ArchiveListFilters {
  limit: number;
  offset: number;
  backend?: string;
  sessionId?: string;
  model?: string;
  since?: string; // ISO-8601 inclusive lower bound
  until?: string; // ISO-8601 exclusive upper bound
  status?: ArchiveStatus;
}

export interface ArchivePage {
  data: StoredArchiveEntry[];
  has_more: boolean;
}

interface RawEntryRow {
  id: number;
  request_hash: string;
  log_id: string;
  endpoint: string;
  backend: string;
  model_resolved: string | null;
  session_id: string | null;
  timestamp: string;
  status: ArchiveStatus;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  request_body: Buffer;
  response_body: Buffer;
}

export class Archive {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    const mode = this.db.pragma("journal_mode = WAL", { simple: true }) as string;
    if (mode !== "wal") {
      this.db.close();
      throw new Error(`Archive: expected WAL journal mode, got "${mode}"`);
    }
    this.db.exec(SCHEMA_SQL);

    this.insertStmt = this.db.prepare(`
      INSERT INTO entries (
        request_hash, log_id, endpoint, backend, model_resolved,
        session_id, timestamp, status, duration_ms,
        input_tokens, output_tokens, request_body, response_body
      ) VALUES (
        @requestHash, @logId, @endpoint, @backend, @modelResolved,
        @sessionId, @timestamp, @status, @durationMs,
        @inputTokens, @outputTokens, @requestBody, @responseBody
      )
    `);
    this.getByIdStmt = this.db.prepare("SELECT * FROM entries WHERE id = ?");
  }

  /**
   * Direct database handle. Prefer the typed methods (`recordEntry`, `getById`,
   * `list`, `searchText`, `deleteOlderThan`, `deleteBySession`) over this
   * escape hatch — they handle compression and column mapping for you. The
   * raw handle is exposed for ad-hoc operator queries and future tooling that
   * hasn't found its way into the typed surface yet.
   */
  raw(): Database.Database {
    return this.db;
  }

  recordEntry(entry: ArchiveEntry): number {
    const requestBlob = zstdCompressSync(
      Buffer.from(JSON.stringify(entry.requestBody))
    );
    const responseBlob = zstdCompressSync(
      Buffer.from(JSON.stringify(entry.responseBody))
    );
    const info = this.insertStmt.run({
      requestHash: entry.requestHash,
      logId: entry.logId,
      endpoint: entry.endpoint,
      backend: entry.backend,
      modelResolved: entry.modelResolved,
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      status: entry.status,
      durationMs: entry.durationMs,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      requestBody: requestBlob,
      responseBody: responseBlob
    });
    return Number(info.lastInsertRowid);
  }

  getById(id: number): StoredArchiveEntry | undefined {
    const row = this.getByIdStmt.get(id) as RawEntryRow | undefined;
    if (!row) return undefined;
    return this.hydrateRow(row);
  }

  close(): void {
    this.db.close();
  }

  // ---- Internal helpers --------------------------------------------------

  private hydrateRow(row: RawEntryRow): StoredArchiveEntry {
    return {
      id: row.id,
      requestHash: row.request_hash,
      logId: row.log_id,
      endpoint: row.endpoint,
      backend: row.backend,
      modelResolved: row.model_resolved,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      status: row.status,
      durationMs: row.duration_ms,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      requestBody: JSON.parse(zstdDecompressSync(row.request_body).toString("utf8")),
      responseBody: JSON.parse(zstdDecompressSync(row.response_body).toString("utf8"))
    };
  }
}
