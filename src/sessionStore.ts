import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionMeta } from "./types.js";

function isSessionMeta(value: unknown): value is SessionMeta {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === "string" &&
    typeof v.workDir === "string" &&
    typeof v.createdAt === "string" &&
    typeof v.lastUsedAt === "string" &&
    typeof v.turnCount === "number"
  );
}

export class SessionStore {
  private map: Map<string, SessionMeta> = new Map();
  private writeQueue: Promise<void> = Promise.resolve();
  private locks: Map<string, Promise<unknown>> = new Map();

  constructor(private readonly storeFile: string) {}

  async load(): Promise<void> {
    try {
      await stat(this.storeFile);
    } catch {
      this.map = new Map();
      return;
    }
    try {
      const raw = await readFile(this.storeFile, "utf8");
      const parsed: unknown = JSON.parse(raw);
      this.map = new Map();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (isSessionMeta(value)) {
            this.map.set(key, value);
          } else {
            console.warn(
              `[sessionStore] skipping malformed entry for sessionId="${key}"`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(
        `[sessionStore] ${this.storeFile} is corrupted, starting fresh:`,
        (err as Error).message,
      );
      this.map = new Map();
    }
  }

  size(): number {
    return this.map.size;
  }

  get(sessionId: string): SessionMeta | null {
    return this.map.get(sessionId) ?? null;
  }

  getMostRecent(): SessionMeta | null {
    let best: SessionMeta | null = null;
    for (const v of this.map.values()) {
      if (!best || v.lastUsedAt > best.lastUsedAt) best = v;
    }
    return best;
  }

  async create(sessionId: string, workDir: string): Promise<SessionMeta> {
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      sessionId,
      workDir,
      createdAt: now,
      lastUsedAt: now,
      turnCount: 0,
    };
    await this.mutateAndPersist(() => {
      this.map.set(sessionId, meta);
    });
    return meta;
  }

  async update(sessionId: string): Promise<SessionMeta | null> {
    let updated: SessionMeta | null = null;
    await this.mutateAndPersist(() => {
      const existing = this.map.get(sessionId);
      if (!existing) return;
      updated = {
        ...existing,
        lastUsedAt: new Date().toISOString(),
        turnCount: existing.turnCount + 1,
      };
      this.map.set(sessionId, updated);
    });
    return updated;
  }

  async evictExpired(ttlMs: number): Promise<number> {
    const threshold = Date.now() - ttlMs;
    let removed = 0;
    await this.mutateAndPersist(() => {
      for (const [id, meta] of this.map) {
        if (Date.parse(meta.lastUsedAt) < threshold) {
          this.map.delete(id);
          removed++;
        }
      }
    });
    return removed;
  }

  withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(sessionId) ?? Promise.resolve();
    const next = prior.then(() => fn());
    // Store a swallowed copy so a thrown error doesn't poison subsequent
    // acquisitions on the same key.
    const stored = next.catch(() => void 0);
    this.locks.set(sessionId, stored);
    // Clear the entry once this one settles, unless a newer acquisition
    // has already replaced it.
    stored.finally(() => {
      if (this.locks.get(sessionId) === stored) {
        this.locks.delete(sessionId);
      }
    });
    return next;
  }

  private mutateAndPersist(mutate: () => void): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      mutate();
      await mkdir(dirname(this.storeFile), { recursive: true });
      const asObject: Record<string, SessionMeta> = {};
      for (const [k, v] of this.map) asObject[k] = v;
      const tmp = this.storeFile + ".tmp";
      await writeFile(tmp, JSON.stringify(asObject, null, 2), "utf8");
      await rename(tmp, this.storeFile);
    });
    return this.writeQueue;
  }
}
