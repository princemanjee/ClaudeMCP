import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  writeSync
} from "node:fs";
import type { Config } from "../config.js";

export interface ConfigSnapshotStoreOptions {
  initial: Config;
  path: string;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function atomicWriteJson(path: string, payload: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * In-process holder for the live config snapshot. Atomic-writes the new
 * config to `configs/default.json` BEFORE swapping the in-memory cell so a
 * disk-write failure leaves the old snapshot intact.
 *
 * The admin-config handlers (Plan 11) capture this store at construction and
 * call `current()` per request. Pre-existing handlers (archive, files,
 * messages) captured a `Config` value directly at startup and are NOT
 * retrofitted by Plan 11 — see the plan's "In-flight snapshot semantics"
 * section for the scope boundary.
 */
export class ConfigSnapshotStore {
  private snapshot: Config;
  private readonly path: string;

  constructor(opts: ConfigSnapshotStoreOptions) {
    this.snapshot = deepFreeze({ ...opts.initial });
    this.path = opts.path;
  }

  current(): Config {
    return this.snapshot;
  }

  /**
   * Atomic write-then-swap. If the disk write throws, the in-memory snapshot
   * is unchanged and the exception propagates. On success the new snapshot is
   * returned (and is the value subsequent `current()` calls will see).
   */
  replace(next: Config): Config {
    const payload = JSON.stringify(next, null, 2);
    atomicWriteJson(this.path, payload);
    this.snapshot = deepFreeze({ ...next });
    return this.snapshot;
  }

  /** The resolved on-disk path (exposed for diagnostics + tests). */
  configPath(): string {
    return this.path;
  }
}
