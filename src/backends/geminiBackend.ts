import type {
  Backend,
  BackendCapabilities,
  ModelDescriptor,
  NormalizedEvent,
  NormalizedRequest
} from "./types.js";
import { runGeminiStream } from "../runners/geminiStreamRunner.js";
import type { GeminiStreamOptions } from "../runners/types.js";

export interface GeminiBackendConfig {
  /** Either the executable name (e.g. "gemini") or [executable, ...prefix-args]. */
  command: string | string[];
  /** Per-call timeout in milliseconds. */
  timeoutMs: number;
}

/**
 * Curated catalog of Gemini models the backend reports. The CLI itself has no
 * model-listing endpoint, so this is maintained here. Late-2025 lineup:
 *   - gemini-pro          / gemini-2.5-pro
 *   - gemini-flash        / gemini-2.5-flash
 *   - gemini-flash-lite   / gemini-2.5-flash-lite
 *
 * The dotted-version variants exist so callers pinning an exact version still
 * resolve to this backend. When Google ships a new generation (e.g. 3.x), add
 * the new IDs here and update `capabilitiesFor` if their surface differs.
 *
 * Context-window numbers reflect the documented Gemini 2.x limits (1M input
 * tokens, 8K output). When these change for a future model, narrow on a
 * per-id basis in this list rather than papering over with one constant.
 */
const MODEL_CATALOG: ModelDescriptor[] = [
  {
    id: "gemini-pro",
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    description: "Most capable Gemini model. Long-context (1M)."
  },
  {
    id: "gemini-2.5-pro",
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    description: "Dotted-version alias of gemini-pro for explicit-version callers."
  },
  {
    id: "gemini-flash",
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    description: "Balanced Gemini model. Lower latency than pro."
  },
  {
    id: "gemini-2.5-flash",
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    description: "Dotted-version alias of gemini-flash."
  },
  {
    id: "gemini-flash-lite",
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    description: "Fastest, cheapest Gemini model."
  },
  {
    id: "gemini-2.5-flash-lite",
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    description: "Dotted-version alias of gemini-flash-lite."
  }
];

/**
 * Char-count token estimator. ceil(charCount / 4) is a standard rough
 * approximation; later plans (or a Plan-05 follow-up if available by then) may
 * swap in `@google/generative-ai`'s tokenizer. For Plan 06 this is what ships.
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
      // image / document blocks: ignored for now; Plan 05/07 add proper accounting.
    }
  }
  return total;
}

export class GeminiBackend implements Backend {
  readonly id = "gemini" as const;

  constructor(private readonly config: GeminiBackendConfig) {}

  capabilitiesFor(_model: string): BackendCapabilities {
    // Same surface across all Gemini models for now. The notable contrasts
    // with Claude's surface:
    //   - samplingParams.{temperature,topP,topK}: TRUE (Claude has all false)
    //   - stopSequences: "native" (Claude is "server-side-cut")
    //   - toolUse: false in Plan 06 baseline; Plan 07 turns it on with the shim
    return {
      toolUse: false,
      multimodal: true,
      thinking: false,
      cacheControl: "none",
      samplingParams: { temperature: true, topP: true, topK: true },
      stopSequences: "native",
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
    this.assertPlan06Scope(req);

    const streamOpts: GeminiStreamOptions = {
      prompt: this.foldMessagesToPrompt(req),
      systemPrompt: req.system,
      model: req.model,
      temperature: req.samplingParams?.temperature,
      topP: req.samplingParams?.topP,
      topK: req.samplingParams?.topK,
      timeoutMs: this.config.timeoutMs,
      geminiCommand: this.config.command
    };

    let startEmitted = false;
    let textIndex = 0;
    let textOpen = false;

    for await (const raw of runGeminiStream(streamOpts)) {
      const ev = raw as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          finishReason?: string;
        }>;
        modelVersion?: string;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
        };
      };

      const candidate = ev.candidates?.[0];

      if (!startEmitted) {
        startEmitted = true;
        yield { kind: "message_start", model: ev.modelVersion ?? req.model };
      }

      // Emit text deltas for each text part in this chunk.
      const parts = candidate?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part.text === "string" && part.text.length > 0) {
          yield { kind: "text_delta", index: textIndex, text: part.text };
          textOpen = true;
        }
      }

      // If this chunk has a finishReason, it's the terminal chunk: emit
      // message_stop and return.
      if (candidate?.finishReason !== undefined) {
        if (textOpen) {
          textIndex++;
          textOpen = false;
        }
        const usage = ev.usageMetadata
          ? {
              inputTokens: ev.usageMetadata.promptTokenCount ?? 0,
              outputTokens: ev.usageMetadata.candidatesTokenCount ?? 0
            }
          : undefined;
        yield {
          kind: "message_stop",
          stopReason: mapFinishReason(candidate.finishReason),
          usage:
            usage && usage.inputTokens + usage.outputTokens > 0
              ? usage
              : undefined
        };
        return;
      }
    }

    // Stream ended without an explicit finishReason chunk (e.g. process killed
    // by timeout). Emit a synthesized message_stop so callers always see one.
    if (!startEmitted) {
      yield { kind: "message_start", model: req.model };
    }
    yield { kind: "message_stop", stopReason: "error" };
  }

  // ---- Plan-06 scope helpers ---------------------------------------------

  private assertPlan06Scope(req: NormalizedRequest): void {
    if (req.tools && req.tools.length > 0) {
      throw new Error(
        "GeminiBackend (Plan 06): native tool calling lands in Plan 07"
      );
    }
    if (req.stopSequences && req.stopSequences.length > 0) {
      throw new Error(
        "GeminiBackend (Plan 06): stop_sequences land in Plan 07"
      );
    }
    if (req.thinking) {
      throw new Error(
        "GeminiBackend (Plan 06): thinking-mode lands in a follow-up plan"
      );
    }
    for (const msg of req.messages) {
      for (const block of msg.content) {
        if (block.type === "image" || block.type === "document") {
          throw new Error(
            "GeminiBackend (Plan 06): multimodal content lands in Plan 07"
          );
        }
        if (block.type === "tool_use" || block.type === "tool_result") {
          throw new Error(
            "GeminiBackend (Plan 06): tool_use/tool_result round-trip lands in Plan 07"
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

function mapFinishReason(
  geminiReason: string
):
  | "end_turn"
  | "stop_sequence"
  | "max_tokens"
  | "tool_use"
  | "error" {
  switch (geminiReason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "OTHER":
      return "error";
    default:
      return "end_turn";
  }
}
