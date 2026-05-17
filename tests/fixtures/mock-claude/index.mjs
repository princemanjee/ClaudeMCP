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
const toolsFlag = flagValue("--tools");
const stopSequencesFlag = flagValue("--stop-sequences");

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

// ---- Plan 04 triggers --------------------------------------------------

// MOCK_TOOL_USE(<name>,<id>,<json-input>)
// Emits an assistant event with a tool_use content block, then a result.
// Example: MOCK_TOOL_USE(calculator,toolu_01,{"x":1,"y":2})
const toolUseMatch = prompt.match(/MOCK_TOOL_USE\(([^,]+),([^,]+),(\{[^)]*\})\)/);
if (toolUseMatch) {
  if (outputFormat !== "stream-json") {
    stderr.write("MOCK_TOOL_USE requires --output-format stream-json\n");
    exit(2);
  }
  const [, toolName, toolId, inputJson] = toolUseMatch;
  stdout.write(
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model }) +
      "\n"
  );
  // Emit the tool_use block in two delta-style chunks so the stream runner's
  // tool_use_delta path is exercised. The mock just sends the full JSON in
  // the first event for simplicity; real Claude streams partial_json.
  stdout.write(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: toolId,
            name: toolName,
            input: JSON.parse(inputJson)
          }
        ]
      }
    }) + "\n"
  );
  stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      stop_reason: "tool_use",
      result: ""
    }) + "\n"
  );
  exit(0);
}

// MOCK_STOP_SEQUENCE_AT(<literal>)
// Emits ordinary text that contains <literal> in the middle. Use with
// stop_sequences: ["<literal>"] to drive the runner's cutter.
const stopMatch = prompt.match(/MOCK_STOP_SEQUENCE_AT\(([^)]+)\)/);
if (stopMatch) {
  const [, literal] = stopMatch;
  if (outputFormat !== "stream-json") {
    stderr.write("MOCK_STOP_SEQUENCE_AT requires --output-format stream-json\n");
    exit(2);
  }
  stdout.write(
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model }) +
      "\n"
  );
  // Emit three text chunks: the second one contains the sentinel. The third
  // chunk is what we want the cutter to drop.
  stdout.write(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "before " }] }
    }) + "\n"
  );
  stdout.write(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: `mid${literal}rest` }]
      }
    }) + "\n"
  );
  stdout.write(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: " AFTER-SHOULD-BE-DROPPED" }] }
    }) + "\n"
  );
  // We deliberately do NOT emit a `result` event for this trigger — the
  // cutter is expected to terminate the child before it gets here. The
  // child process sleeps for ~5s (via setInterval keep-alive) so the cutter
  // has time to act; if the cutter doesn't fire, the runner's own timeout
  // will eventually expire.
  await new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, 1_000_000);
    setTimeout(() => {
      clearInterval(keepAlive);
      resolve();
    }, 5000);
  });
  exit(0);
}

// MOCK_VISION_REQUEST
// Writes a JSON receipt to stderr summarizing the inbound argv so the
// integration test can assert image payloads arrived intact. Emits a normal
// text response so the rest of the pipeline behaves.
if (prompt.includes("MOCK_VISION_REQUEST")) {
  const receipt = {
    promptLength: prompt.length,
    promptHasImageMarker: /\[image:/i.test(prompt),
    promptImageMediaTypes: Array.from(
      prompt.matchAll(/\[image:([^\];]+)/gi),
      (m) => m[1]
    ),
    promptHasDocumentMarker: /\[document:/i.test(prompt),
    toolsFlag: toolsFlag ?? null,
    stopSequencesFlag: stopSequencesFlag ?? null
  };
  stderr.write(`MOCK_VISION_RECEIPT ${JSON.stringify(receipt)}\n`);
  // Fall through to the Normal output block so the integration test still
  // gets a well-formed response body.
}

// MOCK_TOOL_RESULT_ECHO
// Searches the prompt for [tool_result:<id>] envelopes and echoes them
// back in the response so re-inlining is verifiable end-to-end.
if (prompt.includes("MOCK_TOOL_RESULT_ECHO")) {
  const matches = Array.from(prompt.matchAll(/\[tool_result:([^\]]+)\]([^\[]*)/g));
  const echoed = matches
    .map(([, id, body]) => `echo[tool_result:${id}]=${body.trim()}`)
    .join("; ");
  const echoText = echoed || "no tool_result blocks found";
  if (outputFormat === "stream-json") {
    stdout.write(
      JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model }) +
        "\n"
    );
    stdout.write(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: echoText }] }
      }) + "\n"
    );
    stdout.write(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: sessionId,
        result: echoText
      }) + "\n"
    );
  } else {
    stdout.write(JSON.stringify({ session_id: sessionId, model, result: echoText }));
  }
  exit(0);
}

// Normal output
const responseText =
  system && system.length > 0
    ? `[system: ${system.slice(0, 256)}] echo: ${prompt}`
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
