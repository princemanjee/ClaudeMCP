import type {
  Backend,
  BackendCapabilities,
  ModelDescriptor,
  NormalizedEmbeddingRequest,
  NormalizedEmbeddingResponse,
  NormalizedEvent,
  NormalizedRequest
} from "./types.js";
import { OpenAICompatClient } from "./openaiCompatClient.js";

export interface LMStudioInstanceConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  priority: number;
  timeoutMs: number;
  useNativeApi: boolean | null; // unused for LM Studio (Ollama only); accepted for config-shape parity
}

export interface LMStudioBackendConfig {
  enabled: boolean;
  instances: LMStudioInstanceConfig[];
}

interface InstanceState {
  config: LMStudioInstanceConfig;
  client: OpenAICompatClient;
  /** Models last reported by this instance's GET /v1/models. Populated by listModels(). */
  lastModels: ModelDescriptor[];
  /** Last time this instance was probed (epoch ms). 0 means never. */
  lastProbedAt: number;
}

/**
 * Char-count token estimator. ceil(charCount / 4); same fallback as the other
 * backends. LM Studio's own `/v1/chat/completions` with `max_tokens: 0` is the
 * only "real" tokenizer it exposes, and that costs a full HTTP round-trip per
 * countTokens call. The default path stays cheap; a future spec can offer an
 * opt-in real-tokenization mode. See open question below.
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
    }
  }
  return total;
}

export class LMStudioBackend implements Backend {
  readonly id = "lmstudio" as const;

  // Map keyed by instance name. Order is insertion order; for multi-instance
  // dispatch we sort by priority descending at lookup time (Task 8).
  private readonly instances = new Map<string, InstanceState>();

  constructor(config: LMStudioBackendConfig) {
    if (config.instances.length === 0) {
      throw new Error(
        "LMStudioBackend: instances must be non-empty (config.lmstudio.instances)"
      );
    }
    const seen = new Set<string>();
    for (const inst of config.instances) {
      if (seen.has(inst.name)) {
        throw new Error(
          `LMStudioBackend: instance names must be unique; duplicate: ${inst.name}`
        );
      }
      seen.add(inst.name);
      this.instances.set(inst.name, {
        config: inst,
        client: new OpenAICompatClient({
          baseUrl: inst.baseUrl,
          apiKey: inst.apiKey || undefined,
          timeoutMs: inst.timeoutMs
        }),
        lastModels: [],
        lastProbedAt: 0
      });
    }
  }

  capabilitiesFor(_model: string): BackendCapabilities {
    return {
      toolUse: true,
      multimodal: true,
      thinking: false,
      cacheControl: "none",
      samplingParams: { temperature: true, topP: true, topK: true },
      stopSequences: "native",
      embeddings: true
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    // Probe every instance. Collect into a Map keyed by model id; the
    // higher-priority instance wins on collision. (Within a backend; the
    // BackendRegistry handles cross-backend collisions separately.)
    const merged = new Map<string, { descriptor: ModelDescriptor; priority: number }>();
    const sorted = [...this.instances.values()].sort(
      (a, b) => b.config.priority - a.config.priority
    );

    for (const state of sorted) {
      try {
        const raw = await state.client.listModels();
        const descriptors: ModelDescriptor[] = [];
        for (const entry of raw) {
          // We consume ONLY `id`; LM Studio's response may include extra fields
          // like `loaded`, `architecture`, `quantization` — those are ignored.
          const id = (entry as { id?: unknown }).id;
          if (typeof id !== "string" || id.length === 0) continue;
          descriptors.push({ id });
        }
        state.lastModels = descriptors;
        state.lastProbedAt = Date.now();
        for (const d of descriptors) {
          const existing = merged.get(d.id);
          if (!existing || existing.priority < state.config.priority) {
            merged.set(d.id, { descriptor: d, priority: state.config.priority });
          }
        }
      } catch {
        // Probe failure: leave lastModels untouched (or stale). The instance
        // remains unreachable for routing until the next successful probe.
        // No throw — a single failing instance shouldn't black-hole the others.
      }
    }

    return Array.from(merged.values()).map((v) => v.descriptor);
  }

  async countTokens(req: NormalizedRequest): Promise<number> {
    return sumRequestTokens(req);
  }

  async *invoke(req: NormalizedRequest): AsyncIterable<NormalizedEvent> {
    this.assertPlan08Scope(req);

    // Strip a possible `<backend>:<instance>/` prefix from the model id
    // before forwarding to LM Studio. Task 8 resolves which instance handles
    // the request; here we just pass the model id LM Studio expects.
    const { instance, modelId } = this.resolveInstanceAndModel(req.model);

    const body = this.translateRequestToOpenAIBody(req, modelId);

    let startEmitted = false;
    let textIndex = 0;
    let textOpen = false;
    // Track open tool calls by their `index` to map deltas back to the start.
    const openToolIndices = new Set<number>();
    // Also track names already announced per index, since OpenAI sends the
    // function.name only on the first delta for that index.
    const toolNamesSeen = new Map<number, string>();

    for await (const raw of instance.client.chatCompletions(body)) {
      const chunk = raw as OpenAIChunk;
      const choice = chunk.choices?.[0];

      if (!startEmitted) {
        startEmitted = true;
        yield { kind: "message_start", model: chunk.model ?? req.model };
      }

      const delta = choice?.delta;

      // Text deltas
      if (delta?.content && delta.content.length > 0) {
        yield { kind: "text_delta", index: textIndex, text: delta.content };
        textOpen = true;
      }

      // Tool-call deltas
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const tcIndex = typeof tc.index === "number" ? tc.index : 0;

          // First time we see this index AND it has an id+function.name, emit
          // tool_use_start.
          if (!openToolIndices.has(tcIndex)) {
            const id = tc.id;
            const name = tc.function?.name;
            if (typeof id === "string" && typeof name === "string") {
              openToolIndices.add(tcIndex);
              toolNamesSeen.set(tcIndex, name);
              yield { kind: "tool_use_start", index: tcIndex, id, name };
            }
          }

          const argsDelta = tc.function?.arguments;
          if (typeof argsDelta === "string" && argsDelta.length > 0) {
            yield {
              kind: "tool_use_delta",
              index: tcIndex,
              partialJson: argsDelta
            };
          }
        }
      }

      // Terminal chunk
      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
        // Close any open tool indices.
        for (const idx of openToolIndices) {
          yield { kind: "tool_use_stop", index: idx };
        }
        if (textOpen) {
          textIndex++;
          textOpen = false;
        }
        const usage = chunk.usage
          ? {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0
            }
          : undefined;
        yield {
          kind: "message_stop",
          stopReason: mapFinishReason(choice.finish_reason),
          usage:
            usage && usage.inputTokens + usage.outputTokens > 0
              ? usage
              : undefined
        };
        return;
      }
    }

    // Stream ended without an explicit terminal chunk.
    if (!startEmitted) {
      yield { kind: "message_start", model: req.model };
    }
    for (const idx of openToolIndices) {
      yield { kind: "tool_use_stop", index: idx };
    }
    yield { kind: "message_stop", stopReason: "error" };
  }

  // ---- Plan-08 scope helpers --------------------------------------------

  private assertPlan08Scope(req: NormalizedRequest): void {
    if (req.thinking) {
      throw new Error(
        "LMStudioBackend (Plan 08): thinking-mode is not supported"
      );
    }
    for (const msg of req.messages) {
      for (const block of msg.content) {
        if (block.type === "image") {
          throw new Error(
            "LMStudioBackend (Plan 08): multimodal image content lands in a future plan (per-shim Files-API wiring)"
          );
        }
        if (block.type === "document") {
          throw new Error(
            "LMStudioBackend (Plan 08): document content lands in a future plan"
          );
        }
      }
    }
  }

  /**
   * Translate the normalized request to an OpenAI chat-completions body.
   * Tool-use semantics, system prepending, and sampling-param forwarding all
   * land here. The `model` field is forwarded verbatim — instance resolution
   * happens in `resolveInstanceAndModel` before this is called.
   */
  private translateRequestToOpenAIBody(
    req: NormalizedRequest,
    modelId: string
  ): Record<string, unknown> {
    const messages: Array<Record<string, unknown>> = [];

    if (req.system) {
      messages.push({ role: "system", content: req.system });
    }

    for (const msg of req.messages) {
      // Collect tool_use blocks for assistant role -> tool_calls array.
      const toolUseBlocks = msg.content.filter(
        (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use"
      );
      const toolResultBlocks = msg.content.filter(
        (b): b is Extract<typeof b, { type: "tool_result" }> =>
          b.type === "tool_result"
      );
      const textBlocks = msg.content.filter(
        (b): b is Extract<typeof b, { type: "text" }> => b.type === "text"
      );

      // tool_result -> separate {role: "tool"} message per result.
      for (const tr of toolResultBlocks) {
        messages.push({
          role: "tool",
          tool_call_id: tr.toolUseId,
          content: tr.content
        });
      }

      if (toolUseBlocks.length > 0) {
        // Assistant message containing tool_calls.
        const textContent = textBlocks.map((b) => b.text).join("\n");
        messages.push({
          role: "assistant",
          content: textContent.length > 0 ? textContent : null,
          tool_calls: toolUseBlocks.map((tu) => ({
            id: tu.id,
            type: "function",
            function: {
              name: tu.name,
              arguments: JSON.stringify(tu.input ?? {})
            }
          }))
        });
      } else if (textBlocks.length > 0) {
        // Plain text message.
        messages.push({
          role: msg.role,
          content: textBlocks.map((b) => b.text).join("\n")
        });
      }
    }

    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      stream: true
    };

    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

    if (req.samplingParams?.temperature !== undefined)
      body.temperature = req.samplingParams.temperature;
    if (req.samplingParams?.topP !== undefined)
      body.top_p = req.samplingParams.topP;
    if (req.samplingParams?.topK !== undefined)
      body.top_k = req.samplingParams.topK; // non-standard but LM Studio honors it on llama.cpp models

    if (req.stopSequences && req.stopSequences.length > 0) {
      body.stop = req.stopSequences;
    }

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema
        }
      }));
    }

    if (req.toolChoice !== undefined) {
      if (req.toolChoice === "auto") body.tool_choice = "auto";
      else if (req.toolChoice === "any") body.tool_choice = "required";
      else if (req.toolChoice === "none") body.tool_choice = "none";
      else if (typeof req.toolChoice === "object" && req.toolChoice.type === "tool") {
        body.tool_choice = {
          type: "function",
          function: { name: req.toolChoice.name }
        };
      }
    }

    return body;
  }

  /**
   * Resolve the request's model id to (a) which instance handles it and (b)
   * the model id to forward (with any instance prefix stripped). Task 8 wires
   * the multi-instance dispatch; in Tasks 5-7 there's only one instance, so
   * resolution is trivial. The helper is defined here to keep the call site in
   * invoke() stable across tasks.
   */
  private resolveInstanceAndModel(
    requestedModel: string
  ): { instance: InstanceState; modelId: string } {
    // Strip the optional `lmstudio:<instance>/` prefix if the model arrives
    // that way (per the spec's prefix-override syntax).
    let modelId = requestedModel;
    let forcedInstance: string | undefined;
    const prefixMatch = /^lmstudio:([^/]+)\/(.+)$/.exec(requestedModel);
    if (prefixMatch && prefixMatch[1] && prefixMatch[2]) {
      forcedInstance = prefixMatch[1];
      modelId = prefixMatch[2];
    }

    if (forcedInstance) {
      const inst = this.instances.get(forcedInstance);
      if (!inst) {
        throw new Error(
          `LMStudioBackend: no instance named "${forcedInstance}" configured`
        );
      }
      return { instance: inst, modelId };
    }

    // Default: pick the highest-priority instance that reported the model in
    // its last successful probe. If no instance has the model, fall back to
    // the highest-priority instance (LM Studio will surface its own 400 for
    // an unknown model id, which is the user-friendly outcome).
    const candidates = [...this.instances.values()]
      .filter((s) => s.lastModels.some((m) => m.id === modelId))
      .sort((a, b) => b.config.priority - a.config.priority);
    if (candidates.length > 0) {
      return { instance: candidates[0]!, modelId };
    }
    const fallback = [...this.instances.values()].sort(
      (a, b) => b.config.priority - a.config.priority
    )[0];
    if (!fallback) {
      throw new Error("LMStudioBackend: no instances available");
    }
    return { instance: fallback, modelId };
  }

  async embed(
    _req: NormalizedEmbeddingRequest
  ): Promise<NormalizedEmbeddingResponse> {
    throw new Error("LMStudioBackend.embed() lands in Plan 08 Task 7");
  }
}

// ---- Module-scope helpers + types ----------------------------------------

interface OpenAIChunk {
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function mapFinishReason(
  openaiReason: string
):
  | "end_turn"
  | "stop_sequence"
  | "max_tokens"
  | "tool_use"
  | "error" {
  switch (openaiReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call": // deprecated OpenAI name; still used by some servers
      return "tool_use";
    case "content_filter":
      return "error";
    default:
      return "end_turn";
  }
}
