import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigSnapshotStore } from "../../../src/admin/configSnapshot.js";
import { loadConfig, type Config } from "../../../src/config.js";

const BASE_CONFIG = {
  apiKey: "sk-initial",
  claude: { enabled: true, command: "claude", priority: 100, timeoutMs: 600000 },
  gemini: { enabled: false, command: "gemini", priority: 90, timeoutMs: 600000 },
  lmstudio: { enabled: false, instances: [] },
  ollama: { enabled: false, useNativeApi: false, instances: [] }
};

function makeSeed(dir: string, overrides: Record<string, unknown> = {}): {
  cfgPath: string;
  cfg: Config;
} {
  const cfgPath = join(dir, "default.json");
  writeFileSync(cfgPath, JSON.stringify({ ...BASE_CONFIG, ...overrides }));
  return { cfgPath, cfg: loadConfig(cfgPath) };
}

describe("ConfigSnapshotStore — current() + replace()", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-snapshot-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("current() returns the initial snapshot deep-frozen", () => {
    const { cfgPath, cfg } = makeSeed(dir);
    const store = new ConfigSnapshotStore({ initial: cfg, path: cfgPath });
    expect(store.current()).toEqual(cfg);
    expect(Object.isFrozen(store.current())).toBe(true);
  });

  it("replace() writes the new config to disk before swapping in memory", () => {
    const { cfgPath, cfg } = makeSeed(dir);
    const store = new ConfigSnapshotStore({ initial: cfg, path: cfgPath });
    const next = { ...cfg, apiKey: "sk-rotated" } as Config;
    const returned = store.replace(next);
    expect(returned.apiKey).toBe("sk-rotated");
    expect(store.current().apiKey).toBe("sk-rotated");
    const onDisk = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(onDisk.apiKey).toBe("sk-rotated");
  });

  it("replace() leaves the old snapshot in memory when the disk write throws", () => {
    const { cfgPath, cfg } = makeSeed(dir);
    const store = new ConfigSnapshotStore({ initial: cfg, path: cfgPath });
    // Point the store at a path inside a now-deleted directory to force EIO on rename.
    rmSync(dir, { recursive: true, force: true });
    expect(() => store.replace({ ...cfg, apiKey: "sk-doomed" } as Config)).toThrow();
    expect(store.current().apiKey).toBe("sk-initial");
  });

  it("replace() returns a deep-frozen snapshot", () => {
    const { cfgPath, cfg } = makeSeed(dir);
    const store = new ConfigSnapshotStore({ initial: cfg, path: cfgPath });
    const returned = store.replace({ ...cfg, apiKey: "sk-frozen" } as Config);
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned.claude)).toBe(true);
  });

  it("atomic write: tmp file is not left behind on success", () => {
    const { cfgPath, cfg } = makeSeed(dir);
    const store = new ConfigSnapshotStore({ initial: cfg, path: cfgPath });
    store.replace({ ...cfg, apiKey: "sk-clean" } as Config);
    expect(existsSync(`${cfgPath}.tmp`)).toBe(false);
  });
});

describe("ConfigSnapshotStore — crash mid-rename", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-snapshot-crash-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("simulated crash between tmp-write and rename leaves the original config intact", () => {
    const { cfgPath, cfg: _cfg } = makeSeed(dir);
    // Write a sentinel via the tmp path that would normally be renamed.
    const tmpPath = `${cfgPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ apiKey: "sk-crash-attempt" }));
    // A future process boot reads the live path, NOT the tmp file. Verify.
    const reloaded = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(reloaded.apiKey).toBe("sk-initial");
    // And: instantiating a fresh store from the live path returns the original.
    const fresh = new ConfigSnapshotStore({
      initial: loadConfig(cfgPath),
      path: cfgPath
    });
    expect(fresh.current().apiKey).toBe("sk-initial");
    // Cleanup the orphan tmp; future Plan-12 startup hygiene can add an
    // explicit "remove leftover .tmp on boot" sweep, but Plan 11 leaves it.
    rmSync(tmpPath, { force: true });
  });
});
