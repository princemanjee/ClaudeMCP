import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogEntry } from "./types.js";

const MAX_OUTPUT_BYTES = 10 * 1024;
const QUESTION_PHRASES = [
  "which do you",
  "should i",
  "do you want",
  "please clarify",
  "can you tell me",
];

export function truncateUtf8(
  input: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(input, "utf8");
  if (buf.byteLength <= maxBytes) {
    return { text: input, truncated: false };
  }
  // Walk back from maxBytes until we land on a code-point boundary.
  // UTF-8 continuation bytes match 10xxxxxx (0x80..0xBF).
  let end = maxBytes;
  while (end > 0 && (buf[end] !== undefined) && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

export function containsQuestionHeuristic(output: string): boolean {
  const trimmed = output.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.endsWith("?")) return true;
  const lower = trimmed.toLowerCase();
  return QUESTION_PHRASES.some((p) => lower.includes(p));
}

export class Logger {
  private queue: Promise<void> = Promise.resolve();
  private dirEnsured = false;

  constructor(private readonly logFile: string) {}

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(dirname(this.logFile), { recursive: true });
    this.dirEnsured = true;
  }

  log(entry: LogEntry): Promise<void> {
    // Truncation happens before enqueue so callers can see the final form
    // in tests via readback. Mutates a copy, not the caller's object.
    const truncated = truncateUtf8(entry.output ?? "", MAX_OUTPUT_BYTES);
    const toWrite: LogEntry = {
      ...entry,
      output: truncated.text,
      ...(truncated.truncated ? { outputTruncated: true } : {}),
    };
    this.queue = this.queue.then(async () => {
      await this.ensureDir();
      await appendFile(this.logFile, JSON.stringify(toWrite) + "\n", "utf8");
    });
    return this.queue;
  }

  flush(): Promise<void> {
    return this.queue;
  }
}
