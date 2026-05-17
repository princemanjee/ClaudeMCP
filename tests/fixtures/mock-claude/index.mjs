#!/usr/bin/env node
// Minimal mock of the `claude` CLI for ClaudeMCP tests.
// Reads argv, emits canned output matching Claude Code's documented formats.
//
// Argv shape (subset that matters):
//   -p <prompt>
//   --output-format json | stream-json
//   --system <prompt>
//   --resume <sessionId>
//   --allowed-tools <csv>          (we ignore the value, just record it)
//   --dangerously-skip-permissions
//   --model <id>
//
// The mock parses these flags and emits behavior keyed on substring matches
// in the prompt itself so tests can deterministically force outputs:
//   "MOCK_ERROR"        — exit code 1, stderr "mock error"
//   "MOCK_SLEEP_FOREVER" — sleep 60s before exit (use to force timeouts)
//   "MOCK_INVALID_JSON" — emit garbage that isn't JSON
//   anything else        — emit a normal response

import { argv, stdout, stderr, exit } from "node:process";

const args = argv.slice(2);

function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const prompt = flagValue("-p") ?? "";
const outputFormat = flagValue("--output-format") ?? "json";
const system = flagValue("--system");
const resume = flagValue("--resume");
const model = flagValue("--model") ?? "claude-sonnet-4-6";

// Deterministic mock session id derived from inputs for assertion stability.
function mockSessionId() {
  if (resume) return resume;
  return `mock-session-${Buffer.from(prompt).toString("hex").slice(0, 8)}`;
}

const sessionId = mockSessionId();

// Behavioral triggers
if (prompt.includes("MOCK_ERROR")) {
  stderr.write("mock error\n");
  exit(1);
}

if (prompt.includes("MOCK_SLEEP_FOREVER")) {
  // Use a timer-based approach to keep the event loop alive. A bare
  // `await new Promise(() => {})` triggers Node's "unsettled top-level await"
  // detection and the process exits with code 13 within milliseconds,
  // defeating the timeout-test scenario.
  await new Promise((_resolve) => {
    setInterval(() => {}, 1_000_000);
  });
}

if (prompt.includes("MOCK_INVALID_JSON")) {
  stdout.write("this is not json at all\n");
  exit(0);
}

// Normal output
const responseText =
  system && system.length > 0
    ? `[system: ${system.slice(0, 32)}] echo: ${prompt}`
    : `echo: ${prompt}`;

if (outputFormat === "stream-json") {
  // Stream the response as NDJSON, one event per line, matching Claude Code's
  // stream-json shape (system init, assistant message, result).
  stdout.write(
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model }) +
      "\n"
  );
  // Split response into a few chunks to exercise streaming parsers.
  const chunks = responseText.match(/.{1,8}/g) ?? [responseText];
  for (const chunk of chunks) {
    stdout.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: chunk }] }
      }) + "\n"
    );
  }
  stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      result: responseText
    }) + "\n"
  );
} else {
  // One-shot JSON: single object on stdout.
  stdout.write(
    JSON.stringify({
      session_id: sessionId,
      model,
      result: responseText
    })
  );
}

exit(0);
