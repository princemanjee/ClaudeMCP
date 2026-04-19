import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "claude-mcp-config-"));
  delete process.env.CLAUDE_MCP_PORT;
  delete process.env.CLAUDE_MCP_HOST;
  delete process.env.CLAUDE_MCP_LOG_FILE;
  delete process.env.CLAUDE_MCP_SESSION_STORE_FILE;
  delete process.env.CLAUDE_MCP_OPENAI_ENABLED;
  delete process.env.CLAUDE_MCP_OPENAI_AUTH_HEADER;
  delete process.env.CLAUDE_MCP_OPENAI_TIMEOUT_MS;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CLAUDE_MCP_PORT;
  delete process.env.CLAUDE_MCP_HOST;
  delete process.env.CLAUDE_MCP_LOG_FILE;
  delete process.env.CLAUDE_MCP_SESSION_STORE_FILE;
  delete process.env.CLAUDE_MCP_OPENAI_ENABLED;
  delete process.env.CLAUDE_MCP_OPENAI_AUTH_HEADER;
  delete process.env.CLAUDE_MCP_OPENAI_TIMEOUT_MS;
});

function write(name: string, content: unknown): string {
  const path = join(tmpDir, name);
  writeFileSync(path, JSON.stringify(content), "utf8");
  return path;
}

describe("loadConfig", () => {
  test("parses a valid config and applies defaults for missing fields", () => {
    const path = write("c.json", {
      task: { defaultWorkDir: "C:/Code/scratch" },
    });
    const cfg = loadConfig(path);
    expect(cfg.port).toBe(3000);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.logFile).toBe("logs/activity.log");
    expect(cfg.sessionStoreFile).toBe("data/sessions.json");
    expect(cfg.claudeCommand).toBe("claude");
    expect(cfg.ask.timeoutMs).toBe(60000);
    expect(cfg.ask.allowedTools).toBe("");
    expect(cfg.task.defaultSessionMode).toBe("session");
    expect(cfg.task.defaultWorkDir).toBe("C:/Code/scratch");
    expect(cfg.task.timeoutMs).toBe(600000);
    expect(cfg.task.allowedTools).toBe("Read,Edit,Write,Bash,Glob,Grep");
    expect(cfg.task.dangerouslySkipPermissions).toBe(true);
    expect(cfg.task.sessionTtlMs).toBe(86400000);
  });

  test("honors user-provided values over defaults", () => {
    const path = write("c.json", {
      port: 4000,
      host: "0.0.0.0",
      task: {
        defaultWorkDir: "/tmp/work",
        defaultSessionMode: "stateless",
        dangerouslySkipPermissions: false,
      },
    });
    const cfg = loadConfig(path);
    expect(cfg.port).toBe(4000);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.task.defaultWorkDir).toBe("/tmp/work");
    expect(cfg.task.defaultSessionMode).toBe("stateless");
    expect(cfg.task.dangerouslySkipPermissions).toBe(false);
  });

  test("env vars override config values", () => {
    process.env.CLAUDE_MCP_PORT = "5555";
    process.env.CLAUDE_MCP_HOST = "0.0.0.0";
    process.env.CLAUDE_MCP_LOG_FILE = "/var/log/x.log";
    const path = write("c.json", {
      port: 3000,
      task: { defaultWorkDir: "C:/Code/scratch" },
    });
    const cfg = loadConfig(path);
    expect(cfg.port).toBe(5555);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.logFile).toBe("/var/log/x.log");
  });

  test("rejects non-numeric CLAUDE_MCP_PORT env var", () => {
    process.env.CLAUDE_MCP_PORT = "abc";
    const path = write("c.json", {
      task: { defaultWorkDir: "/x" },
    });
    expect(() => loadConfig(path)).toThrow(/positive integer/);
  });

  test("rejects invalid types with a clear error", () => {
    const path = write("c.json", { port: "not-a-number" });
    expect(() => loadConfig(path)).toThrow(/port/);
  });

  test("rejects unknown sessionMode", () => {
    const path = write("c.json", {
      task: { defaultSessionMode: "wacky", defaultWorkDir: "/x" },
    });
    expect(() => loadConfig(path)).toThrow();
  });

  test("returned config is frozen", () => {
    const path = write("c.json", {
      task: { defaultWorkDir: "/x" },
    });
    const cfg = loadConfig(path);
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.ask)).toBe(true);
    expect(Object.isFrozen(cfg.task)).toBe(true);
  });

  test("throws a clear error when file does not exist", () => {
    expect(() => loadConfig(join(tmpDir, "nope.json"))).toThrow(/nope\.json/);
  });

  test("applies openai defaults when block is omitted", () => {
    const path = write("c.json", {
      task: { defaultWorkDir: "/x" },
    });
    const cfg = loadConfig(path);
    expect(cfg.openai.enabled).toBe(true);
    expect(cfg.openai.requireAuthHeader).toBe(null);
    expect(cfg.openai.timeoutMs).toBe(120000);
  });

  test("env vars override openai config", () => {
    process.env.CLAUDE_MCP_OPENAI_ENABLED = "false";
    process.env.CLAUDE_MCP_OPENAI_AUTH_HEADER = "Bearer secret";
    process.env.CLAUDE_MCP_OPENAI_TIMEOUT_MS = "7000";
    const path = write("c.json", { task: { defaultWorkDir: "/x" } });
    const cfg = loadConfig(path);
    expect(cfg.openai.enabled).toBe(false);
    expect(cfg.openai.requireAuthHeader).toBe("Bearer secret");
    expect(cfg.openai.timeoutMs).toBe(7000);
  });
});
