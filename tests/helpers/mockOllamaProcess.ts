import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "..", "fixtures", "mock-ollama", "server.mjs");

export interface MockOllamaHandle {
  baseUrl: string;
  port: number;
  child: ChildProcess;
  stop(): Promise<void>;
}

/**
 * Spawn the mock-ollama server on a kernel-assigned port and resolve once
 * it prints its listening port. Throws if the child exits before listening
 * or doesn't announce within 5 seconds.
 */
export function startMockOllama(): Promise<MockOllamaHandle> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [FIXTURE], { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuffer = "";
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        child.kill("SIGKILL");
        reject(new Error("mock-ollama did not announce its port within 5s"));
      });
    }, 5000);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const m = stdoutBuffer.match(/LISTENING_ON_PORT (\d+)/);
      if (m && m[1]) {
        const port = Number(m[1]);
        clearTimeout(timer);
        settle(() =>
          resolve({
            baseUrl: `http://127.0.0.1:${port}`,
            port,
            child,
            async stop(): Promise<void> {
              await new Promise<void>((res) => {
                child.once("exit", () => res());
                child.kill("SIGTERM");
                setTimeout(() => {
                  if (!child.killed) child.kill("SIGKILL");
                  res();
                }, 1000);
              });
            }
          })
        );
      }
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      settle(() => reject(new Error(`mock-ollama exited with code ${code} before announcing`)));
    });
  });
}
