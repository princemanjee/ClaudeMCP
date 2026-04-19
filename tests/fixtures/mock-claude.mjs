#!/usr/bin/env node
// Mock `claude` CLI for integration tests. Emits either JSON (for --output-format json)
// or newline-delimited JSON events (for --output-format stream-json).
//
// Scenarios via MOCK_CLAUDE_SCENARIO env var:
//   "success" (default), "resume", "nonzero", "slow"   — original --output-format json scenarios
//   "openai-answer"      — stream-json with a plain-text answer
//   "openai-tool-call"   — stream-json with one <tool_use> block
//   "openai-parallel"    — stream-json with two back-to-back <tool_use> blocks

const scenario = process.env.MOCK_CLAUDE_SCENARIO ?? "success";
const args = process.argv.slice(2);

function getArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const resumeId = getArg("--resume");
const prompt = getArg("-p") ?? "";
const outputFormat = getArg("--output-format") ?? "text";

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function emitOnce(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function streamJsonOpenAnswer() {
  writeLine({ type: "system", subtype: "init", session_id: resumeId ?? `mock-${Math.random().toString(36).slice(2, 10)}`, model: "mock", cwd: process.cwd() });
  writeLine({ type: "assistant", message: { content: [{ type: "text", text: "Here is the mock answer with enough length to pass classification." }] } });
  writeLine({ type: "result", subtype: "success", session_id: resumeId ?? undefined });
  process.exit(0);
}

function streamJsonToolCall() {
  const sid = resumeId ?? `mock-${Math.random().toString(36).slice(2, 10)}`;
  writeLine({ type: "system", subtype: "init", session_id: sid, model: "mock", cwd: process.cwd() });
  writeLine({ type: "assistant", message: { content: [{ type: "text", text: '<tool_use>{"name":"search","arguments":{"q":"mock"}}</tool_use>' }] } });
  writeLine({ type: "result", subtype: "success", session_id: sid });
  process.exit(0);
}

function streamJsonParallel() {
  const sid = resumeId ?? `mock-${Math.random().toString(36).slice(2, 10)}`;
  writeLine({ type: "system", subtype: "init", session_id: sid, model: "mock", cwd: process.cwd() });
  writeLine({ type: "assistant", message: { content: [{ type: "text", text: '<tool_use>{"name":"a","arguments":{}}</tool_use><tool_use>{"name":"b","arguments":{"x":1}}</tool_use>' }] } });
  writeLine({ type: "result", subtype: "success", session_id: sid });
  process.exit(0);
}

function run() {
  if (outputFormat === "stream-json") {
    if (scenario === "openai-answer") return streamJsonOpenAnswer();
    if (scenario === "openai-tool-call") return streamJsonToolCall();
    if (scenario === "openai-parallel") return streamJsonParallel();
    return streamJsonOpenAnswer();
  }

  // Original --output-format json scenarios
  if (scenario === "nonzero") {
    process.stderr.write("mock failure");
    process.exit(3);
  }
  if (scenario === "slow") {
    setTimeout(() => {
      emitOnce({ session_id: "late-id", result: `late reply to: ${prompt}` });
      process.exit(0);
    }, 5000);
    return;
  }
  const sid = resumeId ?? `mock-${Math.random().toString(36).slice(2, 10)}`;
  emitOnce({ session_id: sid, result: `mock reply to: ${prompt}` });
  process.exit(0);
}

run();
