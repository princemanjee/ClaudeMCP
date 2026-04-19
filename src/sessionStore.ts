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
  private externalKeyIndex: Map<string, string> = new Map();
  private writeQueue: Promise<void> = Promise.resolve();
  private locks: Map<string, Promise<unknown>> = new Map();

  constructor(private readonly storeFile: string) {}

  async load(): Promise<void> {
    try {
      await stat(this.storeFile);
    } catch {
      this.map = new Map();
      this.externalKeyIndex = new Map();
      return;
    }
    try {
      const raw = await readFile(this.storeFile, "utf8");
      const parsed: unknown = JSON.parse(raw);
      this.map = new Map();
      this.externalKeyIndex = new Map();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (isSessionMeta(value)) {
            this.map.set(key, value);
            if (value.externalKey) {
              this.externalKeyIndex.set(value.externalKey, value.sessionId);
            }
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
      this.externalKeyIndex = new Map();
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

  findByExternalKey(key: string): SessionMeta | null {
    const sid = this.externalKeyIndex.get(key);
    if (!sid) return null;
    return this.map.get(sid) ?? null;
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

  async createWithExternalKey(
    sessionId: string,
    workDir: string,
    externalKey: string,
  ): Promise<SessionMeta> {
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      sessionId,
      workDir,
      createdAt: now,
      lastUsedAt: now,
      turnCount: 0,
      externalKey,
    };
    await this.mutateAndPersist(() => {
      // If another session currently owns this externalKey, retire its mapping.
      // The other session stays in the store (only the key is reassigned).
      const prior = this.externalKeyIndex.get(externalKey);
      if (prior && prior !== sessionId) {
        const priorMeta = this.map.get(prior);
        if (priorMeta) {
          this.map.set(prior, { ...priorMeta, externalKey: undefined });
        }
      }
      this.map.set(sessionId, meta);
      this.externalKeyIndex.set(externalKey, sessionId);
    });
    return meta;
  }

  async setExternalKey(
    sessionId: string,
    externalKey: string,
  ): Promise<void> {
    await this.mutateAndPersist(() => {
      const existing = this.map.get(sessionId);
      if (!existing) return;
      if (existing.externalKey) {
        this.externalKeyIndex.delete(existing.externalKey);
      }
      const prior = this.externalKeyIndex.get(externalKey);
      if (prior && prior !== sessionId) {
        const priorMeta = this.map.get(prior);
        if (priorMeta) {
          this.map.set(prior, { ...priorMeta, externalKey: undefined });
        }
      }
      this.map.set(sessionId, { ...existing, externalKey });
      this.externalKeyIndex.set(externalKey, sessionId);
    });
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
          if (meta.externalKey) {
            this.externalKeyIndex.delete(meta.externalKey);
          }
          removed++;
        }
      }
    });
    return removed;
  }

  withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(sessionId) ?? Promise.resolve();
    const next = prior.then(() => fn());
    const stored = next.catch(() => void 0);
    this.locks.set(sessionId, stored);
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
