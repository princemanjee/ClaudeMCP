import { timingSafeEqual } from "node:crypto";

// Express req.query is actually ParsedQs (nested objects) — callers from Express
// routes may need to narrow or cast before passing as AuthCarrier.
export interface AuthCarrier {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
}

function pickFirst(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function safeEqual(a: string, b: string): boolean {
  // Encode both as UTF-8 byte buffers. timingSafeEqual requires equal byte
  // length, so check lengths first (revealing a length mismatch is acceptable —
  // it tells an attacker nothing they can't already infer from the response
  // shape). The constant-time work happens only when lengths match.
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.byteLength !== bb.byteLength) return false;
  return timingSafeEqual(ab, bb);
}

function extractKey(carrier: AuthCarrier): string | undefined {
  const xApi = pickFirst(carrier.headers["x-api-key"]);
  if (xApi) return xApi;

  const goog = pickFirst(carrier.headers["x-goog-api-key"]);
  if (goog) return goog;

  const auth = pickFirst(carrier.headers["authorization"]);
  if (auth) {
    const [scheme, token] = auth.split(/\s+/, 2);
    if (scheme && scheme.toLowerCase() === "bearer" && token) return token;
  }

  const query = pickFirst(carrier.query["key"]);
  if (query) return query;

  return undefined;
}

export function checkAuth(carrier: AuthCarrier, expectedApiKey: string): boolean {
  const presented = extractKey(carrier);
  if (!presented) return false;
  return safeEqual(presented, expectedApiKey);
}
