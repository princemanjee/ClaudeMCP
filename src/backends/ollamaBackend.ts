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

  /** modelId → name of the highest-priority instance that reports owning it. */
  private modelOwner = new Map<string, string>();

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
          this.modelOwner.set(m.id, p.instance.name);
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

  async *invoke(
    req: NormalizedRequest
  ): AsyncIterable<NormalizedEvent> {
    const instance = this.selectInstance(req.model);

    if (instance.mode === "compat") {
      yield* this.invokeCompat(instance, req);
      return;
    }

    // Native dispatch lands in Task 8.
    throw new Error(
      "OllamaBackend.invoke(): native-mode dispatch lands in Plan 09 Task 8"
    );
  }

  /**
   * Pick the instance that should service `modelId`. Strategy:
   *   1. If listModels has recorded an owner for this model id, use it.
   *   2. Otherwise, fall back to the highest-priority instance and let the
   *      wire return whatever error (unknown model ids surface as a 4xx from
   *      Ollama, which the client surfaces verbatim).
   */
  private selectInstance(modelId: string): ResolvedInstance {
    const ownerName = this.modelOwner.get(modelId);
    if (ownerName) {
      const r = this.byName.get(ownerName);
      if (r) return r;
    }
    // Highest priority fallback.
    let best = this.instances[0];
    if (!best) {
      throw new Error("OllamaBackend.selectInstance: no instances configured");
    }
    for (const r of this.instances) {
      if (r.priority > best.priority) best = r;
    }
    return best;
  }

  /**
   * Compat-mode invocation: openaiCompatClient.chatCompletions returns raw
   * OpenAI SSE chunks (Plan 08's shipped surface differs from Plan 09's
   * docs which assumed a pre-translated AsyncIterable<NormalizedEvent>). We
   * translate here, mirroring LMStudioBackend's translator.
   */
  private async *invokeCompat(
    instance: ResolvedInstance,
    req: NormalizedRequest
  ): AsyncIterable<NormalizedEvent> {
    if (!instance.compatClient) {
      throw new Error(
        `OllamaBackend.invokeCompat: instance ${instance.name} has no compatClient`
      );
    }

    const body = buildCompatBody(req);

    let startEmitted = false;
    let textIndex = 0;
    let textOpen = false;
    const openToolIndices = new Set<number>();
    const toolNamesSeen = new Map<number, string>();

    for await (const raw of instance.compatClient.chatCompletions(body)) {
      const chunk = raw as OpenAIChunk;
      const choice = chunk.choices?.[0];

      if (!startEmitted) {
        startEmitted = true;
        yield { kind: "message_start", model: chunk.model ?? req.model };
      }

      const delta = choice?.delta;

      if (delta?.content && delta.content.length > 0) {
        yield { kind: "text_delta", index: textIndex, text: delta.content };
        textOpen = true;
      }

      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const tcIndex = typeof tc.index === "number" ? tc.index : 0;
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

      if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
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

    if (!startEmitted) {
      yield { kind: "message_start", model: req.model };
    }
    for (const idx of openToolIndices) {
      yield { kind: "tool_use_stop", index: idx };
    }
    yield { kind: "message_stop", stopReason: "error" };
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

// ---- Compat-mode helpers + types (mirrors LMStudioBackend's translator) ----

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
): "end_turn" | "stop_sequence" | "max_tokens" | "tool_use" | "error" {
  switch (openaiReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "error";
    default:
      return "end_turn";
  }
}

/**
 * Translate a NormalizedRequest to an OpenAI-compatible /v1/chat/completions
 * body (flat sampling-params, single `max_tokens`, `stop`, OpenAI tool/message
 * shape). Image and document content blocks are silently skipped because the
 * compat layer is text/JSON-only here.
 */
function buildCompatBody(req: NormalizedRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  if (req.system) {
    messages.push({ role: "system", content: req.system });
  }

  for (const msg of req.messages) {
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

    for (const tr of toolResultBlocks) {
      messages.push({
        role: "tool",
        tool_call_id: tr.toolUseId,
        content: tr.content
      });
    }

    if (toolUseBlocks.length > 0) {
      const textContent = textBlocks.map((b) => b.text).join("\n");
      messages.push({
        role: "assistant",
        content: textContent.length > 0 ? textContent : null,
        tool_calls: toolUseBlocks.map((tu) => ({
          id: tu.id,
          type: "function",
          function: {
            name: tu.name,
            arguments: typeof tu.input === "string"
              ? tu.input
              : JSON.stringify(tu.input ?? {})
          }
        }))
      });
    } else if (textBlocks.length > 0) {
      messages.push({
        role: msg.role,
        content: textBlocks.map((b) => b.text).join("\n")
      });
    }
  }

  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: true
  };

  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

  if (req.samplingParams?.temperature !== undefined)
    body.temperature = req.samplingParams.temperature;
  if (req.samplingParams?.topP !== undefined)
    body.top_p = req.samplingParams.topP;
  if (req.samplingParams?.topK !== undefined)
    body.top_k = req.samplingParams.topK;

  if (req.stopSequences && req.stopSequences.length > 0) {
    body.stop = req.stopSequences;
  }

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
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
