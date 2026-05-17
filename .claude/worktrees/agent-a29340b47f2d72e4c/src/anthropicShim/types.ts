// Subset of the Anthropic Messages API shape. Plan 04 extends the union to
// typed image/document/tool_use/tool_result variants and adds tool definitions
// and tool_choice shapes.

export type AnthropicRole = "user" | "assistant";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

// ---- Source shapes for image/document -----------------------------------

export interface AnthropicBase64Source {
  type: "base64";
  media_type: string;
  data: string;
}

export interface AnthropicUrlSource {
  type: "url";
  url: string;
}

/**
 * Anthropic also allows `{ type: "file"; file_id: "file_<hash>" }` for the
 * Files API; Plan 04 admits the type but the request translator rejects it
 * with a 400 until Plan 05 lands the file store. Listed here for the type
 * system, not for honoring.
 */
export interface AnthropicFileRefSource {
  type: "file";
  file_id: string;
}

export type AnthropicImageSource =
  | AnthropicBase64Source
  | AnthropicUrlSource
  | AnthropicFileRefSource;
export type AnthropicDocumentSource =
  | AnthropicBase64Source
  | AnthropicUrlSource
  | AnthropicFileRefSource;

// ---- Typed content block variants ---------------------------------------

export interface AnthropicImageBlock {
  type: "image";
  source: AnthropicImageSource;
}

export interface AnthropicDocumentBlock {
  type: "document";
  source: AnthropicDocumentSource;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/**
 * `content` may be a plain string (shorthand) OR an array of nested content
 * blocks (typically text). Anthropic's docs allow tool_result to also wrap
 * images, but Plan 04 only honors the string and text-block-array shapes.
 */
export type AnthropicToolResultContent =
  | string
  | Array<AnthropicTextBlock>;

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: AnthropicToolResultContent;
  /**
   * Optional flag Anthropic uses when the tool reported failure. Plan 04
   * forwards into the prompt envelope; the model decides what to do with it.
   */
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: AnthropicRole;
  /** May be a plain string (shorthand) or an array of blocks. */
  content: string | AnthropicContentBlock[];
}

export type AnthropicSystem = string | AnthropicTextBlock[];

// ---- Tool definitions + tool_choice -------------------------------------

export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema: unknown; // JSON Schema
}

export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "none" }
  | { type: "tool"; name: string };

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
  tools?: AnthropicToolDef[];
  tool_choice?: AnthropicToolChoice;
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

export interface AnthropicResponseToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export type AnthropicResponseContentBlock =
  | AnthropicResponseTextBlock
  | AnthropicResponseToolUseBlock;

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
