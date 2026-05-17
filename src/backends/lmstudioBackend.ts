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

  // eslint-disable-next-line require-yield
  async *invoke(_req: NormalizedRequest): AsyncIterable<NormalizedEvent> {
    throw new Error("LMStudioBackend.invoke() lands in Plan 08 Task 6");
  }

  async embed(
    _req: NormalizedEmbeddingRequest
  ): Promise<NormalizedEmbeddingResponse> {
    throw new Error("LMStudioBackend.embed() lands in Plan 08 Task 7");
  }
}
