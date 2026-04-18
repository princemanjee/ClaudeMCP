import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/sessionStore.js";

let tmpDir: string;
let storeFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-mcp-store-"));
  storeFile = join(tmpDir, "sessions.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  test("starts empty when file does not exist", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    expect(s.getMostRecent()).toBe(null);
    expect(s.size()).toBe(0);
  });

  test("create adds entry and persists to disk", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    await s.create("abc", "/work");
    const persisted = JSON.parse(readFileSync(storeFile, "utf8"));
    expect(persisted.abc).toMatchObject({
      sessionId: "abc",
      workDir: "/work",
      turnCount: 0,
    });
  });

  test("update bumps turnCount and lastUsedAt", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    await s.create("abc", "/work");
    const beforeUpdate = s.get("abc")!.lastUsedAt;
    // Force a clock tick so timestamps differ
    await new Promise((r) => setTimeout(r, 5));
    await s.update("abc");
    const after = s.get("abc")!;
    expect(after.turnCount).toBe(1);
    expect(after.lastUsedAt > beforeUpdate).toBe(true);
  });

  test("getMostRecent returns the entry with the latest lastUsedAt", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    await s.create("a", "/w");
    await new Promise((r) => setTimeout(r, 5));
    await s.create("b", "/w");
    await new Promise((r) => setTimeout(r, 5));
    await s.update("a");
    const latest = s.getMostRecent();
    expect(latest?.sessionId).toBe("a");
  });

  test("evictExpired removes entries older than TTL", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    await s.create("old", "/w");
    await new Promise((r) => setTimeout(r, 20));
    await s.create("new", "/w");
    const evicted = await s.evictExpired(15);
    expect(evicted).toBe(1);
    expect(s.get("old")).toBe(null);
    expect(s.get("new")?.sessionId).toBe("new");
  });

  test("load recovers state across instances", async () => {
    const s1 = new SessionStore(storeFile);
    await s1.load();
    await s1.create("keep", "/w");
    const s2 = new SessionStore(storeFile);
    await s2.load();
    expect(s2.get("keep")?.sessionId).toBe("keep");
  });

  test("load returns empty on corrupted file", async () => {
    writeFileSync(storeFile, "{ this is not json", "utf8");
    const s = new SessionStore(storeFile);
    await s.load();
    expect(s.size()).toBe(0);
  });

  test("load ignores stale tmp file", async () => {
    writeFileSync(storeFile + ".tmp", "stale", "utf8");
    const s = new SessionStore(storeFile);
    await s.load();
    expect(existsSync(storeFile + ".tmp")).toBe(true);
    expect(s.size()).toBe(0);
  });

  test("withLock serializes same-session calls", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    const events: string[] = [];
    const a = s.withLock("id", async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 20));
      events.push("a-end");
      return "a";
    });
    const b = s.withLock("id", async () => {
      events.push("b-start");
      events.push("b-end");
      return "b";
    });
    await Promise.all([a, b]);
    expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  test("withLock runs different sessions in parallel", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    const events: string[] = [];
    const a = s.withLock("a", async () => {
      events.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      events.push("a-end");
    });
    const b = s.withLock("b", async () => {
      events.push("b-start");
      await new Promise((r) => setTimeout(r, 5));
      events.push("b-end");
    });
    await Promise.all([a, b]);
    // b should complete before a even though a started first
    expect(events.indexOf("b-end")).toBeLessThan(events.indexOf("a-end"));
  });

  test("concurrent create calls on the same id produce a consistent final state", async () => {
    const s = new SessionStore(storeFile);
    await s.load();
    // Fire two creates on the same sessionId simultaneously. The last one
    // to land wins, but both map state and disk state must agree on the
    // same winning meta.
    const [a, b] = await Promise.all([
      s.create("dup", "/w-a"),
      s.create("dup", "/w-b"),
    ]);
    const inMemory = s.get("dup")!;
    const persisted = JSON.parse(readFileSync(storeFile, "utf8"))["dup"];
    expect(inMemory.workDir).toBe(persisted.workDir);
    // The winner's workDir is one of the two we submitted (we don't care which)
    expect(["/w-a", "/w-b"]).toContain(inMemory.workDir);
    expect([a.workDir, b.workDir]).toContain(inMemory.workDir);
  });

  test("load skips malformed entries without crashing", async () => {
    writeFileSync(
      storeFile,
      JSON.stringify({
        good: {
          sessionId: "good",
          workDir: "/w",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastUsedAt: "2026-01-01T00:00:00.000Z",
          turnCount: 0,
        },
        bad1: null,
        bad2: 42,
        bad3: { sessionId: "oops" }, // missing other fields
      }),
      "utf8",
    );
    const s = new SessionStore(storeFile);
    await s.load();
    expect(s.size()).toBe(1);
    expect(s.get("good")?.sessionId).toBe("good");
    expect(s.get("bad1")).toBe(null);
    expect(s.get("bad2")).toBe(null);
    expect(s.get("bad3")).toBe(null);
  });
});
