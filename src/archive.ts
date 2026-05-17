import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

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

export interface ArchiveOptions {
  /**
   * zstd compression level (1-22). Defaults to 3 (zstd's default) when omitted.
   * Higher values yield smaller blobs at the cost of more CPU per write.
   */
  compressionLevel?: number;
}

export class Archive {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly compressionLevel: number;

  constructor(dbPath: string, options: ArchiveOptions = {}) {
    this.compressionLevel = options.compressionLevel ?? 3;
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
    const zstdOpts = {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: this.compressionLevel }
    };
    const requestBlob = zstdCompressSync(
      Buffer.from(JSON.stringify(entry.requestBody)),
      zstdOpts
    );
    const responseBlob = zstdCompressSync(
      Buffer.from(JSON.stringify(entry.responseBody)),
      zstdOpts
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

  list(filters: ArchiveListFilters): ArchivePage {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filters.backend) {
      where.push("backend = @backend");
      params.backend = filters.backend;
    }
    if (filters.sessionId) {
      where.push("session_id = @sessionId");
      params.sessionId = filters.sessionId;
    }
    if (filters.model) {
      where.push("model_resolved = @model");
      params.model = filters.model;
    }
    if (filters.status) {
      where.push("status = @status");
      params.status = filters.status;
    }
    if (filters.since) {
      where.push("timestamp >= @since");
      params.since = filters.since;
    }
    if (filters.until) {
      where.push("timestamp < @until");
      params.until = filters.until;
    }
    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // Over-fetch by one to compute has_more without a separate COUNT.
    const stmt = this.db.prepare(
      `SELECT * FROM entries ${whereClause} ORDER BY timestamp DESC LIMIT @limitPlusOne OFFSET @offset`
    );
    const rows = stmt.all({
      ...params,
      limitPlusOne: filters.limit + 1,
      offset: filters.offset
    }) as RawEntryRow[];

    const has_more = rows.length > filters.limit;
    const trimmed = has_more ? rows.slice(0, filters.limit) : rows;
    return {
      data: trimmed.map((r) => this.hydrateRow(r)),
      has_more
    };
  }

  searchText(
    needle: string,
    paging: { limit: number; offset: number }
  ): ArchivePage {
    // Decompress on read; for large archives we may need a content index in
    // a later plan. The spec's open question on FTS5 is deferred — for now
    // we scan, decompress, and filter in memory.
    const all = this.db
      .prepare("SELECT * FROM entries ORDER BY timestamp DESC")
      .all() as RawEntryRow[];
    const hits: StoredArchiveEntry[] = [];
    for (const row of all) {
      const decoded = this.hydrateRow(row);
      const haystack = JSON.stringify(decoded.requestBody);
      if (haystack.includes(needle)) hits.push(decoded);
    }
    const page = hits.slice(paging.offset, paging.offset + paging.limit);
    return {
      data: page,
      has_more: paging.offset + paging.limit < hits.length
    };
  }

  deleteOlderThan(isoCutoff: string): number {
    const info = this.db
      .prepare("DELETE FROM entries WHERE timestamp < ?")
      .run(isoCutoff);
    return Number(info.changes);
  }

  deleteBySession(sessionId: string): number {
    const info = this.db
      .prepare("DELETE FROM entries WHERE session_id = ?")
      .run(sessionId);
    return Number(info.changes);
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
