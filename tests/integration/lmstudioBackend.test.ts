import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { BackendRegistry } from "../../src/backends/registry.js";
import { ClaudeBackend } from "../../src/backends/claudeBackend.js";
import { LMStudioBackend } from "../../src/backends/lmstudioBackend.js";
import type { NormalizedEvent } from "../../src/backends/types.js";
import {
  startMockLmStudio,
  type MockLmStudioHandle
} from "../fixtures/mock-lmstudio/inProcess.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_CLAUDE = ["node", join(__dirname, "..", "fixtures", "mock-claude", "index.mjs")];

describe("LMStudioBackend integrates with BackendRegistry", () => {
  const handles: MockLmStudioHandle[] = [];
  afterEach(async () => {
    while (handles.length > 0) {
      const h = handles.shift()!;
      await h.close();
    }
  });

  it("registers, probes two instances, resolves a model from instance 2, invokes end-to-end", async () => {
    const inst1 = await startMockLmStudio({ models: ["qwen3-coder-30b"] });
    const inst2 = await startMockLmStudio({ models: ["llama-3.3-70b", "nomic-embed-text"] });
    handles.push(inst1, inst2);

    const registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
    registry.register(
      new LMStudioBackend({
        enabled: true,
        instances: [
          { name: "local", baseUrl: inst1.url, apiKey: "", priority: 50, timeoutMs: 5000, useNativeApi: null },
          { name: "work-server", baseUrl: inst2.url, apiKey: "", priority: 60, timeoutMs: 5000, useNativeApi: null }
        ]
      })
    );

    try {
      await registry.probe();

      // Both instances' models appear in the registry's model map.
      expect(registry.resolveModel("qwen3-coder-30b")?.id).toBe("lmstudio");
      expect(registry.resolveModel("llama-3.3-70b")?.id).toBe("lmstudio");
      expect(registry.resolveModel("nomic-embed-text")?.id).toBe("lmstudio");

      const backend = registry.resolveModel("llama-3.3-70b");
      expect(backend).toBeDefined();

      const events: NormalizedEvent[] = [];
      for await (const ev of backend!.invoke({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: [{ type: "text", text: "integration ping" }] }]
      })) {
        events.push(ev);
      }
      expect(events[0]?.kind).toBe("message_start");
      expect(events[events.length - 1]?.kind).toBe("message_stop");

      const body = events
        .filter((e) => e.kind === "text_delta")
        .map((e) => (e.kind === "text_delta" ? e.text : ""))
        .join("");
      expect(body).toBe("echo: integration ping");

      // probe status is ok
      expect(registry.lastProbeStatus("lmstudio")?.ok).toBe(true);
    } finally {
      registry.stop();
    }
  });

  it("embed round-trip via the registry-resolved backend", async () => {
    const inst1 = await startMockLmStudio({ models: ["nomic-embed-text"] });
    handles.push(inst1);

    const registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
    registry.register(
      new LMStudioBackend({
        enabled: true,
        instances: [
          { name: "local", baseUrl: inst1.url, apiKey: "", priority: 50, timeoutMs: 5000, useNativeApi: null }
        ]
      })
    );

    try {
      await registry.probe();
      const backend = registry.resolveModel("nomic-embed-text");
      expect(backend).toBeDefined();
      expect(typeof backend!.embed).toBe("function");

      const resp = await backend!.embed!({
        model: "nomic-embed-text",
        input: ["hello", "world"]
      });
      expect(resp.embeddings).toHaveLength(2);
      expect(resp.embeddings[0]).toHaveLength(4);
    } finally {
      registry.stop();
    }
  });

  it("coexists with ClaudeBackend — both probe and resolve their own models without collision", async () => {
    const inst1 = await startMockLmStudio({ models: ["qwen3-coder-30b"] });
    handles.push(inst1);

    const registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
    registry.register(new ClaudeBackend({ command: MOCK_CLAUDE, timeoutMs: 5000 }));
    registry.register(
      new LMStudioBackend({
        enabled: true,
        instances: [
          { name: "local", baseUrl: inst1.url, apiKey: "", priority: 50, timeoutMs: 5000, useNativeApi: null }
        ]
      })
    );

    try {
      await registry.probe();

      expect(registry.resolveModel("claude-sonnet-4-6")?.id).toBe("claude");
      expect(registry.resolveModel("qwen3-coder-30b")?.id).toBe("lmstudio");

      // Neither leaks into the other.
      expect(registry.resolveModel("claude-sonnet-4-6")?.id).not.toBe("lmstudio");
      expect(registry.resolveModel("qwen3-coder-30b")?.id).not.toBe("claude");

      expect(registry.lastProbeStatus("claude")?.ok).toBe(true);
      expect(registry.lastProbeStatus("lmstudio")?.ok).toBe(true);
    } finally {
      registry.stop();
    }
  });

  it("explicit lmstudio:<instance>/<model> prefix is preserved by registry → backend", async () => {
    const local = await startMockLmStudio({ models: ["shared-model"] });
    const work = await startMockLmStudio({ models: ["shared-model"] });
    handles.push(local, work);

    const registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
    registry.register(
      new LMStudioBackend({
        enabled: true,
        instances: [
          { name: "local", baseUrl: local.url, apiKey: "", priority: 50, timeoutMs: 5000, useNativeApi: null },
          { name: "work-server", baseUrl: work.url, apiKey: "", priority: 60, timeoutMs: 5000, useNativeApi: null }
        ]
      })
    );

    try {
      await registry.probe();
      // The registry doesn't know about the prefix; it resolves the bare
      // "shared-model" to the lmstudio backend. The backend itself handles
      // the prefix when the request arrives. To exercise the prefix path,
      // we resolve via "shared-model" then pass the prefixed id in the
      // request — that's the contract a shim would follow (the shim strips
      // the prefix for registry lookup, then re-attaches for backend.invoke).
      const backend = registry.resolveModel("shared-model");
      expect(backend?.id).toBe("lmstudio");

      const events: NormalizedEvent[] = [];
      for await (const ev of backend!.invoke({
        model: "lmstudio:local/shared-model",
        messages: [{ role: "user", content: [{ type: "text", text: "explicit-route ping" }] }]
      })) {
        events.push(ev);
      }
      expect(events[events.length - 1]?.kind).toBe("message_stop");
    } finally {
      registry.stop();
    }
  });
});
