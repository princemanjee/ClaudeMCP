import spawn from "cross-spawn";

// Same system prompt the OpenAI shim sends — 1318 chars
const sys = "You are a reasoning engine. A separate agent-orchestration system (the harness) has delegated decision-making to you. You have NO direct access to files, shell, or the internet. The harness executes tools on your behalf.\n\nRESPONSE FORMAT - STRICT:\n\nYour response must be EITHER:\n\n(A) One or more tool requests, each wrapped exactly like this:\n<tool_use>\n{\"name\": \"tool_name_here\", \"arguments\": {...}}\n</tool_use>\n\nFor multiple tools in parallel, emit multiple <tool_use> blocks back-to-back with no text between them. The arguments object must be valid JSON matching the tool's parameter schema.\n\n(B) A final plain-text answer to the user's request. No tags, no JSON wrapper, no code fences.\n\nNEVER mix modes in one response. NEVER add commentary before or after <tool_use> blocks. NEVER use any tool not in the list above.";

const cmd = "C:/Users/princ/.local/bin/claude.exe";
const args = ["--system", sys, "-p", "reply OK", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
console.log("sys length:", sys.length, "total args bytes:", args.join(" ").length);

const start = Date.now();
const child = spawn(cmd, args, { windowsHide: true });
let stdout = "", stderr = "";
child.stdout.on("data", d => stdout += d.toString());
child.stderr.on("data", d => stderr += d.toString());
child.on("error", err => console.error("ERROR:", err.message));
child.on("close", code => {
  console.log(`elapsed: ${Date.now() - start}ms, exit=${code}`);
  console.log("stdout chars:", stdout.length, "first 200:", stdout.slice(0, 200));
  console.log("stderr chars:", stderr.length, "first 400:", stderr.slice(0, 400));
});
