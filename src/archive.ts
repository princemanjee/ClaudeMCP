import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

export class Archive {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    const mode = this.db.pragma("journal_mode = WAL", { simple: true }) as string;
    if (mode !== "wal") {
      this.db.close();
      throw new Error(`Archive: expected WAL journal mode, got "${mode}"`);
    }
    this.db.exec(SCHEMA_SQL);
  }

  /** Exposed for use by writers added in Plan 05. */
  raw(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
