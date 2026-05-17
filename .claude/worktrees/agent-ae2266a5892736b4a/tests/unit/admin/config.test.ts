import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";
import { ConfigSnapshotStore } from "../../../src/admin/configSnapshot.js";
import { createAdminConfigHandlers } from "../../../src/admin/config.js";
import { loadConfig, type Config } from "../../../src/config.js";

const BASE = {
  apiKey: "sk-initial",
  claude: { enabled: true, command: "claude", priority: 100, timeoutMs: 600000 },
  gemini: { enabled: false, command: "gemini", priority: 90, timeoutMs: 600000 },
  lmstudio: {
    enabled: false,
    instances: [
      {
        name: "local",
        baseUrl: "http://127.0.0.1:1234",
        apiKey: "lm-secret",
        priority: 50,
        timeoutMs: 300000,
        useNativeApi: null
      }
    ]
  },
  ollama: { enabled: false, useNativeApi: false, instances: [] }
};

function seedSnapshot(dir: string, overrides: Record<string, unknown> = {}): {
  store: ConfigSnapshotStore;
  cfgPath: string;
  initial: Config;
} {
  const cfgPath = join(dir, "default.json");
  writeFileSync(cfgPath, JSON.stringify({ ...BASE, ...overrides }));
  const initial = loadConfig(cfgPath);
  const store = new ConfigSnapshotStore({ initial, path: cfgPath });
  return { store, cfgPath, initial };
}

function buildApp(store: ConfigSnapshotStore): express.Express {
  const app = express();
  app.use(express.json());
  const h = createAdminConfigHandlers({ snapshot: store });
  app.get("/admin/config", h.get);
  app.put("/admin/config", h.put);
  app.patch("/admin/config", h.patch);
  return app;
}

describe("/admin/config — auth", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-cfg-auth-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("401 on missing api key", async () => {
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store)).get("/admin/config");
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/config — redaction", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-cfg-get-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("redacts apiKey to ***", async () => {
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store))
      .get("/admin/config")
      .set("x-api-key", "sk-initial");
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toBe("***");
  });

  it("redacts instance apiKey fields", async () => {
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store))
      .get("/admin/config")
      .set("x-api-key", "sk-initial");
    expect(res.body.lmstudio.instances[0].apiKey).toBe("***");
  });

  it("does NOT mutate the underlying snapshot", async () => {
    const { store } = seedSnapshot(dir);
    await request(buildApp(store))
      .get("/admin/config")
      .set("x-api-key", "sk-initial");
    expect(store.current().apiKey).toBe("sk-initial");
    expect(store.current().lmstudio.instances[0]?.apiKey).toBe("lm-secret");
  });
});

describe("PUT /admin/config", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-cfg-put-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("replaces the snapshot and writes to disk on a valid body", async () => {
    const { store, cfgPath } = seedSnapshot(dir);
    const next = { ...BASE, apiKey: "sk-rotated" };
    const res = await request(buildApp(store))
      .put("/admin/config")
      .set("x-api-key", "sk-initial")
      .send(next);
    expect(res.status).toBe(200);
    expect(store.current().apiKey).toBe("sk-rotated");
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(onDisk.apiKey).toBe("sk-rotated");
  });

  it("rejects an apiKey of literally *** (would lock the key)", async () => {
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store))
      .put("/admin/config")
      .set("x-api-key", "sk-initial")
      .send({ ...BASE, apiKey: "***" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/redacted/i);
    expect(store.current().apiKey).toBe("sk-initial");
  });

  it("rejects an invalid body via Zod (e.g., apiKey: empty string)", async () => {
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store))
      .put("/admin/config")
      .set("x-api-key", "sk-initial")
      .send({ ...BASE, apiKey: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("invalid_request_error");
  });

  it("leaves the snapshot unchanged when validation fails", async () => {
    const { store } = seedSnapshot(dir);
    await request(buildApp(store))
      .put("/admin/config")
      .set("x-api-key", "sk-initial")
      .send({ apiKey: "" });
    expect(store.current().apiKey).toBe("sk-initial");
  });
});

describe("PATCH /admin/config — JSON merge patch (RFC 7396)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-cfg-patch-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges a sub-tree without affecting siblings", async () => {
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store))
      .patch("/admin/config")
      .set("x-api-key", "sk-initial")
      .send({ claude: { timeoutMs: 900000 } });
    expect(res.status).toBe(200);
    expect(store.current().claude.timeoutMs).toBe(900000);
    expect(store.current().claude.command).toBe("claude");
    expect(store.current().apiKey).toBe("sk-initial");
  });

  it("explicit null removes a field (RFC 7396 semantics)", async () => {
    // Use a field where removal is legal (instance-level apiKey defaults to "").
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store))
      .patch("/admin/config")
      .set("x-api-key", "sk-initial")
      .send({
        lmstudio: {
          instances: [
            {
              name: "local",
              baseUrl: "http://127.0.0.1:1234",
              apiKey: null,
              priority: 50,
              timeoutMs: 300000,
              useNativeApi: null
            }
          ]
        }
      });
    // Note: PATCH on array elements is treated as full-array replacement per
    // RFC 7396 (arrays are not merged). The Zod default for instance apiKey is
    // empty string, so the result should be apiKey: "".
    expect(res.status).toBe(200);
    expect(store.current().lmstudio.instances[0]?.apiKey).toBe("");
  });

  it("validates the merged result and rolls back on invalid", async () => {
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store))
      .patch("/admin/config")
      .set("x-api-key", "sk-initial")
      .send({ apiKey: "" });
    expect(res.status).toBe(400);
    expect(store.current().apiKey).toBe("sk-initial");
  });

  it("rejects an apiKey of literally *** under PATCH too", async () => {
    const { store } = seedSnapshot(dir);
    const res = await request(buildApp(store))
      .patch("/admin/config")
      .set("x-api-key", "sk-initial")
      .send({ apiKey: "***" });
    expect(res.status).toBe(400);
    expect(store.current().apiKey).toBe("sk-initial");
  });
});

describe("In-flight snapshot semantics", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-cfg-inflight-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("captured snapshot value continues to reflect the old apiKey after replace()", async () => {
    const { store } = seedSnapshot(dir);
    // Simulate an in-flight handler that captured cfg at request entry.
    const inFlightCfg = store.current();
    store.replace({ ...store.current(), apiKey: "sk-rotated" } as Config);
    expect(inFlightCfg.apiKey).toBe("sk-initial");
    expect(store.current().apiKey).toBe("sk-rotated");
  });
});
