import type {
  Backend,
  BackendCapabilities,
  ModelDescriptor,
  NormalizedEmbeddingRequest,
  NormalizedEmbeddingResponse,
  NormalizedEvent,
  NormalizedRequest
} from "./types.js";
import { OllamaNativeClient } from "./ollamaNativeClient.js";
import { OpenAICompatClient } from "./openaiCompatClient.js";

/**
 * Configuration block — structurally identical to `config.ollama` produced by
 * Plan 01's Zod schema. Re-declared here so this module doesn't depend on the
 * concrete `Config` type (keeps unit tests trivial).
 */
export interface OllamaBackendConfig {
  enabled: boolean;
  useNativeApi: boolean;
  instances: Array<{
    name: string;
    baseUrl: string;
    priority: number;
    timeoutMs: number;
    /** null = inherit from backend useNativeApi; true/false = explicit. */
    useNativeApi: boolean | null;
    /** Optional bearer auth (carried through from the shared InstanceSchema). */
    apiKey?: string;
  }>;
}

export type OllamaInstanceMode = "compat" | "native";

/**
 * One resolved per-instance state record. The chosen client matches the
 * effective mode; we hold both interfaces erased to the same callable surface
 * via two branches in invoke() / embed() / listModels().
 */
interface ResolvedInstance {
  name: string;
  priority: number;
  baseUrl: string;
  timeoutMs: number;
  mode: OllamaInstanceMode;
  nativeClient?: OllamaNativeClient;
  compatClient?: OpenAICompatClient;
}

/**
 * Resolve an instance's effective mode given the backend-wide default.
 *   instance.useNativeApi === null → use backend default
 *   else                            → use instance value
 */
function resolveMode(
  backendDefault: boolean,
  instanceFlag: boolean | null
): OllamaInstanceMode {
  const native = instanceFlag === null ? backendDefault : instanceFlag;
  return native ? "native" : "compat";
}

const NATIVE_KEEP_ALIVE = "5m";

export class OllamaBackend implements Backend {
  readonly id = "ollama" as const;

  private readonly instances: ResolvedInstance[];
  private readonly byName: Map<string, ResolvedInstance>;

  constructor(config: OllamaBackendConfig) {
    if (!config.instances || config.instances.length === 0) {
      throw new Error(
        "OllamaBackend: config.ollama.instances must be a non-empty array"
      );
    }

    const seen = new Set<string>();
    const resolved: ResolvedInstance[] = [];
    for (const inst of config.instances) {
      if (seen.has(inst.name)) {
        throw new Error(
          `OllamaBackend: instance names must be unique within ollama; duplicate: ${inst.name}`
        );
      }
      seen.add(inst.name);

      const mode = resolveMode(config.useNativeApi, inst.useNativeApi);
      const record: ResolvedInstance = {
        name: inst.name,
        priority: inst.priority,
        baseUrl: inst.baseUrl,
        timeoutMs: inst.timeoutMs,
        mode
      };
      if (mode === "native") {
        record.nativeClient = new OllamaNativeClient({
          baseUrl: inst.baseUrl,
          timeoutMs: inst.timeoutMs
        });
      } else {
        // OpenAI-compat mode points at /v1 under the Ollama base URL.
        record.compatClient = new OpenAICompatClient({
          baseUrl: `${inst.baseUrl.replace(/\/+$/, "")}/v1`,
          apiKey: inst.apiKey ?? "",
          timeoutMs: inst.timeoutMs
        });
      }
      resolved.push(record);
    }
    this.instances = resolved;
    this.byName = new Map(resolved.map((r) => [r.name, r]));
  }

  /** Test-visible: what mode did instance `name` resolve to? */
  instanceMode(name: string): OllamaInstanceMode {
    const r = this.byName.get(name);
    if (!r) {
      throw new Error(`OllamaBackend.instanceMode: unknown instance ${name}`);
    }
    return r.mode;
  }

  capabilitiesFor(_model: string): BackendCapabilities {
    // Identical shape across both modes. Per-model narrowing (e.g., this
    // particular loaded model has no vision support) is a future plan; the
    // spec's "open questions" notes this explicitly.
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

  // listModels real implementation lands in Task 6.
  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }

  // eslint-disable-next-line require-yield
  async *invoke(_req: NormalizedRequest): AsyncIterable<NormalizedEvent> {
    throw new Error("OllamaBackend.invoke() lands in Plan 09 Task 7");
  }

  async embed(
    _req: NormalizedEmbeddingRequest
  ): Promise<NormalizedEmbeddingResponse> {
    throw new Error("OllamaBackend.embed() lands in Plan 09 Task 9");
  }

  async countTokens(req: NormalizedRequest): Promise<number> {
    // Plan 09 ships the char/4 fallback. A future plan can swap in a real
    // probe via /api/chat with num_predict: 0 (native mode) or POST
    // /v1/chat/completions with max_tokens: 0 (compat mode).
    let total = 0;
    if (req.system) total += Math.ceil(req.system.length / 4);
    for (const msg of req.messages) {
      for (const block of msg.content) {
        if (block.type === "text") total += Math.ceil(block.text.length / 4);
        else if (block.type === "tool_result")
          total += Math.ceil(block.content.length / 4);
        else if (block.type === "tool_use")
          total += Math.ceil(JSON.stringify(block.input).length / 4);
      }
    }
    return total;
  }
}
