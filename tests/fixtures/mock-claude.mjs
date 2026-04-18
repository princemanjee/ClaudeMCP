#!/usr/bin/env node
// Mock `claude` CLI for integration tests. Emits JSON matching what
// Claude Code's --output-format json produces for our purposes.
// Behavior is controlled via MOCK_CLAUDE_SCENARIO:
//   "success"     -> success with a generated session_id
//   "resume"      -> success that echoes the --resume value as session_id
//   "nonzero"     -> exit 3 with stderr
//   "slow"        -> sleeps 5s then succeeds (used to trigger timeouts)
//   default       -> same as "success"

const scenario = process.env.MOCK_CLAUDE_SCENARIO ?? "success";
const args = process.argv.slice(2);
const resumeIdx = args.indexOf("--resume");
const resumeId = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
const promptIdx = args.indexOf("-p");
const prompt = promptIdx >= 0 ? args[promptIdx + 1] : "";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function run() {
  if (scenario === "nonzero") {
    process.stderr.write("mock failure");
    process.exit(3);
  }
  if (scenario === "slow") {
    setTimeout(() => {
      emit({ session_id: "late-id", result: `late reply to: ${prompt}` });
      process.exit(0);
    }, 5000);
    return;
  }
  const sid = resumeId ?? `mock-${Math.random().toString(36).slice(2, 10)}`;
  emit({ session_id: sid, result: `mock reply to: ${prompt}` });
  process.exit(0);
}

run();
