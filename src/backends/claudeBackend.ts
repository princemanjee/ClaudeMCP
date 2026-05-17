import type {
  Backend,
  BackendCapabilities,
  ModelDescriptor,
  NormalizedEvent,
  NormalizedRequest
} from "./types.js";
import { runClaudeStream } from "../runners/claudeStreamRunner.js";
import type { ClaudeStreamOptions } from "../runners/types.js";

export interface ClaudeBackendConfig {
  /** Either the executable name (e.g. "claude") or [executable, ...prefix-args]. */
  command: string | string[];
  /** Per-call timeout in milliseconds. */
  timeoutMs: number;
}

/**
 * Curated catalog of Claude models the backend reports. The CLI itself has no
 * model-listing endpoint, so this is maintained here. When Anthropic ships a
 * new model id, add it to this list and `capabilitiesFor` if its surface differs.
 */
const MODEL_CATALOG: ModelDescriptor[] = [
  {
    id: "claude-opus-4-7",
    contextWindow: 200000,
    supportsTools: true,
    supportsVision: true,
    description: "Most capable Claude model. Extended thinking supported."
  },
  {
    id: "claude-sonnet-4-6",
    contextWindow: 200000,
    supportsTools: true,
    supportsVision: true,
    description: "Balanced capability/cost. Extended thinking supported."
  },
  {
    id: "claude-haiku-4-5",
    contextWindow: 200000,
    supportsTools: true,
    supportsVision: true,
    description: "Fastest, cheapest Claude model."
  }
];

/**
 * Char-count token estimator. ceil(charCount / 4) is a standard rough
 * approximation for English-text BPE; later plans swap in `@anthropic-ai/tokenizer`
 * when the dependency is available, but for Plan 02 this is what ships.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function sumRequestTokens(req: NormalizedRequest): number {
  let total = 0;
  if (req.system) total += estimateTokens(req.system);
  for (const msg of req.messages) {
    for (const block of msg.content) {
      if (block.type === "text") total += estimateTokens(block.text);
      else if (block.type === "thinking") total += estimateTokens(block.text);
      else if (block.type === "tool_use")
        total += estimateTokens(JSON.stringify(block.input));
      else if (block.type === "tool_result")
        total += estimateTokens(block.content);
      // image / document blocks: ignored for now; Plan 05 adds proper accounting.
    }
  }
  return total;
}

export class ClaudeBackend implements Backend {
  readonly id = "claude" as const;

  constructor(private readonly config: ClaudeBackendConfig) {}

  capabilitiesFor(_model: string): BackendCapabilities {
    // Same surface across all Claude models for now. Per-model narrowing
    // (e.g., a hypothetical text-only model losing supportsVision) lands
    // when needed.
    return {
      toolUse: true,
      multimodal: true,
      thinking: true,
      cacheControl: "none",
      samplingParams: { temperature: false, topP: false, topK: false },
      stopSequences: "server-side-cut",
      embeddings: false
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return MODEL_CATALOG.map((m) => ({ ...m }));
  }

  async countTokens(req: NormalizedRequest): Promise<number> {
    return sumRequestTokens(req);
  }

  async *invoke(
    req: NormalizedRequest
  ): AsyncIterable<NormalizedEvent> {
    this.assertPlan02Scope(req);

    const streamOpts: ClaudeStreamOptions = {
      prompt: this.foldMessagesToPrompt(req),
      systemPrompt: req.system,
      timeoutMs: this.config.timeoutMs,
      claudeCommand: this.config.command,
      dangerouslySkipPermissions: true
    };

    let startEmitted = false;
    let textIndex = 0;
    let textOpen = false;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const raw of runClaudeStream(streamOpts)) {
      const ev = raw as {
        type?: string;
        subtype?: string;
        session_id?: string;
        model?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
        usage?: { input_tokens?: number; output_tokens?: number };
        is_error?: boolean;
      };

      if (ev.type === "system" && ev.subtype === "init") {
        if (!startEmitted) {
          startEmitted = true;
          yield { kind: "message_start", model: ev.model ?? req.model };
        }
        continue;
      }

      if (ev.type === "assistant" && ev.message?.content) {
        if (!startEmitted) {
          startEmitted = true;
          yield { kind: "message_start", model: req.model };
        }
        for (const block of ev.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            yield { kind: "text_delta", index: textIndex, text: block.text };
            textOpen = true;
          }
        }
        continue;
      }

      if (ev.type === "result") {
        if (ev.usage) {
          inputTokens = ev.usage.input_tokens ?? 0;
          outputTokens = ev.usage.output_tokens ?? 0;
        }
        if (textOpen) {
          textIndex++;
          textOpen = false;
        }
        if (!startEmitted) {
          startEmitted = true;
          yield { kind: "message_start", model: req.model };
        }
        yield {
          kind: "message_stop",
          stopReason: ev.is_error ? "error" : "end_turn",
          usage: inputTokens + outputTokens > 0
            ? { inputTokens, outputTokens }
            : undefined
        };
        return;
      }
    }

    // Stream ended without an explicit result event (e.g. process killed by
    // timeout). Emit a synthesized message_stop so callers always see one.
    if (!startEmitted) {
      yield { kind: "message_start", model: req.model };
    }
    yield { kind: "message_stop", stopReason: "error" };
  }

  // ---- Plan-02 scope helpers ---------------------------------------------

  private assertPlan02Scope(req: NormalizedRequest): void {
    if (req.tools && req.tools.length > 0) {
      throw new Error(
        "ClaudeBackend (Plan 02): native tool calling lands in Plan 04"
      );
    }
    if (req.stopSequences && req.stopSequences.length > 0) {
      throw new Error(
        "ClaudeBackend (Plan 02): stop_sequences server-side cut lands in Plan 04"
      );
    }
    for (const msg of req.messages) {
      for (const block of msg.content) {
        if (block.type === "image" || block.type === "document") {
          throw new Error(
            "ClaudeBackend (Plan 02): multimodal content lands in Plan 04"
          );
        }
        if (block.type === "tool_use" || block.type === "tool_result") {
          throw new Error(
            "ClaudeBackend (Plan 02): tool_use/tool_result round-trip lands in Plan 04"
          );
        }
      }
    }
  }

  private foldMessagesToPrompt(req: NormalizedRequest): string {
    const lines: string[] = [];
    for (const msg of req.messages) {
      const text = msg.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .filter((t) => t.length > 0)
        .join("\n");
      if (text.length === 0) continue;
      lines.push(`${msg.role}: ${text}`);
    }
    return lines.join("\n\n");
  }
}
