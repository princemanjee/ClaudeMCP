import type {
  NormalizedMessage,
  NormalizedRequest,
  NormalizedSamplingParams
} from "../backends/types.js";
import { ShimRequestError } from "./errors.js";
import { buildFreshPrompts } from "./promptBuilder.js";
import type {
  OpenAIChatCompletionsRequest,
  OpenAIChatMessage,
  OpenAIContentPart,
  OpenAIToolDefinition
} from "./types.js";

const VALID_ROLES = new Set([
  "system",
  "user",
  "assistant",
  "tool",
  "function"
]);

/**
 * Structural validation gateway. Throws ShimRequestError on every shape
 * problem encountered. Returns a strongly-typed array on success.
 */
function validateMessages(messages: unknown): OpenAIChatMessage[] {
  if (!Array.isArray(messages)) {
    throw new ShimRequestError(400, "messages must be an array", {
      param: "messages"
    });
  }
  if (messages.length === 0) {
    throw new ShimRequestError(400, "messages must not be empty", {
      param: "messages"
    });
  }
  const out: OpenAIChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const raw = messages[i] as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") {
      throw new ShimRequestError(400, `messages[${i}] must be an object`, {
        param: `messages[${i}]`
      });
    }
    const role = raw["role"];
    if (typeof role !== "string" || !VALID_ROLES.has(role)) {
      throw new ShimRequestError(
        400,
        `messages[${i}].role must be one of system|user|assistant|tool|function`,
        { param: `messages[${i}].role` }
      );
    }
    const content = raw["content"] as
      | string
      | OpenAIContentPart[]
      | null
      | undefined;
    const toolCalls = raw["tool_calls"] as unknown;

    // Validate content shape per role.
    if (content === null || content === undefined) {
      if (role !== "assistant") {
        throw new ShimRequestError(
          400,
          `messages[${i}].content is required for role ${role}`,
          { param: `messages[${i}].content` }
        );
      }
      // assistant: null content is OK only when tool_calls present.
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        throw new ShimRequestError(
          400,
          `messages[${i}].content may be null only when tool_calls is present`,
          { param: `messages[${i}].content` }
        );
      }
    } else if (typeof content === "string") {
      // string content is universally accepted.
    } else if (Array.isArray(content)) {
      for (let j = 0; j < content.length; j++) {
        const part = content[j] as Record<string, unknown> | undefined;
        if (!part || typeof part !== "object") {
          throw new ShimRequestError(
            400,
            `messages[${i}].content[${j}] must be an object`,
            { param: `messages[${i}].content[${j}]` }
          );
        }
        const type = part["type"];
        if (type === "image_url") {
          throw new ShimRequestError(
            400,
            `messages[${i}].content[${j}] image_url parts are not supported (multimodal Non-goal)`,
            { param: `messages[${i}].content[${j}]` }
          );
        }
        if (type !== "text") {
          throw new ShimRequestError(
            400,
            `messages[${i}].content[${j}].type must be "text"`,
            { param: `messages[${i}].content[${j}].type` }
          );
        }
        if (typeof part["text"] !== "string") {
          throw new ShimRequestError(
            400,
            `messages[${i}].content[${j}].text must be a string`,
            { param: `messages[${i}].content[${j}].text` }
          );
        }
      }
    } else {
      throw new ShimRequestError(
        400,
        `messages[${i}].content must be string, array, or null`,
        { param: `messages[${i}].content` }
      );
    }

    // Pass through; the prompt builder consumes the strongly-typed shape.
    const msg: OpenAIChatMessage = {
      role: role as OpenAIChatMessage["role"],
      ...(content !== undefined ? { content: content as OpenAIChatMessage["content"] } : {}),
      ...(Array.isArray(toolCalls)
        ? { tool_calls: toolCalls as OpenAIChatMessage["tool_calls"] }
        : {}),
      ...(typeof raw["tool_call_id"] === "string"
        ? { tool_call_id: raw["tool_call_id"] }
        : {}),
      ...(typeof raw["name"] === "string" ? { name: raw["name"] } : {})
    };
    out.push(msg);
  }
  return out;
}

