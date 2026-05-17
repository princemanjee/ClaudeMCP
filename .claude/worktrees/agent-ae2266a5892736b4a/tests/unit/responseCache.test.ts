import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ResponseCache,
  buildCacheKey,
  type CacheKeyParts,
  type CachedResponse
} from "../../src/responseCache.js";

function fakeBody(text: string): CachedResponse {
  return {
    body: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }
    },
    metadata: { backendId: "claude", resolvedModel: "claude-sonnet-4-6" }
  };
}

describe("buildCacheKey — canonicalization", () => {
  it("produces a stable 64-hex SHA-256 string", () => {
    const parts: CacheKeyParts = {
      backendId: "claude",
      resolvedModel: "claude-sonnet-4-6",
      system: "be brief",
      cacheablePrefix: [{ type: "text", text: "ctx" }],
      tail: [{ type: "text", text: "ask" }]
    };
    expect(buildCacheKey(parts)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is invariant to object-key ordering", () => {
    const a = buildCacheKey({
      backendId: "claude",
      resolvedModel: "m",
      system: "s",
      cacheablePrefix: [{ type: "text", text: "p" }],
      tail: [{ type: "text", text: "t" }],
      tools: [{ name: "x", description: "d", inputSchema: { a: 1, b: 2 } }]
    });
    const b = buildCacheKey({
      tools: [{ inputSchema: { b: 2, a: 1 }, description: "d", name: "x" }],
      tail: [{ type: "text", text: "t" }],
      cacheablePrefix: [{ type: "text", text: "p" }],
      system: "s",
      resolvedModel: "m",
      backendId: "claude"
    });
    expect(a).toBe(b);
  });

  it("Unicode-normalizes strings to NFC so visually-identical-but-byte-different inputs collide", () => {
    // U+00E9 (NFC) vs e + U+0301 (NFD) — same visual "é"
    const nfc = buildCacheKey({
      backendId: "claude",
      resolvedModel: "m",
      system: "café",
      cacheablePrefix: [],
      tail: []
    });
    const nfd = buildCacheKey({
      backendId: "claude",
      resolvedModel: "m",
      system: "café",
      cacheablePrefix: [],
      tail: []
    });
    expect(nfc).toBe(nfd);
  });

  it("changes when backendId changes", () => {
    const claude = buildCacheKey({
      backendId: "claude",
      resolvedModel: "m",
      system: "s",
      cacheablePrefix: [],
      tail: []
    });
    const gemini = buildCacheKey({
      backendId: "gemini",
      resolvedModel: "m",
      system: "s",
      cacheablePrefix: [],
      tail: []
    });
    expect(claude).not.toBe(gemini);
  });
});

describe("ResponseCache — get + set", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-cache-"));
    file = join(dir, "response-cache.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined for an unknown key", () => {
    const cache = new ResponseCache({ file, ttlMs: 60_000, maxEntries: 100 });
    expect(cache.get("nope")).toBeUndefined();
  });

  it("returns the stored body on hit", () => {
    const cache = new ResponseCache({ file, ttlMs: 60_000, maxEntries: 100 });
    cache.set("k", fakeBody("hello"));
    const hit = cache.get("k");
    expect(hit?.body.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("set() writes to the mirror file atomically", () => {
    const cache = new ResponseCache({ file, ttlMs: 60_000, maxEntries: 100 });
    cache.set("k", fakeBody("persisted"));
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain("persisted");
    // Temp file should be gone after the rename.
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("reloads from the mirror file on construction", () => {
    const a = new ResponseCache({ file, ttlMs: 60_000, maxEntries: 100 });
    a.set("k", fakeBody("survives"));

    const b = new ResponseCache({ file, ttlMs: 60_000, maxEntries: 100 });
    const hit = b.get("k");
    expect(hit?.body.content).toEqual([{ type: "text", text: "survives" }]);
  });
});

describe("ResponseCache — eviction", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-cache-"));
    file = join(dir, "response-cache.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when the entry is older than ttlMs", async () => {
    const cache = new ResponseCache({ file, ttlMs: 30, maxEntries: 100 });
    cache.set("k", fakeBody("aged"));
    await new Promise((r) => setTimeout(r, 60));
    expect(cache.get("k")).toBeUndefined();
  });

  it("max-entries LRU drops the oldest-accessed entry on insert", () => {
    const cache = new ResponseCache({ file, ttlMs: 60_000, maxEntries: 2 });
    cache.set("a", fakeBody("a"));
    cache.set("b", fakeBody("b"));
    cache.get("a"); // bump a's lastAccessed
    cache.set("c", fakeBody("c")); // should evict b, not a
    expect(cache.get("a")).toBeTruthy();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeTruthy();
  });
});
