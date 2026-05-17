import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config.js";

function withTempConfig(json: unknown, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "claudemcp-cfg-"));
  const path = join(dir, "test.json");
  writeFileSync(path, JSON.stringify(json));
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadConfig", () => {
  it("loads a minimal valid config", () => {
    withTempConfig(
      {
        apiKey: "sk-test",
        claude: { enabled: true, command: "claude" },
        gemini: { enabled: false, command: "gemini" },
        lmstudio: { enabled: false, instances: [] },
        ollama: { enabled: false, useNativeApi: false, instances: [] }
      },
      (path) => {
        const cfg = loadConfig(path);
        expect(cfg.apiKey).toBe("sk-test");
        expect(cfg.claude.enabled).toBe(true);
        expect(cfg.router.defaultBackend).toBe("claude");
        expect(cfg.archive.dbPath).toBe("data/archive.sqlite");
      }
    );
  });

  it("rejects missing apiKey", () => {
    withTempConfig(
      {
        claude: { enabled: true, command: "claude" },
        gemini: { enabled: false, command: "gemini" },
        lmstudio: { enabled: false, instances: [] },
        ollama: { enabled: false, useNativeApi: false, instances: [] }
      },
      (path) => {
        expect(() => loadConfig(path)).toThrow(/apiKey/);
      }
    );
  });

  it("rejects an unknown defaultBackend", () => {
    withTempConfig(
      {
        apiKey: "sk-test",
        claude: { enabled: true, command: "claude" },
        gemini: { enabled: false, command: "gemini" },
        lmstudio: { enabled: false, instances: [] },
        ollama: { enabled: false, useNativeApi: false, instances: [] },
        router: { defaultBackend: "bogus" }
      },
      (path) => {
        expect(() => loadConfig(path)).toThrow(/claude.*gemini.*lmstudio.*ollama/);
        expect(() => loadConfig(path)).toThrow(/bogus/);
      }
    );
  });

  it("rejects multi-instance backend with duplicate names", () => {
    withTempConfig(
      {
        apiKey: "sk-test",
        claude: { enabled: false, command: "claude" },
        gemini: { enabled: false, command: "gemini" },
        lmstudio: {
          enabled: true,
          instances: [
            { name: "dup", baseUrl: "http://a/v1", priority: 50, timeoutMs: 1000 },
            { name: "dup", baseUrl: "http://b/v1", priority: 50, timeoutMs: 1000 }
          ]
        },
        ollama: { enabled: false, useNativeApi: false, instances: [] }
      },
      (path) => {
        expect(() => loadConfig(path)).toThrow(/unique/i);
      }
    );
  });

  it("returns a deeply frozen object", () => {
    withTempConfig(
      {
        apiKey: "sk-test",
        claude: { enabled: true, command: "claude" },
        gemini: { enabled: false, command: "gemini" },
        lmstudio: { enabled: false, instances: [] },
        ollama: { enabled: false, useNativeApi: false, instances: [] }
      },
      (path) => {
        const cfg = loadConfig(path);
        expect(Object.isFrozen(cfg)).toBe(true);
        expect(Object.isFrozen(cfg.claude)).toBe(true);
      }
    );
  });

  it("env var overrides apiKey when set", () => {
    withTempConfig(
      {
        apiKey: "sk-file",
        claude: { enabled: true, command: "claude" },
        gemini: { enabled: false, command: "gemini" },
        lmstudio: { enabled: false, instances: [] },
        ollama: { enabled: false, useNativeApi: false, instances: [] }
      },
      (path) => {
        process.env.CLAUDE_MCP_API_KEY = "sk-env";
        try {
          const cfg = loadConfig(path);
          expect(cfg.apiKey).toBe("sk-env");
        } finally {
          delete process.env.CLAUDE_MCP_API_KEY;
        }
      }
    );
  });

  it("rejects reasoningEffortMap with unknown key (typo)", () => {
    withTempConfig(
      {
        apiKey: "sk-test",
        claude: { enabled: true, command: "claude" },
        gemini: { enabled: false, command: "gemini" },
        lmstudio: { enabled: false, instances: [] },
        ollama: { enabled: false, useNativeApi: false, instances: [] },
        router: {
          defaultBackend: "claude",
          reasoningEffortMap: {
            claude: { midium: "claude-sonnet-4-6" },
            gemini: {},
            lmstudio: {},
            ollama: {}
          }
        }
      },
      (path) => {
        expect(() => loadConfig(path)).toThrow(/low.*medium.*high/);
      }
    );
  });

  it("accepts claude.command as a string array (e.g. ['wsl', 'claude'])", () => {
    withTempConfig(
      {
        apiKey: "sk-test",
        claude: { enabled: true, command: ["wsl", "claude"] },
        gemini: { enabled: false, command: "gemini" },
        lmstudio: { enabled: false, instances: [] },
        ollama: { enabled: false, useNativeApi: false, instances: [] }
      },
      (path) => {
        const cfg = loadConfig(path);
        expect(cfg.claude.command).toEqual(["wsl", "claude"]);
      }
    );
  });

  it("accepts gemini.command as a string array", () => {
    withTempConfig(
      {
        apiKey: "sk-test",
        claude: { enabled: true, command: "claude" },
        gemini: { enabled: true, command: ["docker", "run", "--rm", "gemini-image"] },
        lmstudio: { enabled: false, instances: [] },
        ollama: { enabled: false, useNativeApi: false, instances: [] }
      },
      (path) => {
        const cfg = loadConfig(path);
        expect(cfg.gemini.command).toEqual(["docker", "run", "--rm", "gemini-image"]);
      }
    );
  });

  it("rejects claude.command as an empty array", () => {
    withTempConfig(
      {
        apiKey: "sk-test",
        claude: { enabled: true, command: [] },
        gemini: { enabled: false, command: "gemini" },
        lmstudio: { enabled: false, instances: [] },
        ollama: { enabled: false, useNativeApi: false, instances: [] }
      },
      (path) => {
        expect(() => loadConfig(path)).toThrow();
      }
    );
  });

  it("rejects claude.command as a non-string non-array (e.g. number)", () => {
    withTempConfig(
      {
        apiKey: "sk-test",
        claude: { enabled: true, command: 42 },
        gemini: { enabled: false, command: "gemini" },
        lmstudio: { enabled: false, instances: [] },
        ollama: { enabled: false, useNativeApi: false, instances: [] }
      },
      (path) => {
        expect(() => loadConfig(path)).toThrow();
      }
    );
  });
});
