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

  async listModels(): Promise<ModelDescriptor[]> {
    // Probe every instance in parallel; tolerate failures per-instance.
    const probed = await Promise.all(
      this.instances.map(async (r) => {
        try {
          const models =
            r.mode === "native"
              ? await this.probeNativeTags(r)
              : await this.probeCompatModels(r);
          return { instance: r, models };
        } catch (err) {
          // Log and contribute no models from this instance. Production code
          // should plug a structured logger here; Plan 09 stays minimal.
          // eslint-disable-next-line no-console
          console.warn(
            `OllamaBackend: instance ${r.name} probe failed: ${err instanceof Error ? err.message : String(err)}`
          );
          return { instance: r, models: [] as ModelDescriptor[] };
        }
      })
    );

    // Sort by descending priority so the first occurrence of each model id
    // wins the dedup pass.
    probed.sort((a, b) => b.instance.priority - a.instance.priority);

    const seen = new Set<string>();
    const out: ModelDescriptor[] = [];
    for (const p of probed) {
      for (const m of p.models) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          out.push(m);
        }
      }
    }
    return out;
  }

  private async probeNativeTags(r: ResolvedInstance): Promise<ModelDescriptor[]> {
    if (!r.nativeClient) {
      throw new Error(`OllamaBackend.probeNativeTags: no nativeClient for ${r.name}`);
    }
    const raw = (await r.nativeClient.listTags()) as {
      models?: Array<{
        name: string;
        details?: { family?: string; parameter_size?: string; quantization_level?: string };
      }>;
    };
    return (raw.models ?? []).map((m) => ({
      id: m.name,
      supportsTools: true,    // conservative; backend says yes, model may not honor at runtime
      supportsVision: true,   // ditto
      description: this.formatTagDescription(m)
    }));
  }

  private formatTagDescription(m: {
    details?: { family?: string; parameter_size?: string; quantization_level?: string };
  }): string {
    const bits: string[] = [];
    if (m.details?.family) bits.push(m.details.family);
    if (m.details?.parameter_size) bits.push(m.details.parameter_size);
    if (m.details?.quantization_level) bits.push(m.details.quantization_level);
    return bits.length > 0 ? bits.join(" · ") : "ollama model";
  }

  private async probeCompatModels(r: ResolvedInstance): Promise<ModelDescriptor[]> {
    if (!r.compatClient) {
      throw new Error(`OllamaBackend.probeCompatModels: no compatClient for ${r.name}`);
    }
    // openaiCompatClient.listModels returns raw entries (Plan 08's shipped
    // surface — different from Plan 09's docs which assumed ModelDescriptor[]).
    // We map id-by-id here to the normalized descriptor shape.
    const raw = await r.compatClient.listModels();
    const out: ModelDescriptor[] = [];
    for (const entry of raw) {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0) {
        out.push({
          id,
          supportsTools: true,
          supportsVision: true
        });
      }
    }
    return out;
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
