import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { BackendRegistry } from "../../src/backends/registry.js";
import { ClaudeBackend } from "../../src/backends/claudeBackend.js";
import type { NormalizedEvent } from "../../src/backends/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_CLAUDE = ["node", join(__dirname, "..", "fixtures", "mock-claude", "index.mjs")];

describe("ClaudeBackend integrates with BackendRegistry", () => {
  it("registers, probes, resolves a Claude model, invokes end-to-end", async () => {
    const registry = new BackendRegistry({ claude: 100 });
    const claude = new ClaudeBackend({
      command: MOCK_CLAUDE,
      timeoutMs: 5000
    });
    registry.register(claude);

    try {
      await registry.probe();

      // listModels populated the registry's model map.
      expect(registry.resolveModel("claude-opus-4-7")?.id).toBe("claude");
      expect(registry.resolveModel("claude-sonnet-4-6")?.id).toBe("claude");
      expect(registry.resolveModel("claude-haiku-4-5")?.id).toBe("claude");

      // Invoke the resolved backend end-to-end.
      const resolved = registry.resolveModel("claude-sonnet-4-6");
      expect(resolved).toBeDefined();

      const events: NormalizedEvent[] = [];
      for await (const ev of resolved!.invoke({
        model: "claude-sonnet-4-6",
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
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: [{ type: "text", text: "integration ping" }] }]
      });
      expect(tokens).toBeGreaterThan(0);
    } finally {
      registry.stop();
    }
  });

  it("registry priority places Claude on top by default (priority 100)", async () => {
    const registry = new BackendRegistry({ claude: 100 });
    registry.register(
      new ClaudeBackend({ command: MOCK_CLAUDE, timeoutMs: 5000 })
    );

    try {
      await registry.probe();
      const status = registry.lastProbeStatus("claude");
      expect(status?.ok).toBe(true);
    } finally {
      registry.stop();
    }
  });
});
