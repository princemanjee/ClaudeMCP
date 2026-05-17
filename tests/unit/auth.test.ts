import { describe, expect, it } from "vitest";
import { checkAuth } from "../../src/auth.js";

function req(opts: {
  headers?: Record<string, string>;
  query?: Record<string, string>;
}): { headers: Record<string, string>; query: Record<string, string> } {
  return { headers: opts.headers ?? {}, query: opts.query ?? {} };
}

describe("checkAuth", () => {
  const apiKey = "sk-secret-123";

  it("accepts x-api-key header (Anthropic style)", () => {
    expect(checkAuth(req({ headers: { "x-api-key": apiKey } }), apiKey)).toBe(true);
  });

  it("accepts Authorization: Bearer header (OpenAI style)", () => {
    expect(
      checkAuth(req({ headers: { authorization: `Bearer ${apiKey}` } }), apiKey)
    ).toBe(true);
  });

  it("accepts x-goog-api-key header (Google style)", () => {
    expect(
      checkAuth(req({ headers: { "x-goog-api-key": apiKey } }), apiKey)
    ).toBe(true);
  });

  it("accepts ?key= query parameter (Google GET fallback)", () => {
    expect(checkAuth(req({ query: { key: apiKey } }), apiKey)).toBe(true);
  });

  it("rejects missing credentials", () => {
    expect(checkAuth(req({}), apiKey)).toBe(false);
  });

  it("rejects wrong key", () => {
    expect(checkAuth(req({ headers: { "x-api-key": "wrong" } }), apiKey)).toBe(false);
  });

  it("rejects Bearer with wrong key", () => {
    expect(
      checkAuth(req({ headers: { authorization: "Bearer wrong" } }), apiKey)
    ).toBe(false);
  });

  it("rejects malformed Authorization (no Bearer prefix)", () => {
    expect(
      checkAuth(req({ headers: { authorization: apiKey } }), apiKey)
    ).toBe(false);
  });

  it("accepts bearer with lowercase scheme (RFC 7235 case-insensitive)", () => {
    expect(
      checkAuth(req({ headers: { authorization: `bearer ${apiKey}` } }), apiKey)
    ).toBe(true);
  });

  it("accepts BEARER with uppercase scheme (RFC 7235 case-insensitive)", () => {
    expect(
      checkAuth(req({ headers: { authorization: `BEARER ${apiKey}` } }), apiKey)
    ).toBe(true);
  });

  it("rejects empty ?key= query parameter", () => {
    expect(checkAuth(req({ query: { key: "" } }), apiKey)).toBe(false);
  });

  it("comparison is constant-time-shaped (same length wrong key still false)", () => {
    const wrong = apiKey.replace(/.$/, "X");
    expect(checkAuth(req({ headers: { "x-api-key": wrong } }), apiKey)).toBe(false);
  });

  it("handles array-valued headers by taking the first value", () => {
    // Express sometimes parses repeated headers as string[].
    const r = {
      headers: { "x-api-key": [apiKey, "extra"] as unknown as string },
      query: {}
    };
    expect(checkAuth(r, apiKey)).toBe(true);
  });

  it("handles UTF-8 multi-byte characters in keys correctly", () => {
    // Two strings with same character count but different byte lengths.
    // Without the byte-length-first check, timingSafeEqual would throw.
    const a = "key-with-emoji-\u{1F600}"; // 16 chars, 19 bytes
    const b = "key-with-emoji-X";          // 16 chars, 16 bytes
    expect(checkAuth(req({ headers: { "x-api-key": a } }), b)).toBe(false);
    expect(checkAuth(req({ headers: { "x-api-key": b } }), a)).toBe(false);
  });

  it("accepts identical UTF-8 multi-byte keys", () => {
    const key = "sk-\u{1F511}-\u{1F600}";
    expect(checkAuth(req({ headers: { "x-api-key": key } }), key)).toBe(true);
  });
});
