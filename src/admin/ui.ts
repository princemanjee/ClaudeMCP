import express, {
  type Router,
  type Request,
  type Response,
  type NextFunction
} from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "./session.js";

export interface AdminUiHandlerConfig {
  apiKey: string;
  adminUi: {
    enabled: boolean;
    bindLocalhost: boolean;
    sessionTtlMs: number;
  };
}

export interface AdminUiHandlerDeps {
  sessionStore: SessionStore;
  config: AdminUiHandlerConfig;
  /** Shared constant-time comparator. Plan's signature: (presented, expected) -> boolean. */
  checkApiKey: (presented: string, expected: string) => boolean;
  /** Override of the static-asset directory location (tests pass a fixture dir). */
  uiAssetDir?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Express Router mounted at `/admin/ui`. Routes:
 *   GET    /            → static index.html (no auth — page renders login form)
 *   GET    /*           → static assets (CSS, JS, theme files)
 *   POST   /session     → validate apiKey, issue session cookie
 *   DELETE /session     → revoke session, clear cookie
 *
 * Localhost-bind precondition runs first: when config.adminUi.bindLocalhost is
 * true, non-loopback requests get 403 before any handler runs.
 *
 * Auth note: static routes do NOT require auth. The HTML/CSS/JS are inert
 * without an apiKey. The login page IS the SPA. JSON /admin/* calls (handled
 * elsewhere) require auth via cookie OR x-api-key header.
 */
export function createAdminUiHandler(deps: AdminUiHandlerDeps): Router {
  const { sessionStore, config, checkApiKey } = deps;
  const uiAssetDir = deps.uiAssetDir ?? path.resolve(__dirname, "..", "admin-ui");
  const router = express.Router();

  // Localhost-bind precondition.
  router.use((req: Request, res: Response, next: NextFunction): void => {
    if (!config.adminUi.bindLocalhost) {
      next();
      return;
    }
    if (isLoopback(req.ip ?? "")) {
      next();
      return;
    }
    res.status(403).json({
      type: "error",
      error: {
        type: "permission_error",
        message:
          "admin UI bound to localhost; set config.adminUi.bindLocalhost=false to disable"
      }
    });
  });

  // POST /session — login.
  router.post("/session", express.json({ limit: "4kb" }), (req, res) => {
    const body = req.body as { apiKey?: unknown } | undefined;
    const apiKey =
      body && typeof body.apiKey === "string" ? body.apiKey : "";
    if (!apiKey || !checkApiKey(apiKey, config.apiKey)) {
      res.status(401).json({
        type: "error",
        error: { type: "authentication_error", message: "invalid apiKey" }
      });
      return;
    }
    const token = sessionStore.issue();
    res.setHeader(
      "Set-Cookie",
      buildCookie("claudemcp_session", token, {
        httpOnly: true,
        sameSite: "Strict",
        path: "/admin",
        maxAgeSeconds: Math.floor(config.adminUi.sessionTtlMs / 1000)
      })
    );
    res.status(204).end();
  });

  // DELETE /session — logout.
  router.delete("/session", (req, res) => {
    const token = readSessionCookie(req);
    sessionStore.revoke(token);
    res.setHeader(
      "Set-Cookie",
      buildCookie("claudemcp_session", "", {
        httpOnly: true,
        sameSite: "Strict",
        path: "/admin",
        maxAgeSeconds: 0
      })
    );
    res.status(204).end();
  });

  // Static assets last so explicit routes win on path collisions.
  router.use(
    express.static(uiAssetDir, {
      etag: true,
      lastModified: true,
      maxAge: 0,
      index: "index.html",
      setHeaders(res, filePath) {
        if (filePath.endsWith(".js")) {
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        } else if (filePath.endsWith(".css")) {
          res.setHeader("Content-Type", "text/css; charset=utf-8");
        } else if (filePath.endsWith(".svg")) {
          res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
        }
      }
    })
  );

  return router;
}

export function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function readSessionCookie(req: Request): string | undefined {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  if (cookies && typeof cookies["claudemcp_session"] === "string") {
    return cookies["claudemcp_session"];
  }
  const header = req.headers["cookie"];
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === "claudemcp_session" && typeof v === "string") return v;
  }
  return undefined;
}

interface CookieOpts {
  httpOnly: boolean;
  sameSite: "Strict" | "Lax" | "None";
  path: string;
  maxAgeSeconds: number;
}

function buildCookie(name: string, value: string, opts: CookieOpts): string {
  const parts = [`${name}=${value}`];
  if (opts.httpOnly) parts.push("HttpOnly");
  parts.push(`SameSite=${opts.sameSite}`);
  parts.push(`Path=${opts.path}`);
  parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  return parts.join("; ");
}
