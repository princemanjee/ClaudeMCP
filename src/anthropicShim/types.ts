// Subset of the Anthropic Messages API shape that Plan 03 honors. Tool_use,
// multimodal, cache_control, file references, and thinking blocks are
// intentionally absent — the request translator rejects them with a 400.

export type AnthropicRole = "user" | "assistant";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

/**
 * Content blocks the translator may encounter. Plan 03 only honors `text`;
 * the rest are listed so the type system catches handling additions in later
 * plans without losing exhaustiveness checks today.
 */
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | { type: "image"; source: unknown }
  | { type: "document"; source: unknown }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown };

export interface AnthropicMessage {
  role: AnthropicRole;
  /** May be a plain string (shorthand) or an array of blocks. */
  content: string | AnthropicContentBlock[];
}

export type AnthropicSystem = string | AnthropicTextBlock[];

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: AnthropicSystem;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: unknown[];
  tool_choice?: unknown;
  metadata?: Record<string, unknown>;
  thinking?: unknown;
}

// ---- Response shapes ------------------------------------------------------

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface AnthropicResponseTextBlock {
  type: "text";
  text: string;
}

export type AnthropicResponseContentBlock = AnthropicResponseTextBlock;

export type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use";

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicResponseContentBlock[];
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

// ---- Count tokens shapes --------------------------------------------------

export interface AnthropicCountTokensResponse {
  input_tokens: number;
}

// ---- Models shapes --------------------------------------------------------

export interface AnthropicModelEntry {
  type: "model";
  id: string;
  display_name: string;
  created_at: string; // ISO-8601
}

export interface AnthropicModelsListResponse {
  data: AnthropicModelEntry[];
  has_more: false;
  first_id: string | null;
  last_id: string | null;
}
