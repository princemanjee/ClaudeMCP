import type {
  NormalizedContentBlock,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedToolChoice,
  NormalizedToolDef
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
  if (isRecord(block) && "cache_control" in block) {
    bad("cache_control is not supported in Plan 04 (lands in Plan 05)");
  }

  const t = (block as { type: string }).type;
  switch (t) {
    case "text": {
      const text = (block as { text?: unknown }).text;
      if (typeof text !== "string") bad("text content block requires a string text field");
      return { type: "text", text };
    }
    case "image": {
      const source = (block as { source?: unknown }).source;
      if (!isRecord(source)) bad("image content block requires a source object");
      const srcType = source["type"];
      if (srcType === "url") {
        bad("image source.type 'url' is not supported (URL fetching lands in Plan 05)");
      }
      if (srcType === "file") {
        bad("image source.type 'file' is not supported (file_<hash> resolution lands in Plan 05)");
      }
      if (srcType !== "base64") bad(`unsupported image source.type: ${String(srcType)}`);
      const mediaType = source["media_type"];
      const data = source["data"];
      if (typeof mediaType !== "string") bad("image source requires a string media_type");
      if (typeof data !== "string") bad("image source requires a string data");
      return { type: "image", mediaType, data };
    }
    case "document": {
      const source = (block as { source?: unknown }).source;
      if (!isRecord(source)) bad("document content block requires a source object");
      const srcType = source["type"];
      if (srcType === "url") {
        bad("document source.type 'url' is not supported (URL fetching lands in Plan 05)");
      }
      if (srcType === "file") {
        bad(
          "document source.type 'file' is not supported (file_<hash> resolution lands in Plan 05)"
        );
      }
      if (srcType !== "base64") bad(`unsupported document source.type: ${String(srcType)}`);
      const mediaType = source["media_type"];
      const data = source["data"];
      if (typeof mediaType !== "string") bad("document source requires a string media_type");
      if (typeof data !== "string") bad("document source requires a string data");
      return { type: "document", mediaType, data };
    }
    case "tool_use": {
      const id = (block as { id?: unknown }).id;
      const name = (block as { name?: unknown }).name;
      const input = (block as { input?: unknown }).input;
      if (typeof id !== "string") bad("tool_use content block requires a string id");
      if (typeof name !== "string") bad("tool_use content block requires a string name");
      return { type: "tool_use", id, name, input };
    }
    case "tool_result": {
      const toolUseId = (block as { tool_use_id?: unknown }).tool_use_id;
      if (typeof toolUseId !== "string") {
        bad("tool_result content block requires a string tool_use_id");
      }
      const rawContent = (block as { content?: unknown }).content;
      let content: string;
      if (typeof rawContent === "string") {
        content = rawContent;
      } else if (Array.isArray(rawContent)) {
        const parts: string[] = [];
        for (const part of rawContent) {
          if (
            isRecord(part) &&
            part["type"] === "text" &&
            typeof part["text"] === "string"
          ) {
            parts.push(part["text"] as string);
          } else {
            bad("tool_result.content array entries must be text blocks");
          }
        }
        content = parts.join("\n");
      } else {
        bad("tool_result.content must be a string or an array of text blocks");
      }
      return { type: "tool_result", toolUseId, content };
    }
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

function normalizeToolDef(def: unknown): NormalizedToolDef {
  if (!isRecord(def)) bad("each tool must be an object");
  const name = def["name"];
  if (typeof name !== "string" || name.length === 0) {
    bad("tool.name is required and must be a non-empty string");
  }
  const inputSchema = def["input_schema"];
  if (inputSchema === undefined) bad(`tool ${name} requires input_schema`);
  const out: NormalizedToolDef = { name, inputSchema };
  if (typeof def["description"] === "string") out.description = def["description"];
  return out;
}

function normalizeToolChoice(choice: unknown): NormalizedToolChoice {
  if (!isRecord(choice)) bad("tool_choice must be an object");
  const t = choice["type"];
  if (t === "auto") return "auto";
  if (t === "any") return "any";
  if (t === "none") return "none";
  if (t === "tool") {
    const name = choice["name"];
    if (typeof name !== "string" || name.length === 0) {
      bad("tool_choice.name is required when tool_choice.type is 'tool'");
    }
    return { type: "tool", name };
  }
  bad(`unsupported tool_choice.type: ${String(t)}`);
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
      "thinking is not supported in Plan 04 (extended thinking lands in a follow-up)"
    );
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

  // tools
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) bad("tools must be an array");
    if (body.tools.length > 0) {
      out.tools = body.tools.map(normalizeToolDef);
    }
  }

  // tool_choice
  if (body.tool_choice !== undefined) {
    out.toolChoice = normalizeToolChoice(body.tool_choice);
  }

  // stop_sequences
  if (body.stop_sequences !== undefined) {
    if (!Array.isArray(body.stop_sequences)) bad("stop_sequences must be an array");
    if (body.stop_sequences.length > 0) {
      for (const s of body.stop_sequences) {
        if (typeof s !== "string") bad("stop_sequences entries must be strings");
      }
      out.stopSequences = body.stop_sequences as string[];
    }
  }

  return out;
}
