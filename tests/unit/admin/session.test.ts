import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../../../src/admin/session.js";

describe("SessionStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues 64-char lowercase hex tokens", () => {
    const store = new SessionStore({ ttlMs: 1000 });
    const token = store.issue();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("issues unique tokens across 1000 calls", () => {
    const store = new SessionStore({ ttlMs: 1000 });
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(store.issue());
    expect(seen.size).toBe(1000);
  });

  it("validate() returns true within TTL, false after", () => {
    const store = new SessionStore({ ttlMs: 10_000 });
    const token = store.issue();
    vi.advanceTimersByTime(5_000);
    expect(store.validate(token)).toBe(true);
    vi.advanceTimersByTime(5_001);
    expect(store.validate(token)).toBe(false);
  });

  it("validate() returns false on unknown token", () => {
    const store = new SessionStore({ ttlMs: 10_000 });
    expect(store.validate("a".repeat(64))).toBe(false);
  });

  it("validate() returns false on null/undefined/empty token", () => {
    const store = new SessionStore({ ttlMs: 10_000 });
    expect(store.validate(null)).toBe(false);
    expect(store.validate(undefined)).toBe(false);
    expect(store.validate("")).toBe(false);
  });

  it("revoke() invalidates a token", () => {
    const store = new SessionStore({ ttlMs: 10_000 });
    const token = store.issue();
    expect(store.validate(token)).toBe(true);
    store.revoke(token);
    expect(store.validate(token)).toBe(false);
  });

  it("revoke() is a no-op for absent / null / undefined tokens", () => {
    const store = new SessionStore({ ttlMs: 10_000 });
    expect(() => store.revoke("does-not-exist")).not.toThrow();
    expect(() => store.revoke(null)).not.toThrow();
    expect(() => store.revoke(undefined)).not.toThrow();
  });

  it("sweep() evicts only expired entries", () => {
    const store = new SessionStore({ ttlMs: 10_000 });
    const a = store.issue();
    vi.advanceTimersByTime(5_000);
    const b = store.issue();
    vi.advanceTimersByTime(6_000); // a is 11s old (expired); b is 6s old
    store.sweep();
    expect(store.validate(a)).toBe(false);
    expect(store.validate(b)).toBe(true);
  });

  it("validate() lazily evicts an expired entry on read", () => {
    const store = new SessionStore({ ttlMs: 10_000 });
    const token = store.issue();
    expect(store.size()).toBe(1);
    vi.advanceTimersByTime(10_001);
    expect(store.validate(token)).toBe(false);
    expect(store.size()).toBe(0);
  });

  it("ttlMs=0 means immediately-expired tokens", () => {
    const store = new SessionStore({ ttlMs: 0 });
    const token = store.issue();
    expect(store.validate(token)).toBe(false);
  });

  it("constructor rejects negative ttlMs", () => {
    expect(() => new SessionStore({ ttlMs: -1 })).toThrow(/non-negative/);
  });

  it("constructor rejects non-finite ttlMs", () => {
    expect(() => new SessionStore({ ttlMs: Number.POSITIVE_INFINITY })).toThrow(/finite/);
    expect(() => new SessionStore({ ttlMs: Number.NaN })).toThrow(/finite/);
  });
});
