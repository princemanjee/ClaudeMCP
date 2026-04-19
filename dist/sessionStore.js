import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
function isSessionMeta(value) {
    if (!value || typeof value !== "object")
        return false;
    const v = value;
    return (typeof v.sessionId === "string" &&
        typeof v.workDir === "string" &&
        typeof v.createdAt === "string" &&
        typeof v.lastUsedAt === "string" &&
        typeof v.turnCount === "number");
}
export class SessionStore {
    storeFile;
    map = new Map();
    externalKeyIndex = new Map();
    writeQueue = Promise.resolve();
    locks = new Map();
    constructor(storeFile) {
        this.storeFile = storeFile;
    }
    async load() {
        try {
            await stat(this.storeFile);
        }
        catch {
            this.map = new Map();
            this.externalKeyIndex = new Map();
            return;
        }
        try {
            const raw = await readFile(this.storeFile, "utf8");
            const parsed = JSON.parse(raw);
            this.map = new Map();
            this.externalKeyIndex = new Map();
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                for (const [key, value] of Object.entries(parsed)) {
                    if (isSessionMeta(value)) {
                        this.map.set(key, value);
                        if (value.externalKey) {
                            this.externalKeyIndex.set(value.externalKey, value.sessionId);
                        }
                    }
                    else {
                        console.warn(`[sessionStore] skipping malformed entry for sessionId="${key}"`);
                    }
                }
            }
        }
        catch (err) {
            console.warn(`[sessionStore] ${this.storeFile} is corrupted, starting fresh:`, err.message);
            this.map = new Map();
            this.externalKeyIndex = new Map();
        }
    }
    size() {
        return this.map.size;
    }
    get(sessionId) {
        return this.map.get(sessionId) ?? null;
    }
    getMostRecent() {
        let best = null;
        for (const v of this.map.values()) {
            if (!best || v.lastUsedAt > best.lastUsedAt)
                best = v;
        }
        return best;
    }
    findByExternalKey(key) {
        const sid = this.externalKeyIndex.get(key);
        if (!sid)
            return null;
        return this.map.get(sid) ?? null;
    }
    async create(sessionId, workDir) {
        const now = new Date().toISOString();
        const meta = {
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
    async createWithExternalKey(sessionId, workDir, externalKey) {
        const now = new Date().toISOString();
        const meta = {
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
    async setExternalKey(sessionId, externalKey) {
        await this.mutateAndPersist(() => {
            const existing = this.map.get(sessionId);
            if (!existing)
                return;
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
    async update(sessionId) {
        let updated = null;
        await this.mutateAndPersist(() => {
            const existing = this.map.get(sessionId);
            if (!existing)
                return;
            updated = {
                ...existing,
                lastUsedAt: new Date().toISOString(),
                turnCount: existing.turnCount + 1,
            };
            this.map.set(sessionId, updated);
        });
        return updated;
    }
    async evictExpired(ttlMs) {
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
    withLock(sessionId, fn) {
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
    mutateAndPersist(mutate) {
        this.writeQueue = this.writeQueue.then(async () => {
            mutate();
            await mkdir(dirname(this.storeFile), { recursive: true });
            const asObject = {};
            for (const [k, v] of this.map)
                asObject[k] = v;
            const tmp = this.storeFile + ".tmp";
            await writeFile(tmp, JSON.stringify(asObject, null, 2), "utf8");
            await rename(tmp, this.storeFile);
        });
        return this.writeQueue;
    }
}
//# sourceMappingURL=sessionStore.js.map