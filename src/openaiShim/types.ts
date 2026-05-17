// Subset of the OpenAI Chat Completions + Embeddings + Models API shapes that
// Plan 10 honors. Multimodal image_url blocks, native tool_use, response_format,
// and the n>1 multi-candidate variant are intentionally absent — the request
// translator rejects them with a 400.

// ---- Chat Completions request shapes -------------------------------------

export type OpenAIChatRole = "system" | "user" | "assistant" | "tool" | "function";

export interface OpenAITextContentPart {
  type: "text";
  text: string;
}

/**
 * Content parts the translator may encounter. Plan 10 only honors `text`;
 * `image_url` is listed so the type system catches handling additions in
 * later plans without losing exhaustiveness checks today.
 */
export type OpenAIContentPart =
  | OpenAITextContentPart
  | { type: "image_url"; image_url: { url: string; detail?: string } };

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIChatMessage {
  role: OpenAIChatRole;
  /** May be string, array of parts, or null when `tool_calls` is set on an assistant turn. */
  content?: string | OpenAIContentPart[] | null;
  /** Present on assistant turns when the assistant produced tool calls. */
  tool_calls?: OpenAIToolCall[];
  /** Present on `role: "tool"` turns. */
  tool_call_id?: string;
  /** Legacy `role: "function"` name. */
  name?: string;
}

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface OpenAIChatCompletionsRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: OpenAIToolDefinition[];
  tool_choice?: OpenAIToolChoice;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  n?: number;
  response_format?: { type: string; [k: string]: unknown };
  seed?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  user?: string;
  parallel_tool_calls?: boolean;
  // Accepted-and-ignored extras
  audio?: unknown;
  modalities?: unknown;
  prediction?: unknown;
  service_tier?: string;
  store?: boolean;
}

// ---- Chat Completions response shapes ------------------------------------

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAIChatChoiceMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  refusal?: string | null;
}

export type OpenAIFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call"
  | null;

export interface OpenAIChatChoice {
  index: number;
  message: OpenAIChatChoiceMessage;
  finish_reason: OpenAIFinishReason;
  logprobs?: null;
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatChoice[];
  usage?: OpenAIUsage;
  system_fingerprint?: string;
}

// ---- Chat Completions streaming-chunk shape ------------------------------

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface OpenAIChatChunkDelta {
  role?: "assistant";
  content?: string | null;
  tool_calls?: OpenAIToolCallDelta[];
}

export interface OpenAIChatChunkChoice {
  index: number;
  delta: OpenAIChatChunkDelta;
  finish_reason: OpenAIFinishReason;
  logprobs?: null;
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChatChunkChoice[];
  usage?: OpenAIUsage;
  system_fingerprint?: string;
}

// ---- Embeddings shapes ---------------------------------------------------

export interface OpenAIEmbeddingsRequest {
  model: string;
  input: string | string[];
  encoding_format?: "float" | "base64";
  dimensions?: number;
  user?: string;
}

export interface OpenAIEmbeddingsItem {
  object: "embedding";
  embedding: number[] | string; // string when encoding_format === "base64"
  index: number;
}

export interface OpenAIEmbeddingsResponse {
  object: "list";
  data: OpenAIEmbeddingsItem[];
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

// ---- Models shapes -------------------------------------------------------

export interface OpenAIModelEntry {
  id: string;
  object: "model";
  created: number; // Unix epoch seconds
  owned_by: string;
}

export interface OpenAIModelsListResponse {
  object: "list";
  data: OpenAIModelEntry[];
}

// ---- Streaming meta ------------------------------------------------------

/** Per-request metadata threaded through both translators. */
export interface OpenAIChunkMeta {
  id: string; // `chatcmpl-<uuid>`
  model: string;
  created: number; // Unix epoch seconds
}
