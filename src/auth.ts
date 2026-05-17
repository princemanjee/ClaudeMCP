import { timingSafeEqual } from "node:crypto";

export interface AuthCarrier {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
}

function pickFirst(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function safeEqual(a: string, b: string): boolean {
  // Pad the shorter to the longer length so timingSafeEqual doesn't throw, then
  // require lengths to match for a true result.
  const len = Math.max(a.length, b.length);
  const ab = Buffer.from(a.padEnd(len, "\0"));
  const bb = Buffer.from(b.padEnd(len, "\0"));
  const equal = timingSafeEqual(ab, bb);
  return equal && a.length === b.length;
}

function extractKey(carrier: AuthCarrier): string | undefined {
  const xApi = pickFirst(carrier.headers["x-api-key"]);
  if (xApi) return xApi;

  const goog = pickFirst(carrier.headers["x-goog-api-key"]);
  if (goog) return goog;

  const auth = pickFirst(carrier.headers["authorization"]);
  if (auth) {
    const [scheme, token] = auth.split(/\s+/, 2);
    if (scheme === "Bearer" && token) return token;
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
