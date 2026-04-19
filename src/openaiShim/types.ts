export type OpenAIRole = "system" | "user" | "assistant" | "tool";

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-serialized
  };
};

export type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAIToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>; // JSON Schema
  };
};

export type OpenAIChatCompletionRequest = {
  model?: string;
  messages: OpenAIMessage[];
  tools?: OpenAIToolDefinition[];
  tool_choice?: unknown;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
};

export type OpenAIChatCompletionChoiceMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
};

export type OpenAIChatCompletionResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: OpenAIChatCompletionChoiceMessage;
    finish_reason: "stop" | "tool_calls" | "length" | null;
  }>;
};

export type OpenAIChatCompletionChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: "stop" | "tool_calls" | "length" | null;
  }>;
};

export type OpenAIErrorBody = {
  error: {
    message: string;
    type:
      | "authentication_error"
      | "api_error"
      | "timeout"
      | "invalid_request_error";
    code?: string;
  };
};

// Internal: what the parser/translator emit
export type ParsedToolCall = {
  id: string; // "call_<uuid>"
  name: string;
  argumentsJson: string; // already JSON-stringified
};

export type ParsedClaudeOutput =
  | { kind: "content"; text: string }
  | { kind: "tool_calls"; calls: ParsedToolCall[] };

// Claude Code stream-json event shapes (the subset we care about)
export type StreamJsonSystemInit = {
  type: "system";
  subtype: "init";
  session_id: string;
  model?: string;
  cwd?: string;
};

export type StreamJsonAssistantText = {
  type: "assistant";
  message: {
    content: Array<{ type: "text"; text: string }>;
  };
};

export type StreamJsonResult = {
  type: "result";
  subtype: "success" | "error" | "error_max_turns" | string;
  session_id?: string;
  total_cost_usd?: number;
};

export type StreamJsonEvent =
  | StreamJsonSystemInit
  | StreamJsonAssistantText
  | StreamJsonResult
  | { type: string; [key: string]: unknown };

export type { ClaudeCommand } from "../types.js";
