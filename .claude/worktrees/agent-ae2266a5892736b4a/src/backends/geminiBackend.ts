import { Buffer } from "node:buffer";
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
    //   - toolUse: Plan 07 flipped on (was false in Plan 06 baseline)
    return {
      toolUse: true,
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
    this.assertSupportedScope(req);

    const streamOpts: GeminiStreamOptions = {
      prompt: this.foldMessagesToPrompt(req),
      ...(req.system !== undefined ? { systemPrompt: req.system } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.samplingParams?.temperature !== undefined
        ? { temperature: req.samplingParams.temperature }
        : {}),
      ...(req.samplingParams?.topP !== undefined
        ? { topP: req.samplingParams.topP }
        : {}),
      ...(req.samplingParams?.topK !== undefined
        ? { topK: req.samplingParams.topK }
        : {}),
      ...(req.stopSequences && req.stopSequences.length > 0
        ? { stopSequences: req.stopSequences }
        : {}),
      timeoutMs: this.config.timeoutMs,
      geminiCommand: this.config.command
    };

    let startEmitted = false;
    let textIndex = 0;
    let textOpen = false;
    let toolIndex = 0;

    for await (const raw of runGeminiStream(streamOpts)) {
      const ev = raw as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              text?: string;
              functionCall?: { name?: string; args?: unknown };
            }>;
          };
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

      // Emit text deltas for text parts, and tool_use_start/delta/stop for
      // functionCall parts. Unknown shapes are silently ignored.
      const parts = candidate?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part.text === "string" && part.text.length > 0) {
          yield { kind: "text_delta", index: textIndex, text: part.text };
          textOpen = true;
        }
        if (
          part.functionCall &&
          typeof part.functionCall.name === "string"
        ) {
          const fc = part.functionCall;
          const fcName = fc.name as string;
          const callId = `call_${Buffer.from(`${fcName}:${toolIndex}`, "utf8").toString(
            "base64url"
          )}`;
          yield { kind: "tool_use_start", index: toolIndex, id: callId, name: fcName };
          yield {
            kind: "tool_use_delta",
            index: toolIndex,
            partialJson: JSON.stringify(fc.args ?? {})
          };
          yield { kind: "tool_use_stop", index: toolIndex };
          toolIndex++;
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

  // ---- Scope helpers ------------------------------------------------------

  private assertSupportedScope(req: NormalizedRequest): void {
    if (req.thinking) {
      throw new Error(
        "GeminiBackend: thinking-mode (Gemini 2.5) lands in a future plan"
      );
    }
    // image/document/tool_use/tool_result are now in scope per Plan 07.
    // The folded prompt builder will serialize them (see foldMessagesToPrompt).
  }

  private foldMessagesToPrompt(req: NormalizedRequest): string {
    const lines: string[] = [];
    for (const msg of req.messages) {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text") parts.push(block.text);
        else if (block.type === "image")
          parts.push(`[image:${block.mediaType};base64,${block.data}]`);
        else if (block.type === "document")
          parts.push(`[document:${block.mediaType};base64,${block.data}]`);
        else if (block.type === "tool_use")
          parts.push(
            `[tool_use:${block.id}:${block.name}:${JSON.stringify(block.input)}]`
          );
        else if (block.type === "tool_result")
          parts.push(`[tool_result:${block.toolUseId}:${block.content}]`);
        else if (block.type === "thinking") parts.push(block.text);
      }
      const text = parts.filter((s) => s.length > 0).join("\n");
      if (text.length === 0) continue;
      lines.push(`${msg.role}: ${text}`);
    }
    if (req.tools && req.tools.length > 0) {
      lines.push(
        `tools_available: ${JSON.stringify(
          req.tools.map((t) => ({ name: t.name, description: t.description }))
        )}`
      );
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
