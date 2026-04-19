import spawn from "cross-spawn";
import treeKill from "tree-kill";
export function buildArgs(opts) {
    const args = [];
    if (opts.resumeSessionId) {
        args.push("--resume", opts.resumeSessionId);
    }
    args.push("-p", opts.prompt);
    args.push("--output-format", "json");
    if (opts.dangerouslySkipPermissions) {
        args.push("--dangerously-skip-permissions");
    }
    else if (opts.allowedTools !== undefined) {
        args.push("--allowed-tools", opts.allowedTools);
    }
    return args;
}
function splitCommand(cmd) {
    if (Array.isArray(cmd)) {
        const [head, ...rest] = cmd;
        if (!head)
            throw new Error("claudeCommand array must be non-empty");
        return [head, rest];
    }
    return [cmd, []];
}
function parseSessionId(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed)
        return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
            const sid = parsed.session_id ??
                parsed.sessionId;
            return typeof sid === "string" ? sid : null;
        }
    }
    catch {
        // Not JSON — some error paths emit plain text. Caller handles fallback.
    }
    return null;
}
function extractText(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed)
        return "";
    try {
        const parsed = JSON.parse(trimmed);
        const result = parsed.result ?? parsed.output ?? parsed.text;
        if (typeof result === "string")
            return result;
        return JSON.stringify(parsed);
    }
    catch {
        return trimmed;
    }
}
export function runClaude(opts) {
    return new Promise((resolve) => {
        const start = Date.now();
        const args = buildArgs(opts);
        const [cmd, prefixArgs] = splitCommand(opts.claudeCommand);
        // cross-spawn handles Windows .cmd/.bat resolution and proper arg
        // escaping without needing shell:true, avoiding the standard spawn
        // quoting bugs when prompts contain spaces or special characters.
        const child = spawn(cmd, [...prefixArgs, ...args], {
            cwd: opts.workDir,
            windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let spawnErrored = false;
        const timer = setTimeout(() => {
            timedOut = true;
            if (child.pid !== undefined) {
                treeKill(child.pid, "SIGKILL");
            }
            else {
                child.kill("SIGKILL");
            }
        }, opts.timeoutMs);
        child.stdout?.on("data", (d) => (stdout += d.toString()));
        child.stderr?.on("data", (d) => (stderr += d.toString()));
        child.on("error", (err) => {
            spawnErrored = true;
            stderr += `\n[spawn error] ${err.message}`;
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            const durationMs = Date.now() - start;
            const exitCode = spawnErrored
                ? -1
                : timedOut
                    ? (code ?? 124)
                    : (code ?? 0);
            resolve({
                text: extractText(stdout),
                sessionId: exitCode === 0 ? parseSessionId(stdout) : null,
                exitCode,
                durationMs,
                timedOut,
                stderr,
            });
        });
    });
}
//# sourceMappingURL=claudeRunner.js.map