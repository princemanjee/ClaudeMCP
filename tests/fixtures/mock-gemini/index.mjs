#!/usr/bin/env node
// Minimal mock of the `gemini` CLI for ClaudeMCP tests.
// Reads argv, emits canned output matching the Gemini CLI's documented formats.
//
// Argv shape (subset that matters — adjust to the real CLI's flag surface if it
// differs at implementation time, and update the runners' buildArgs in lockstep):
//   --prompt <text>
//   --output-format json | stream
//   --system <text>
//   --resume <sessionId>          (optional, see open question on session model)
//   --model <id>
//
// The mock parses these flags and emits behavior keyed on substring matches
// in the prompt itself so tests can deterministically force outputs:
//   "MOCK_ERROR"        — exit code 1, stderr "mock error"
//   "MOCK_SLEEP_FOREVER" — sleep until killed (use to force timeouts).
//                          IMPORTANT: uses setInterval, NOT `await new Promise(()=>{})`
//                          which exits immediately due to top-level-await detection
//                          (see Plan-02 deviation log).
//   "MOCK_INVALID_JSON" — emit garbage that isn't JSON
//   anything else        — emit a normal Gemini-shaped response

import { argv, stdout, stderr, exit } from "node:process";

const args = argv.slice(2);

function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const prompt = flagValue("--prompt") ?? "";
const outputFormat = flagValue("--output-format") ?? "json";
const system = flagValue("--system");
const resume = flagValue("--resume");
const model = flagValue("--model") ?? "gemini-flash";

// Deterministic mock session id derived from inputs for assertion stability.
function mockSessionId() {
  if (resume) return resume;
  return `mock-gemini-session-${Buffer.from(prompt).toString("hex").slice(0, 8)}`;
}

const sessionId = mockSessionId();

// Behavioral triggers
if (prompt.includes("MOCK_ERROR")) {
  stderr.write("mock error\n");
  exit(1);
}

if (prompt.includes("MOCK_SLEEP_FOREVER")) {
  // Hang until the parent kills us. setInterval is the correct idiom — a bare
  // unsettled promise exits with code 13 within ~40ms under Node's top-level
  // await detection. See Plan-02 deviation log §1.
  await new Promise((_resolve) => {
    setInterval(() => {}, 1_000_000);
  });
}

if (prompt.includes("MOCK_INVALID_JSON")) {
  stdout.write("this is not json at all\n");
  exit(0);
}

// MOCK_FUNCTION_CALL(name|argsJson) — emit a stream chunk that carries a
// functionCall part instead of text. Used to verify the Gemini backend's
// tool_use translation path.
const fnCallMatch = prompt.match(/MOCK_FUNCTION_CALL\(([^|]+)\|([^)]+)\)/);
if (fnCallMatch && outputFormat === "stream") {
  const fnName = fnCallMatch[1];
  const argsJson = fnCallMatch[2];
  let args;
  try {
    args = JSON.parse(argsJson);
  } catch {
    args = {};
  }
  const chunk = {
    candidates: [
      {
        content: {
          parts: [{ functionCall: { name: fnName, args } }],
          role: "model"
        },
        index: 0,
        finishReason: "STOP"
      }
    ],
    modelVersion: model,
    usageMetadata: {
      promptTokenCount: 1,
      candidatesTokenCount: 1,
      totalTokenCount: 2
    },
    sessionId
  };
  stdout.write(JSON.stringify(chunk) + "\n");
  exit(0);
}

// Normal output
const responseText =
  system && system.length > 0
    ? `[system: ${system.slice(0, 32)}] echo: ${prompt}`
    : `echo: ${prompt}`;

if (outputFormat === "stream") {
  // Stream the response as NDJSON, one event per line, matching the documented
  // Gemini CLI stream shape: each line is a `{candidates: [{content: {parts: [...]}}]}`
  // chunk. The final chunk carries `finishReason` and optional `usageMetadata`.
  const chunks = responseText.match(/.{1,8}/g) ?? [responseText];
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const candidate = {
      content: { parts: [{ text: chunks[i] }], role: "model" },
      index: 0
    };
    if (isLast) {
      candidate.finishReason = "STOP";
    }
    const chunk = {
      candidates: [candidate],
      modelVersion: model
    };
    if (isLast) {
      chunk.usageMetadata = {
        promptTokenCount: Math.ceil(prompt.length / 4),
        candidatesTokenCount: Math.ceil(responseText.length / 4),
        totalTokenCount:
          Math.ceil(prompt.length / 4) + Math.ceil(responseText.length / 4)
      };
      // Mock CLIs may not surface a session_id field for Gemini, but include
      // one in the final chunk so the runner can opportunistically extract it.
      chunk.sessionId = sessionId;
    }
    stdout.write(JSON.stringify(chunk) + "\n");
  }
} else {
  // One-shot JSON: single object on stdout, mirroring the streaming wire shape
  // collapsed into a single candidate's full content.
  stdout.write(
    JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text: responseText }], role: "model" },
          index: 0,
          finishReason: "STOP"
        }
      ],
      modelVersion: model,
      sessionId,
      usageMetadata: {
        promptTokenCount: Math.ceil(prompt.length / 4),
        candidatesTokenCount: Math.ceil(responseText.length / 4),
        totalTokenCount:
          Math.ceil(prompt.length / 4) + Math.ceil(responseText.length / 4)
      }
    })
  );
}

exit(0);