function validateTools(tools: unknown): OpenAIToolDefinition[] {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) {
    throw new ShimRequestError(400, "tools must be an array", { param: "tools" });
  }
  const out: OpenAIToolDefinition[] = [];
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i] as Record<string, unknown> | undefined;
    if (!t || typeof t !== "object") {
      throw new ShimRequestError(400, `tools[${i}] must be an object`, {
        param: `tools[${i}]`
      });
    }
    if (t["type"] !== "function") {
      throw new ShimRequestError(400, `tools[${i}].type must be "function"`, {
        param: `tools[${i}].type`
      });
    }
    const fn = t["function"] as Record<string, unknown> | undefined;
    if (!fn || typeof fn !== "object" || typeof fn["name"] !== "string") {
      throw new ShimRequestError(
        400,
        `tools[${i}].function.name must be a string`,
        { param: `tools[${i}].function.name` }
      );
    }
    out.push({
      type: "function",
      function: {
        name: fn["name"],
        ...(typeof fn["description"] === "string"
          ? { description: fn["description"] }
          : {}),
        ...(fn["parameters"] !== undefined
          ? { parameters: fn["parameters"] }
          : {})
      }
    });
  }
  return out;
}

function buildSamplingParams(
  body: OpenAIChatCompletionsRequest
): NormalizedSamplingParams | undefined {
  const params: NormalizedSamplingParams = {};
  let any = false;
  if (typeof body.temperature === "number") {
    params.temperature = body.temperature;
    any = true;
  }
  if (typeof body.top_p === "number") {
    params.topP = body.top_p;
    any = true;
  }
  return any ? params : undefined;
}

function normalizeStop(
  stop: string | string[] | undefined | null
): string[] | undefined {
  if (stop === undefined || stop === null) return undefined;
  if (typeof stop === "string") {
    if (stop.length === 0) return undefined;
    return [stop];
  }
  if (Array.isArray(stop)) {
    const filtered = stop.filter(
      (s): s is string => typeof s === "string" && s.length > 0
    );
    return filtered.length > 0 ? filtered : undefined;
  }
  return undefined;
}

/**
 * Pure OpenAI → NormalizedRequest translator. Folds every messages[] turn
 * into a single user message containing the prompt-engineered tool envelope.
 *
 * Per spec Non-goal: NormalizedRequest.tools and toolChoice are NEVER set —
 * tools are rendered into the system prompt as an AVAILABLE TOOLS block, and
 * the response parser extracts <tool_use> blocks from the backend's text
 * output. Every backend receives plain prompts through this shim.
 */
export function openaiRequestToNormalized(
  body: unknown
): NormalizedRequest {
  if (!body || typeof body !== "object") {
    throw new ShimRequestError(400, "request body must be an object");
  }
  const b = body as Record<string, unknown>;

  // n > 1 is rejected.
  if (typeof b["n"] === "number" && b["n"] > 1) {
    throw new ShimRequestError(400, "n > 1 is not supported", { param: "n" });
  }

  // response_format is rejected (JSON-mode out of scope).
  if (b["response_format"] !== undefined && b["response_format"] !== null) {
    throw new ShimRequestError(
      400,
      "response_format is not supported (JSON-mode out of scope)",
      { param: "response_format" }
    );
  }

  const messages = validateMessages(b["messages"]);
  const tools = validateTools(b["tools"]);

  // Build the prompt-engineered envelope.
  const { systemPrompt, userPrompt } = buildFreshPrompts(messages, tools);

  // Model: legacy back-compat sentinel.
  const model =
    typeof b["model"] === "string" && b["model"].length > 0
      ? b["model"]
      : "claude-code-cli";

  const out: NormalizedRequest = {
    model,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userPrompt }]
      }
    ]
  };

  // Sampling & misc params.
  const sampling = buildSamplingParams(b as unknown as OpenAIChatCompletionsRequest);
  if (sampling) out.samplingParams = sampling;

  // max_completion_tokens wins over max_tokens.
  const maxCompletion = b["max_completion_tokens"];
  const maxTokens = b["max_tokens"];
  if (typeof maxCompletion === "number") {
    out.maxTokens = maxCompletion;
  } else if (typeof maxTokens === "number") {
    out.maxTokens = maxTokens;
  }

  const stop = normalizeStop(
    b["stop"] as string | string[] | undefined | null
  );
  if (stop) out.stopSequences = stop;

  // Metadata: presence_penalty, frequency_penalty, user, seed are accepted
  // and forwarded for observability.
  const metadata: Record<string, unknown> = {};
  if (typeof b["presence_penalty"] === "number") {
    metadata["presence_penalty"] = b["presence_penalty"];
  }
  if (typeof b["frequency_penalty"] === "number") {
    metadata["frequency_penalty"] = b["frequency_penalty"];
  }
  if (typeof b["user"] === "string") metadata["user"] = b["user"];
  if (typeof b["seed"] === "number") metadata["seed"] = b["seed"];
  if (Object.keys(metadata).length > 0) out.metadata = metadata;

  return out;
}

// Re-export for callers building NormalizedMessage by hand.
export type { NormalizedMessage };
