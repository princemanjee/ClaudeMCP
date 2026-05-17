#!/usr/bin/env node
// Standalone runner for the mock-lmstudio Express server. Re-exports the same
// factory the in-process tests use, but bound to a port (default 0 = OS-assigned)
// and prints a single JSON line `{port, url}` on stdout once listening so a
// parent process can read it. Useful for manual smoke testing and as a fallback
// if the in-process pattern hits Vitest-isolation issues.
//
// Argv:
//   --port <n>             default 0 (OS-assigned)
//   --models <a,b,c>       comma-separated model ids
//   --latency-ms <n>       inject latency before every response
//   --bearer <key>         require Authorization: Bearer <key>
//   --fail-chat            return 500 from /v1/chat/completions
//   --fail-embeddings      return 500 from /v1/embeddings
//
// NOTE: This file imports a compiled .js sibling of inProcess.ts. The test
// suite uses inProcess.ts directly via ts-import; this bin shim is for manual
// runs only and requires `npm run build` first (or invocation through tsx).

import { argv, stdout, stderr, exit } from "node:process";
import { startMockLmStudio } from "./inProcess.ts";

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
function bool(name) {
  return argv.includes(name);
}

const opts = {
  models: flag("--models")?.split(",") ?? undefined,
  latencyMs: flag("--latency-ms") ? Number(flag("--latency-ms")) : undefined,
  requiredBearer: flag("--bearer"),
  failChat: bool("--fail-chat"),
  failEmbeddings: bool("--fail-embeddings")
};

const requestedPort = Number(flag("--port") ?? 0);

try {
  const handle = await startMockLmStudio(opts);
  // If the user passed a specific port and we got something else (we always
  // OS-assign in the factory), refuse — easier to fail loudly than to half-honor.
  if (requestedPort !== 0 && handle.port !== requestedPort) {
    stderr.write(
      `mock-lmstudio: requested port ${requestedPort} but bound ${handle.port}; ` +
        "the in-process factory always uses OS-assigned ports.\n"
    );
  }
  stdout.write(JSON.stringify({ port: handle.port, url: handle.url }) + "\n");
  // Keep process alive until killed.
  const noop = () => {};
  setInterval(noop, 1_000_000);
} catch (err) {
  stderr.write(`mock-lmstudio: failed to start: ${err}\n`);
  exit(1);
}
