import express, { type Express } from "express";
import type { BackendRegistry } from "../backends/registry.js";
import type { Archive } from "../archive.js";
import { createAdminArchiveHandlers } from "./archive.js";
import { createAdminBackendsHandlers } from "./backends.js";
import { createAdminConfigHandlers } from "./config.js";
import { bindLocalhostMiddleware } from "./bindLocalhost.js";
import type { ConfigSnapshotStore } from "./configSnapshot.js";

export interface MountAdminDeps {
  archive: Archive;
  registry: BackendRegistry;
  snapshot: ConfigSnapshotStore;
}

/**
 * Mounts every /admin/* route on the given app with the bindLocalhost
 * middleware applied uniformly. The middleware re-reads its enabled flag
 * from the live snapshot per request, so PATCHing adminUi.bindLocalhost takes
 * effect immediately for subsequent requests.
 *
 * Plan-05's archive routes are mounted here too (the inline mount that
 * previously lived in src/server.ts moves into this helper) so every admin
 * route sits behind the same fence with no duplication.
 */
export function mountAdminRoutes(app: Express, deps: MountAdminDeps): void {
  const router = express.Router();
  router.use(
    bindLocalhostMiddleware(() => deps.snapshot.current().adminUi.bindLocalhost)
  );

  // ---- /admin/archive (Plan 05) --------------------------------------
  const adminArchive = createAdminArchiveHandlers({
    archive: deps.archive,
    config: { apiKey: deps.snapshot.current().apiKey }
  });
  router.get("/archive", adminArchive.list);
  router.get("/archive/search", adminArchive.search);
  router.get("/archive/:id", adminArchive.getById);

  // ---- /admin/backends (Plan 11) -------------------------------------
  const adminBackends = createAdminBackendsHandlers({
    registry: deps.registry,
    config: { apiKey: deps.snapshot.current().apiKey }
  });
  router.get("/backends", adminBackends.list);
  router.post("/backends/reprobe", adminBackends.reprobe);
  router.post("/backends/test", adminBackends.test);

  // ---- /admin/config (Plan 11) ---------------------------------------
  const adminConfig = createAdminConfigHandlers({ snapshot: deps.snapshot });
  router.get("/config", adminConfig.get);
  router.put("/config", adminConfig.put);
  router.patch("/config", adminConfig.patch);

  app.use("/admin", router);
}
