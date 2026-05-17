import { Buffer } from "node:buffer";
import type {
  NormalizedContentBlock,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedToolChoice,
  NormalizedToolDef
} from "../backends/types.js";
import { FileStore, FileNotFoundError } from "../fileStore.js";
import { ShimRequestError } from "./errors.js";
import type {
  GeminiContent,
  GeminiGenerateContentRequest,
  GeminiPart,
  GeminiSystemInstruction,
  GeminiTool
} from "./types.js";

function bad(message: string): never {
  throw new ShimRequestError(400, message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeSystemInstruction(
  sys: GeminiSystemInstruction | undefined
): string | undefined {
  if (sys === undefined) return undefined;
  if (typeof sys === "string") return sys;
  let parts: { text: string }[];
  if (Array.isArray(sys)) {
    parts = sys;
  } else if (isRecord(sys) && Array.isArray((sys as { parts?: unknown }).parts)) {
    parts = (sys as { parts: { text: string }[] }).parts;
  } else {
    bad("systemInstruction must be a string, a parts array, or { parts: [...] }");
  }
  const lines: string[] = [];
  for (const p of parts) {
    if (!isRecord(p) || typeof p["text"] !== "string") {
      bad("systemInstruction parts must each be { text: string }");
    }
    lines.push(p["text"] as string);
  }
  return lines.join("\n\n");
}

function pickMime(mimeType: string): "image" | "document" {
  return mimeType.startsWith("image/") ? "image" : "document";
}

function synthesizeCallId(name: string, index: number): string {
  // Stable base64url-encoded composite of (name, index) so test assertions
  // can predict the id when needed without exposing internal counter state.
  const seed = `${name}:${index}`;
  return `call_${Buffer.from(seed, "utf8").toString("base64url")}`;
}

async function translatePart(
  part: GeminiPart,
  fileStore: FileStore,
  ctx: { callIndex: number; nameToId: Map<string, string> }
): Promise<NormalizedContentBlock> {
  if (!isRecord(part)) bad("each part must be an object");

  if ("text" in part) {
    if (typeof part.text !== "string") bad("part.text must be a string");
    return { type: "text", text: part.text as string };
  }

  if ("inlineData" in part) {
    const inline = (part as { inlineData?: unknown }).inlineData;
    if (
      !isRecord(inline) ||
      typeof inline["mimeType"] !== "string" ||
      typeof inline["data"] !== "string"
    ) {
      bad("inlineData requires mimeType and data fields");
    }
    const mime = (inline as Record<string, unknown>)["mimeType"] as string;
    const data = (inline as Record<string, unknown>)["data"] as string;
    return { type: pickMime(mime), mediaType: mime, data };
  }

  if ("fileData" in part) {
    const fileData = (part as { fileData?: unknown }).fileData;
    if (
      !isRecord(fileData) ||
      typeof fileData["mimeType"] !== "string" ||
      typeof fileData["fileUri"] !== "string"
    ) {
      bad("fileData requires mimeType and fileUri fields");
    }
    const mime = (fileData as Record<string, unknown>)["mimeType"] as string;
    const uri = (fileData as Record<string, unknown>)["fileUri"] as string;
    try {
      const { bytes } = await fileStore.resolveById(uri);
      return {
        type: pickMime(mime),
        mediaType: mime,
        data: bytes.toString("base64")
      };
    } catch (e) {
      if (e instanceof FileNotFoundError) {
        bad(`fileData.fileUri not found: ${uri}`);
      }
      throw e;
    }
  }

  if ("functionCall" in part) {
    const fc = (part as { functionCall?: unknown }).functionCall;
    if (
      !isRecord(fc) ||
      typeof fc["name"] !== "string" ||
      !isRecord(fc["args"])
    ) {
      bad("functionCall requires name and args fields");
    }
    const name = (fc as Record<string, unknown>)["name"] as string;
    const id = synthesizeCallId(name, ctx.callIndex);
    ctx.callIndex++;
    ctx.nameToId.set(name, id);
    return {
      type: "tool_use",
      id,
      name,
      input: (fc as Record<string, unknown>)["args"] as Record<string, unknown>
    };
  }

  if ("functionResponse" in part) {
    const fr = (part as { functionResponse?: unknown }).functionResponse;
    if (
      !isRecord(fr) ||
      typeof fr["name"] !== "string" ||
      !isRecord(fr["response"])
    ) {
      bad("functionResponse requires name and response fields");
    }
    const name = (fr as Record<string, unknown>)["name"] as string;
    const id = ctx.nameToId.get(name);
    if (!id) {
      bad(
        `functionResponse for "${name}" has no matching prior functionCall in the conversation`
      );
    }
    return {
      type: "tool_result",
      toolUseId: id,
      content: JSON.stringify(
        (fr as Record<string, unknown>)["response"]
      )
    };
  }

  bad(
    "unknown part shape: must be text, inlineData, fileData, functionCall, or functionResponse"
  );
}

function mapRole(role: string | undefined): "user" | "assistant" {
  if (role === undefined) return "user";
  if (role === "user") return "user";
  if (role === "model") return "assistant";
  if (role === "function") return "user";
  bad(`unsupported role: ${role}`);
}

function translateTools(tools: GeminiTool[]): NormalizedToolDef[] {
  const out: NormalizedToolDef[] = [];
  for (const tool of tools) {
    if (!isRecord(tool)) bad("each tools entry must be an object");
    if ("googleSearchRetrieval" in tool && tool.googleSearchRetrieval !== undefined) {
      bad("tools[].googleSearchRetrieval (Gemini grounding) is not supported in Plan 07");
    }
    if ("codeExecution" in tool && tool.codeExecution !== undefined) {
      bad("tools[].codeExecution is not supported in Plan 07");
    }
    const decls = (tool as { functionDeclarations?: unknown }).functionDeclarations;
    if (decls === undefined) continue;
    if (!Array.isArray(decls)) bad("tools[].functionDeclarations must be an array");
    for (const decl of decls) {
      if (!isRecord(decl) || typeof decl["name"] !== "string") {
        bad("each functionDeclaration must have a string name");
      }
      const declRec = decl as Record<string, unknown>;
      const description =
        typeof declRec["description"] === "string" ? (declRec["description"] as string) : undefined;
      out.push({
        name: declRec["name"] as string,
        ...(description !== undefined ? { description } : {}),
        inputSchema: declRec["parameters"] ?? {}
      });
    }
  }
  return out;
}

function translateToolChoice(
  toolConfig: GeminiGenerateContentRequest["toolConfig"]
): NormalizedToolChoice | undefined {
  if (!toolConfig) return undefined;
  const mode = toolConfig.functionCallingConfig?.mode;
  if (mode === undefined || mode === "MODE_UNSPECIFIED" || mode === "AUTO") return "auto";
  if (mode === "ANY") return "any";
  if (mode === "NONE") return "none";
  bad(`toolConfig.functionCallingConfig.mode: unsupported value ${mode}`);
}

export async function geminiRequestToNormalized(
  body: GeminiGenerateContentRequest,
  model: string,
  fileStore: FileStore
): Promise<NormalizedRequest> {
  if (!isRecord(body)) bad("request body must be a JSON object");

  const contents = (body as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) bad("contents is required and must be an array");
  if (contents.length === 0) bad("contents must contain at least one entry");

  if ("cachedContent" in body && body.cachedContent !== undefined) {
    bad("cachedContent (Gemini context caching) is not supported in Plan 07");
  }
  const gen = body.generationConfig;
  if (gen) {
    if (typeof gen.candidateCount === "number" && gen.candidateCount > 1) {
      bad("generationConfig.candidateCount > 1 is not supported in Plan 07");
    }
    if (gen.responseSchema !== undefined) {
      bad("generationConfig.responseSchema (JSON mode) is not supported in Plan 07");
    }
    if (gen.responseMimeType === "application/json") {
      bad(
        "generationConfig.responseMimeType: application/json (JSON mode) is not supported in Plan 07"
      );
    }
  }

  const callCtx = { callIndex: 0, nameToId: new Map<string, string>() };
  const messages: NormalizedMessage[] = [];
  for (const content of contents as GeminiContent[]) {
    if (!isRecord(content)) bad("each contents entry must be an object");
    const parts = (content as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) bad("contents[].parts must be an array");
    const role = mapRole(typeof content.role === "string" ? content.role : undefined);
    const translatedParts: NormalizedContentBlock[] = [];
    for (const part of parts as GeminiPart[]) {
      translatedParts.push(await translatePart(part, fileStore, callCtx));
    }
    messages.push({ role, content: translatedParts });
  }

  const out: NormalizedRequest = { model, messages };

  const system = normalizeSystemInstruction(body.systemInstruction);
  if (system !== undefined) out.system = system;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools = translateTools(body.tools);
    if (tools.length > 0) out.tools = tools;
  }

  const toolChoice = translateToolChoice(body.toolConfig);
  if (toolChoice !== undefined) out.toolChoice = toolChoice;

  if (gen) {
    const sampling: { temperature?: number; topP?: number; topK?: number } = {};
    if (typeof gen.temperature === "number") sampling.temperature = gen.temperature;
    if (typeof gen.topP === "number") sampling.topP = gen.topP;
    if (typeof gen.topK === "number") sampling.topK = gen.topK;
    if (Object.keys(sampling).length > 0) out.samplingParams = sampling;
    if (typeof gen.maxOutputTokens === "number") out.maxTokens = gen.maxOutputTokens;
    if (Array.isArray(gen.stopSequences) && gen.stopSequences.length > 0) {
      out.stopSequences = gen.stopSequences;
    }
  }

  return out;
}
