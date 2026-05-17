import type {
  Backend,
  BackendCapabilities,
  ModelDescriptor,
  NormalizedEvent,
  NormalizedRequest
} from "./types.js";
import { runClaudeStream } from "../runners/claudeStreamRunner.js";
import type { ClaudeStreamOptions } from "../runners/types.js";
import { estimateRequestTokens } from "../tokenEstimator.js";

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
    return estimateRequestTokens(req);
  }

  async *invoke(
    req: NormalizedRequest
  ): AsyncIterable<NormalizedEvent> {
    const streamOpts: ClaudeStreamOptions = {
      prompt: this.foldMessagesToPrompt(req),
      systemPrompt: this.applyToolChoiceDirective(req.system, req.toolChoice),
      tools: req.tools,
      stopSequences: req.stopSequences,
      timeoutMs: this.config.timeoutMs,
      claudeCommand: this.config.command,
      dangerouslySkipPermissions: true
    };

    let startEmitted = false;
    let textIndex = 0;
    let textOpen = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: Extract<NormalizedEvent, { kind: "message_stop" }>["stopReason"] =
      "end_turn";

    for await (const raw of runClaudeStream(streamOpts)) {
      const ev = raw as {
        type?: string;
        subtype?: string;
        session_id?: string;
        model?: string;
        message?: {
          content?: Array<{
            type?: string;
            text?: string;
            id?: string;
            name?: string;
            input?: unknown;
          }>;
        };
        usage?: { input_tokens?: number; output_tokens?: number };
        is_error?: boolean;
        matchedSequence?: string;
      };

      // Stop-sequence sentinel (from claudeStreamRunner cutter).
      if (ev.type === "_internal" && ev.subtype === "stop_sequence_match") {
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
          stopReason: "stop_sequence",
          usage:
            inputTokens + outputTokens > 0
              ? { inputTokens, outputTokens }
              : undefined
        };
        return;
      }

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
            // Empty-text blocks happen when the cutter truncated at offset 0;
            // skip them so we don't emit a zero-byte text_delta.
            if (block.text.length === 0) continue;
            yield { kind: "text_delta", index: textIndex, text: block.text };
            textOpen = true;
          } else if (
            block.type === "tool_use" &&
            typeof block.id === "string" &&
            typeof block.name === "string"
          ) {
            // Close any open text block first so tool_use claims a fresh index.
            if (textOpen) {
              textIndex++;
              textOpen = false;
            }
            const useIndex = textIndex;
            textIndex++;
            yield {
              kind: "tool_use_start",
              index: useIndex,
              id: block.id,
              name: block.name
            };
            yield {
              kind: "tool_use_delta",
              index: useIndex,
              partialJson: JSON.stringify(block.input ?? {})
            };
            yield { kind: "tool_use_stop", index: useIndex };
            stopReason = "tool_use";
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
          stopReason: ev.is_error ? "error" : stopReason,
          usage:
            inputTokens + outputTokens > 0
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

  // ---- Helpers ----------------------------------------------------------

  /**
   * Serialize a NormalizedRequest's message history into a single prompt
   * string suitable for the Claude CLI's `-p <prompt>` flag.
   *
   * Each message gets a leading `<role>:` line. Within a message, content
   * blocks are concatenated in order. Non-text blocks use envelope markers
   * that the CLI sees as plain text but a downstream model can recognize:
   *   [image:<mediaType>;base64,<data>]
   *   [document:<mediaType>;base64,<data>]
   *   [tool_use:<id>:<name>]<json-input>[/tool_use]
   *   [tool_result:<tool_use_id>]<content>[/tool_result]
   *
   * Empty messages (no usable content after serialization) are skipped.
   */
  private foldMessagesToPrompt(req: NormalizedRequest): string {
    const lines: string[] = [];
    for (const msg of req.messages) {
      const parts: string[] = [];
      for (const block of msg.content) {
        switch (block.type) {
          case "text":
            if (block.text.length > 0) parts.push(block.text);
            break;
          case "image":
            parts.push(`[image:${block.mediaType};base64,${block.data}]`);
            break;
          case "document":
            parts.push(`[document:${block.mediaType};base64,${block.data}]`);
            break;
          case "tool_use":
            parts.push(
              `[tool_use:${block.id}:${block.name}]${JSON.stringify(block.input)}[/tool_use]`
            );
            break;
          case "tool_result":
            parts.push(
              `[tool_result:${block.toolUseId}]${block.content}[/tool_result]`
            );
            break;
          case "thinking":
            // Skip — thinking blocks are not user-facing on the request side.
            break;
        }
      }
      if (parts.length === 0) continue;
      lines.push(`${msg.role}: ${parts.join("\n")}`);
    }
    return lines.join("\n\n");
  }

  /**
   * Append the tool_choice system directive per the spec's enforcement
   * table. Best-effort — the model usually honors but the CLI has no flag
   * to force a specific tool name. Returns the system prompt unchanged for
   * tool_choice "auto" or undefined.
   */
  private applyToolChoiceDirective(
    system: string | undefined,
    toolChoice: NormalizedRequest["toolChoice"]
  ): string | undefined {
    if (toolChoice === undefined || toolChoice === "auto") {
      return system;
    }
    let directive: string;
    if (toolChoice === "any") {
      directive = "You must call exactly one tool this turn.";
    } else if (toolChoice === "none") {
      directive = "Do not call any tools this turn.";
    } else {
      // toolChoice is { type: "tool", name: "..." }
      directive = `If you call a tool, only call \`${toolChoice.name}\`.`;
    }
    if (!system || system.length === 0) return directive;
    return `${system}\n\n${directive}`;
  }
}
