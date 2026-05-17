import { randomBytes } from "node:crypto";

export interface SessionStoreOptions {
  /** Time-to-live in milliseconds. Tokens older than this are invalid. */
  ttlMs: number;
}

interface SessionEntry {
  createdAt: number;
}

/**
 * In-memory map of session-token → creation timestamp. Used by the admin UI
 * login flow: POST /admin/ui/session issues a token, sets it as an HttpOnly
 * cookie, and subsequent /admin/* requests authenticate via `validate()`.
 *
 * No persistence — the map clears on process restart. Operators re-log-in.
 * The spec accepts this trade-off for a localhost-only admin tool.
 */
export class SessionStore {
  private readonly map = new Map<string, SessionEntry>();
  private readonly ttlMs: number;

  constructor(opts: SessionStoreOptions) {
    if (!Number.isFinite(opts.ttlMs)) {
      throw new Error(
        `SessionStore: ttlMs must be a finite number, got ${opts.ttlMs}`
      );
    }
    if (opts.ttlMs < 0) {
      throw new Error(
        `SessionStore: ttlMs must be a non-negative number, got ${opts.ttlMs}`
      );
    }
    this.ttlMs = opts.ttlMs;
  }

  /** Issue a fresh token. 32 random bytes rendered as 64-char lowercase hex. */
  issue(): string {
    const token = randomBytes(32).toString("hex");
    this.map.set(token, { createdAt: Date.now() });
    return token;
  }

  /** True iff the token exists and `Date.now() - createdAt < ttlMs`. */
  validate(token: string | undefined | null): boolean {
    if (!token) return false;
    const entry = this.map.get(token);
    if (!entry) return false;
    if (Date.now() - entry.createdAt >= this.ttlMs) {
      // Lazy eviction on read.
      this.map.delete(token);
      return false;
    }
    return true;
  }

  /** Explicit logout: revoke a single token. No-op if absent. */
  revoke(token: string | undefined | null): void {
    if (!token) return;
    this.map.delete(token);
  }

  /** Periodic bulk eviction of expired entries. Call from a setInterval. */
  sweep(): void {
    const now = Date.now();
    for (const [token, entry] of this.map.entries()) {
      if (now - entry.createdAt >= this.ttlMs) {
        this.map.delete(token);
      }
    }
  }

  /** Test-only: current live entry count. Not for production use. */
  size(): number {
    return this.map.size;
  }
}
