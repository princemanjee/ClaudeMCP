import type {
  NormalizedContentBlock,
  NormalizedMessage,
  NormalizedRequest
} from "../backends/types.js";
import { ShimRequestError } from "./errors.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicSystem
} from "./types.js";

function bad(message: string): never {
  throw new ShimRequestError(400, message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeSystem(system: AnthropicSystem | undefined): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) bad("system must be a string or an array of text blocks");
  const parts: string[] = [];
  for (const block of system) {
    if (!isRecord(block) || block["type"] !== "text" || typeof block["text"] !== "string") {
      bad("system array entries must be text blocks");
    }
    parts.push(block["text"] as string);
  }
  return parts.join("\n\n");
}

function normalizeContentBlock(block: AnthropicContentBlock): NormalizedContentBlock {
  if (!isRecord(block) || typeof block["type"] !== "string") {
    bad("content block must have a string type field");
  }
  // Reject cache_control wherever it appears.
  if (isRecord(block) && "cache_control" in block) {
    bad("cache_control is not supported in Plan 03 (lands in Plan 05)");
  }

  const t = (block as { type: string }).type;
  switch (t) {
    case "text": {
      const text = (block as { text?: unknown }).text;
      if (typeof text !== "string") bad("text content block requires a string text field");
      return { type: "text", text };
    }
    case "image":
      bad("image content blocks are not supported in Plan 03 (multimodal lands in Plan 04)");
      break;
    case "document":
      bad("document content blocks are not supported in Plan 03 (multimodal lands in Plan 04)");
      break;
    case "tool_use":
      bad(
        "tool_use content blocks are not supported in Plan 03 (native tool round-trip lands in Plan 04)"
      );
      break;
    case "tool_result":
      bad(
        "tool_result content blocks are not supported in Plan 03 (native tool round-trip lands in Plan 04)"
      );
      break;
    default:
      bad(`unknown content block type: ${t}`);
  }
}

function normalizeMessage(msg: AnthropicMessage): NormalizedMessage {
  if (!isRecord(msg)) bad("each message must be an object");
  const role = msg["role"];
  if (role !== "user" && role !== "assistant") {
    bad(`unsupported message role: ${String(role)} (must be user or assistant)`);
  }
  const rawContent = msg["content"];
  let blocks: AnthropicContentBlock[];
  if (typeof rawContent === "string") {
    blocks = [{ type: "text", text: rawContent }];
  } else if (Array.isArray(rawContent)) {
    blocks = rawContent as AnthropicContentBlock[];
  } else {
    bad("message.content must be a string or an array of content blocks");
  }
  const normalized = blocks.map(normalizeContentBlock);
  return { role, content: normalized };
}

export function anthropicRequestToNormalized(
  body: AnthropicMessagesRequest
): NormalizedRequest {
  if (!isRecord(body)) bad("request body must be a JSON object");

  const model = (body as { model?: unknown }).model;
  if (typeof model !== "string" || model.length === 0) {
    bad("model is required and must be a non-empty string");
  }

  const rawMessages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(rawMessages)) bad("messages is required and must be an array");
  if (rawMessages.length === 0) bad("messages must contain at least one message");

  // Out-of-scope scalar fields
  if ("thinking" in body && body.thinking !== undefined) {
    bad(
      "thinking is not supported in Plan 03 (extended thinking lands in Plan 04)"
    );
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    bad("tools is not supported in Plan 03 (native tool round-trip lands in Plan 04)");
  }
  if ("tool_choice" in body && body.tool_choice !== undefined) {
    bad("tool_choice is not supported in Plan 03 (native tool round-trip lands in Plan 04)");
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    bad("stop_sequences is not supported in Plan 03 (server-side cut lands in Plan 04)");
  }

  const messages = (rawMessages as AnthropicMessage[]).map(normalizeMessage);
  const system = normalizeSystem(body.system);

  const samplingParams =
    body.temperature !== undefined || body.top_p !== undefined || body.top_k !== undefined
      ? {
          ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
          ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
          ...(body.top_k !== undefined ? { topK: body.top_k } : {})
        }
      : undefined;

  const out: NormalizedRequest = {
    model,
    messages
  };
  if (system !== undefined) out.system = system;
  if (typeof body.max_tokens === "number") out.maxTokens = body.max_tokens;
  if (samplingParams) out.samplingParams = samplingParams;
  if (isRecord(body.metadata)) out.metadata = body.metadata;
  return out;
}
