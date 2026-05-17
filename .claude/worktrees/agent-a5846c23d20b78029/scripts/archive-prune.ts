#!/usr/bin/env node
import { loadConfig } from "../src/config.js";
import { Archive } from "../src/archive.js";

interface Args {
  configPath: string;
  before?: string;
  session?: string;
}

function parseArgs(argv: string[]): Args {
  let configPath: string | undefined;
  let before: string | undefined;
  let session: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      configPath = argv[++i];
    } else if (arg === "--before") {
      before = argv[++i];
    } else if (arg === "--session") {
      session = argv[++i];
    }
  }
  if (!configPath) {
    // eslint-disable-next-line no-console
    console.error(
      "usage: archive-prune --config <path> [--before YYYY-MM-DD] [--session <id>]"
    );
    process.exit(2);
  }
  if (!before && !session) {
    // eslint-disable-next-line no-console
    console.error("archive-prune: must pass either --before or --session");
    process.exit(2);
  }
  const result: Args = { configPath };
  if (before) result.before = before;
  if (session) result.session = session;
  return result;
}

function toCutoffIso(date: string): string {
  // Accept "YYYY-MM-DD" and pad to start-of-day UTC.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    // eslint-disable-next-line no-console
    console.error(`archive-prune: --before must be YYYY-MM-DD, got "${date}"`);
    process.exit(2);
  }
  return `${date}T00:00:00Z`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);
  const archive = new Archive(config.archive.dbPath);
  let removed = 0;
  if (args.before) {
    removed += archive.deleteOlderThan(toCutoffIso(args.before));
  }
  if (args.session) {
    removed += archive.deleteBySession(args.session);
  }
  archive.close();
  // eslint-disable-next-line no-console
  console.log(`archive-prune: removed ${removed} entries`);
}

main();
