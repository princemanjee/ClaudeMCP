import type {
  Backend,
  BackendCapabilities,
  ModelDescriptor,
  NormalizedEvent,
  NormalizedRequest
} from "./types.js";

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

  // eslint-disable-next-line require-yield
  async *invoke(_req: NormalizedRequest): AsyncIterable<NormalizedEvent> {
    throw new Error("ClaudeBackend.invoke() lands in Plan 02 Task 6");
  }
}
