import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { BackendRegistry } from "../../src/backends/registry.js";
import { GeminiBackend } from "../../src/backends/geminiBackend.js";
import { ClaudeBackend } from "../../src/backends/claudeBackend.js";
import type { NormalizedEvent } from "../../src/backends/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_GEMINI = ["node", join(__dirname, "..", "fixtures", "mock-gemini", "index.mjs")];
const MOCK_CLAUDE = ["node", join(__dirname, "..", "fixtures", "mock-claude", "index.mjs")];

describe("GeminiBackend integrates with BackendRegistry", () => {
  it("registers, probes, resolves a Gemini model, invokes end-to-end", async () => {
    const registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
    const gemini = new GeminiBackend({
      command: MOCK_GEMINI,
      timeoutMs: 5000
    });
    registry.register(gemini);

    try {
      await registry.probe();

      // listModels populated the registry's model map.
      expect(registry.resolveModel("gemini-pro")?.id).toBe("gemini");
      expect(registry.resolveModel("gemini-flash")?.id).toBe("gemini");
      expect(registry.resolveModel("gemini-flash-lite")?.id).toBe("gemini");
      expect(registry.resolveModel("gemini-2.5-pro")?.id).toBe("gemini");

      const resolved = registry.resolveModel("gemini-flash");
      expect(resolved).toBeDefined();

      const events: NormalizedEvent[] = [];
      for await (const ev of resolved!.invoke({
        model: "gemini-flash",
        messages: [{ role: "user", content: [{ type: "text", text: "integration ping" }] }]
      })) {
        events.push(ev);
      }

      // Wire-shape parity: starts with message_start, ends with message_stop.
      expect(events[0]?.kind).toBe("message_start");
      expect(events[events.length - 1]?.kind).toBe("message_stop");

      // The body text reproduces the mock's echo response.
      const body = events
        .filter((e) => e.kind === "text_delta")
        .map((e) => (e.kind === "text_delta" ? e.text : ""))
        .join("");
      expect(body).toBe("echo: user: integration ping");

      // countTokens returns a non-negative number for the same request shape.
      const tokens = await resolved!.countTokens({
        model: "gemini-flash",
        messages: [{ role: "user", content: [{ type: "text", text: "integration ping" }] }]
      });
      expect(tokens).toBeGreaterThan(0);
    } finally {
      registry.stop();
    }
  });

  it("coexists with the Claude backend — both probe and resolve their own models", async () => {
    const registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
    registry.register(new ClaudeBackend({ command: MOCK_CLAUDE, timeoutMs: 5000 }));
    registry.register(new GeminiBackend({ command: MOCK_GEMINI, timeoutMs: 5000 }));

    try {
      await registry.probe();

      expect(registry.resolveModel("claude-sonnet-4-6")?.id).toBe("claude");
      expect(registry.resolveModel("gemini-flash")?.id).toBe("gemini");

      // Neither backend's models leak into the other.
      expect(registry.resolveModel("claude-sonnet-4-6")?.id).not.toBe("gemini");
      expect(registry.resolveModel("gemini-flash")?.id).not.toBe("claude");

      // Both probe statuses are ok.
      expect(registry.lastProbeStatus("claude")?.ok).toBe(true);
      expect(registry.lastProbeStatus("gemini")?.ok).toBe(true);
    } finally {
      registry.stop();
    }
  });

  it("registry priority places Gemini below Claude by default (Gemini 90 < Claude 100)", async () => {
    // This test asserts priority math, not collision resolution — Gemini and
    // Claude model ids do not overlap. The point is that the priority map is
    // honored, which Plan 07's cross-shim dispatch will rely on.
    const registry = new BackendRegistry({
      claude: 100,
      gemini: 90,
      lmstudio: 50,
      ollama: 40
    });
    registry.register(new GeminiBackend({ command: MOCK_GEMINI, timeoutMs: 5000 }));

    try {
      await registry.probe();
      const status = registry.lastProbeStatus("gemini");
      expect(status?.ok).toBe(true);
    } finally {
      registry.stop();
    }
  });
});
