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
});
