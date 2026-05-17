import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createAdminBackendsHandlers } from "../../../src/admin/backends.js";
import type { BackendRegistry, ProbeStatus } from "../../../src/backends/registry.js";
import type {
  Backend,
  BackendCapabilities,
  BackendId,
  ModelDescriptor
} from "../../../src/backends/types.js";

function fakeBackend(id: BackendId, models: ModelDescriptor[]): Backend {
  const caps: BackendCapabilities = {
    toolUse: true,
    multimodal: false,
    thinking: false,
    cacheControl: "none",
    samplingParams: { temperature: true, topP: true, topK: false },
    stopSequences: "native",
    embeddings: id === "lmstudio" || id === "ollama"
  };
  return {
    id,
    capabilitiesFor: () => caps,
    listModels: async () => models,
    invoke: async function* () {
      // not exercised in these tests
    },
    countTokens: async () => 0
  };
}

function fakeRegistry(opts: {
  backends: Backend[];
  statuses?: Map<BackendId, ProbeStatus>;
  probeImpl?: () => Promise<unknown>;
}): BackendRegistry {
  const map = new Map<BackendId, Backend>(opts.backends.map((b) => [b.id, b]));
  const statuses = opts.statuses ?? new Map<BackendId, ProbeStatus>();
  const stub = {
    get: (id: BackendId) => map.get(id),
    enabledBackends: () => Array.from(map.values()),
    resolveModel: () => undefined,
    lastProbeStatus: (id: BackendId) => statuses.get(id),
    probe: opts.probeImpl ?? (async () => ({ successes: [], failures: [] })),
    register: () => {},
    startPeriodicProbe: () => {},
    stop: () => {}
  } as unknown as BackendRegistry;
  return stub;
}

function buildApp(deps: { registry: BackendRegistry; apiKey: string }): express.Express {
  const app = express();
  app.use(express.json());
  const h = createAdminBackendsHandlers({
    registry: deps.registry,
    config: { apiKey: deps.apiKey }
  });
  app.get("/admin/backends", h.list);
  app.post("/admin/backends/reprobe", h.reprobe);
  app.post("/admin/backends/test", h.test);
  return app;
}

