#!/usr/bin/env node
import { main } from "./server.js";

function parseArgs(argv: string[]): { configPath: string; port?: number } {
  let configPath: string | undefined;
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      configPath = argv[i + 1];
      i++;
    } else if (arg === "--port") {
      const v = argv[i + 1];
      if (v) port = Number.parseInt(v, 10);
      i++;
    }
  }
  if (!configPath) {
    // eslint-disable-next-line no-console
    console.error("usage: claude-mcp --config <path> [--port <n>]");
    process.exit(2);
  }
  return { configPath, ...(port !== undefined ? { port } : {}) };
}

const opts = parseArgs(process.argv.slice(2));
main(opts).catch((err) => {
  // eslint-disable-next-line no-console
  console.error("ClaudeMCP failed to start:", err);
  process.exit(1);
});
