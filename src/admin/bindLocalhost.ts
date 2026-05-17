import type { RequestHandler } from "express";
import { authenticationError } from "../anthropicShim/errors.js";

const LOCAL_IPS = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1"
]);

/**
 * When `getEnabled()` returns true, rejects any request whose `req.ip` is not
 * a recognized localhost address with HTTP 403 + an Anthropic-shaped error
 * envelope. The getter is re-evaluated per request so toggling
 * `adminUi.bindLocalhost` via PATCH takes effect without reconstructing the
 * middleware.
 *
 * For accurate `req.ip` against an X-Forwarded-For header (e.g., when a test
 * needs to simulate a non-127.0.0.1 source), the app must `app.set("trust
 * proxy", true)`. Plan 11's server bootstrap does not enable trust-proxy in
 * production by default — the spec specifies bindLocalhost is for direct-
 * connection deployments. Operators behind a reverse proxy should disable
 * bindLocalhost or enable trust-proxy explicitly.
 */
export function bindLocalhostMiddleware(
  getEnabled: () => boolean
): RequestHandler {
  return (req, res, next) => {
    if (!getEnabled()) {
      next();
      return;
    }
    const ip = req.ip ?? "";
    if (LOCAL_IPS.has(ip)) {
      next();
      return;
    }
    res
      .status(403)
      .json(
        authenticationError(
          `admin endpoints are bound to localhost only; rejecting request from ${ip || "<unknown>"}`
        )
      );
  };
}