describe("/admin/backends — auth", () => {
  it("returns 401 on missing api key", async () => {
    const reg = fakeRegistry({ backends: [fakeBackend("claude", [])] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" })).get(
      "/admin/backends"
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 on wrong api key", async () => {
    const reg = fakeRegistry({ backends: [fakeBackend("claude", [])] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .get("/admin/backends")
      .set("x-api-key", "wrong");
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/backends", () => {
  it("lists every registered backend with id, models, capabilities, probe status", async () => {
    const claude = fakeBackend("claude", [
      { id: "claude-opus-4-7", supportsTools: true, supportsVision: true }
    ]);
    const lm = fakeBackend("lmstudio", [{ id: "qwen3-coder-30b" }]);
    const statuses = new Map<BackendId, ProbeStatus>([
      ["claude", { ok: true, lastProbedAt: new Date("2026-05-16T12:00:00Z") }],
      [
        "lmstudio",
        {
          ok: false,
          lastProbedAt: new Date("2026-05-16T12:01:00Z"),
          error: "connection refused"
        }
      ]
    ]);
    const reg = fakeRegistry({ backends: [claude, lm], statuses });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .get("/admin/backends")
      .set("x-api-key", "sk-x");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const claudeEntry = res.body.data.find((e: { id: string }) => e.id === "claude");
    expect(claudeEntry).toBeDefined();
    expect(claudeEntry.models.map((m: { id: string }) => m.id)).toEqual([
      "claude-opus-4-7"
    ]);
    expect(claudeEntry.lastProbe.ok).toBe(true);
    expect(claudeEntry.lastProbe.at).toBe("2026-05-16T12:00:00.000Z");
    expect(claudeEntry.reachable).toBe(true);
    expect(claudeEntry.capabilities["claude-opus-4-7"]).toMatchObject({
      toolUse: true,
      embeddings: false
    });

    const lmEntry = res.body.data.find((e: { id: string }) => e.id === "lmstudio");
    expect(lmEntry.lastProbe.ok).toBe(false);
    expect(lmEntry.lastProbe.error).toBe("connection refused");
    expect(lmEntry.reachable).toBe(false);
    expect(lmEntry.capabilities["qwen3-coder-30b"].embeddings).toBe(true);
  });

  it("returns lastProbe: null for backends never probed", async () => {
    const reg = fakeRegistry({ backends: [fakeBackend("gemini", [])] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .get("/admin/backends")
      .set("x-api-key", "sk-x");
    const entry = res.body.data[0];
    expect(entry.lastProbe).toBeNull();
    expect(entry.reachable).toBe(false);
  });
});

describe("POST /admin/backends/reprobe", () => {
  it("calls registry.probe() and returns the refreshed listing", async () => {
    let probeCalls = 0;
    const reg = fakeRegistry({
      backends: [fakeBackend("claude", [{ id: "claude-opus-4-7" }])],
      probeImpl: async () => {
        probeCalls += 1;
        return { successes: [], failures: [] };
      }
    });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .post("/admin/backends/reprobe")
      .set("x-api-key", "sk-x")
      .send({});
    expect(res.status).toBe(200);
    expect(probeCalls).toBe(1);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body._meta.reprobeScope).toBe("all");
  });

  it("validates ?instance against the known backend ids; 400 if unknown", async () => {
    const reg = fakeRegistry({ backends: [fakeBackend("claude", [])] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .post("/admin/backends/reprobe?instance=mystery")
      .set("x-api-key", "sk-x")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("invalid_request_error");
  });

  it("accepts ?instance=<known backend id> and surfaces the all-scope note", async () => {
    const reg = fakeRegistry({ backends: [fakeBackend("claude", [])] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .post("/admin/backends/reprobe?instance=claude")
      .set("x-api-key", "sk-x")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body._meta.reprobeScope).toBe("all");
    expect(res.body._meta.requestedInstance).toBe("claude");
  });
});

describe("POST /admin/backends/test", () => {
  // We mock global.fetch for this describe block.
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns ok:true with models when /v1/models responds 200", async () => {
    global.fetch = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "qwen3-coder-30b" }, { id: "llama-3.3-70b" }] })
    })) as unknown as typeof fetch;
    const reg = fakeRegistry({ backends: [] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .post("/admin/backends/test")
      .set("x-api-key", "sk-x")
      .send({ baseUrl: "http://10.0.0.5:1234" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.models).toEqual(["qwen3-coder-30b", "llama-3.3-70b"]);
    expect(typeof res.body.latencyMs).toBe("number");
  });

  it("returns ok:false with error when fetch rejects (connection refused)", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const reg = fakeRegistry({ backends: [] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .post("/admin/backends/test")
      .set("x-api-key", "sk-x")
      .send({ baseUrl: "http://10.0.0.5:1234" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/ECONNREFUSED/);
  });

  it("hits /api/tags when useNativeApi is true", async () => {
    const seen: string[] = [];
    global.fetch = vi.fn(async (url: string) => {
      seen.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [{ name: "llama3.2" }, { name: "qwen2.5" }]
        })
      };
    }) as unknown as typeof fetch;
    const reg = fakeRegistry({ backends: [] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .post("/admin/backends/test")
      .set("x-api-key", "sk-x")
      .send({ baseUrl: "http://10.0.0.5:11434", useNativeApi: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.models).toEqual(["llama3.2", "qwen2.5"]);
    expect(seen[0]).toMatch(/\/api\/tags$/);
  });

  it("400 on missing baseUrl", async () => {
    const reg = fakeRegistry({ backends: [] });
    const res = await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .post("/admin/backends/test")
      .set("x-api-key", "sk-x")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("invalid_request_error");
  });

  it("forwards apiKey in the Authorization header when provided", async () => {
    let seenAuth: string | undefined;
    global.fetch = vi.fn(async (_url: string, init: { headers?: Record<string, string> } = {}) => {
      seenAuth = init.headers?.["Authorization"];
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }) as unknown as typeof fetch;
    const reg = fakeRegistry({ backends: [] });
    await request(buildApp({ registry: reg, apiKey: "sk-x" }))
      .post("/admin/backends/test")
      .set("x-api-key", "sk-x")
      .send({ baseUrl: "http://10.0.0.5:1234", apiKey: "lm-studio-token" });
    expect(seenAuth).toBe("Bearer lm-studio-token");
  });
});
