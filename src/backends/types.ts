export type BackendId = "claude" | "gemini" | "lmstudio" | "ollama";

// ---- Capability matrix ----------------------------------------------------

export interface BackendCapabilities {
  toolUse: boolean;
  multimodal: boolean;
  thinking: boolean;
  cacheControl: "native" | "local-emulation" | "none";
  samplingParams: { temperature: boolean; topP: boolean; topK: boolean };
  stopSequences: "native" | "server-side-cut";
  embeddings: boolean;
}

// ---- Normalized request shape --------------------------------------------

export type NormalizedRole = "user" | "assistant" | "tool";

// Content blocks use `type` as discriminant to match the Anthropic Messages API
// shape so translators can spread blocks through without renaming.
export type NormalizedContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "image"; mediaType: string; data: string /* base64 */ }
  | { type: "document"; mediaType: string; data: string /* base64 */ }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string };

export interface NormalizedMessage {
  role: NormalizedRole;
  content: NormalizedContentBlock[];
}

export interface NormalizedToolDef {
  name: string;
  description?: string;
  inputSchema: unknown; // JSON Schema
}

export type NormalizedToolChoice =
  | "auto"
  | "any"
  | "none"
  | { type: "tool"; name: string };

export interface NormalizedSamplingParams {
  temperature?: number;
  topP?: number;
  topK?: number;
}

export interface NormalizedRequest {
  model: string;
  system?: string;
  messages: NormalizedMessage[];
  tools?: NormalizedToolDef[];
  toolChoice?: NormalizedToolChoice;
  stopSequences?: string[];
  maxTokens?: number;
  samplingParams?: NormalizedSamplingParams;
  metadata?: Record<string, unknown>;
  thinking?: boolean;
}

// ---- Normalized streaming event union ------------------------------------

// Stream events use `kind` (not `type`) to avoid collision with `Event.type`
// in browser/DOM ambient typings and to differentiate from content-block types
// at the call site.
export type NormalizedEvent =
  | { kind: "message_start"; model: string }
  | { kind: "text_delta"; index: number; text: string }
  | { kind: "thinking_delta"; index: number; text: string }
  | { kind: "tool_use_start"; index: number; id: string; name: string }
  | { kind: "tool_use_delta"; index: number; partialJson: string }
  | { kind: "tool_use_stop"; index: number }
  | {
      kind: "message_stop";
      stopReason:
        | "end_turn"
        | "stop_sequence"
        | "max_tokens"
        | "tool_use"
        | "error";
      usage?: { inputTokens: number; outputTokens: number };
    };

// ---- Embeddings -----------------------------------------------------------

export interface NormalizedEmbeddingRequest {
  model: string;
  input: string[];
}

export interface NormalizedEmbeddingResponse {
  model: string;
  embeddings: number[][];
}

// ---- Model metadata -------------------------------------------------------

export interface ModelDescriptor {
  id: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  description?: string;
}

// ---- Backend interface ---------------------------------------------------

export interface Backend {
  readonly id: BackendId;
  capabilitiesFor(model: string): BackendCapabilities;
  listModels(): Promise<ModelDescriptor[]>;
  invoke(req: NormalizedRequest): AsyncIterable<NormalizedEvent>;
  countTokens(req: NormalizedRequest): Promise<number>;
  embed?(
    req: NormalizedEmbeddingRequest
  ): Promise<NormalizedEmbeddingResponse>;
}
