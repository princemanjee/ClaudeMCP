import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockOllama, type MockOllamaHandle } from "../helpers/mockOllamaProcess.js";
import { buildRegistry } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";

describe("server startup registers OllamaBackend when configured", () => {
  let mock: MockOllamaHandle;
  let configDir: string;
  let configPath: string;

  beforeAll(async () => {
    mock = await startMockOllama();
    configDir = mkdtempSync(join(tmpdir(), "claudemcp-server-test-"));
    configPath = join(configDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        apiKey: "test-key",
        claude: { enabled: false, command: "claude", priority: 100, timeoutMs: 60000 },
        gemini: { enabled: false, command: "gemini", priority: 90, timeoutMs: 60000 },
        lmstudio: { enabled: false, instances: [] },
        ollama: {
          enabled: true,
          useNativeApi: false,
          instances: [
            {
              name: "local",
              baseUrl: mock.baseUrl,
              priority: 40,
              timeoutMs: 5000,
              useNativeApi: null
            }
          ]
        }
      })
    );
  });

  afterAll(async () => {
    await mock.stop();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("registers OllamaBackend; registry can resolve a discovered ollama model", async () => {
    const config = loadConfig(configPath);
    const registry = buildRegistry(config);
    try {
      await registry.probe();
      expect(registry.lastProbeStatus("ollama")?.ok).toBe(true);
      expect(registry.resolveModel("llama-3.3-70b")?.id).toBe("ollama");
    } finally {
      registry.stop();
    }
  });

  it("does NOT register OllamaBackend when config.ollama.enabled is false", async () => {
    const offConfig = {
      apiKey: "test-key",
      claude: { enabled: false, command: "claude", priority: 100, timeoutMs: 60000 },
      gemini: { enabled: false, command: "gemini", priority: 90, timeoutMs: 60000 },
      lmstudio: { enabled: false, instances: [] },
      ollama: { enabled: false, useNativeApi: false, instances: [] }
    };
    const offPath = join(configDir, "config-off.json");
    writeFileSync(offPath, JSON.stringify(offConfig));
    const registry = buildRegistry(loadConfig(offPath));
    try {
      await registry.probe();
      expect(registry.lastProbeStatus("ollama")).toBeUndefined();
    } finally {
      registry.stop();
    }
  });
});
