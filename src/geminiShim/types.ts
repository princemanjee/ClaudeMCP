// Subset of the Google Gemini API shapes Plan 07 honors. The full Gemini API
// surface is much larger; what's listed here is what the request/response
// translators consume and produce. Future plans may broaden the type by adding
// optional fields — keep this file as the single source of truth for the wire
// shape the Plan-07 handlers honor.

// ---- Parts ----------------------------------------------------------------

export interface GeminiTextPart {
  text: string;
}

export interface GeminiInlineDataPart {
  inlineData: {
    mimeType: string;
    data: string; // base64
  };
}

export interface GeminiFileDataPart {
  fileData: {
    mimeType: string;
    /** `files/<24hex>` (Gemini canonical) — translator also accepts `file_<24hex>`. */
    fileUri: string;
  };
}

export interface GeminiFunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

export interface GeminiFunctionResponsePart {
  functionResponse: {
    name: string;
    response: Record<string, unknown>;
  };
}

export type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFileDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

// ---- Content (message) ----------------------------------------------------

export type GeminiRole = "user" | "model" | "function";

export interface GeminiContent {
  role?: GeminiRole;
  parts: GeminiPart[];
}

// ---- Tools ---------------------------------------------------------------

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: unknown; // JSON Schema
}

export interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
  /** Rejected with 400 — out of scope for Plan 07. */
  googleSearchRetrieval?: unknown;
  /** Rejected with 400 — out of scope for Plan 07. */
  codeExecution?: unknown;
}

export type GeminiFunctionCallingMode =
  | "AUTO"
  | "ANY"
  | "NONE"
  | "MODE_UNSPECIFIED";

export interface GeminiToolConfig {
  functionCallingConfig?: {
    mode?: GeminiFunctionCallingMode;
    /** When `mode: "ANY"`, an optional allowed-function-name list. */
    allowedFunctionNames?: string[];
  };
}

// ---- Generation config ----------------------------------------------------

export interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  candidateCount?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  responseMimeType?: string;
  responseSchema?: unknown;
}

// ---- System instruction ---------------------------------------------------

/** May be a string shorthand, a single content block, or a flat parts array. */
export type GeminiSystemInstruction =
  | string
  | { parts: GeminiTextPart[] }
  | GeminiTextPart[];

// ---- Request ---------------------------------------------------------------

export interface GeminiGenerateContentRequest {
  contents: GeminiContent[];
  systemInstruction?: GeminiSystemInstruction;
  tools?: GeminiTool[];
  toolConfig?: GeminiToolConfig;
  generationConfig?: GeminiGenerationConfig;
  /** Accepted and ignored — see scope boundary. */
  safetySettings?: unknown[];
  /** Rejected with 400 — context caching is a future-plan item. */
  cachedContent?: string;
}

// ---- Response --------------------------------------------------------------

export interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

export type GeminiFinishReason =
  | "STOP"
  | "MAX_TOKENS"
  | "SAFETY"
  | "RECITATION"
  | "OTHER"
  | "FINISH_REASON_UNSPECIFIED";

export interface GeminiCandidate {
  content: GeminiContent;
  finishReason?: GeminiFinishReason;
  /** Synthesized empty when the executing backend isn't Gemini. */
  safetyRatings: unknown[];
  index?: number;
}

export interface GeminiGenerateContentResponse {
  candidates: GeminiCandidate[];
  modelVersion?: string;
  usageMetadata?: GeminiUsageMetadata;
}

// ---- countTokens ----------------------------------------------------------

export interface GeminiCountTokensResponse {
  totalTokens: number;
}

// ---- Models ---------------------------------------------------------------

export interface GeminiModelEntry {
  /** Gemini wraps model IDs in `models/` prefix. */
  name: string;
  displayName: string;
  description: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods: string[];
}

export interface GeminiModelsListResponse {
  models: GeminiModelEntry[];
  /** Plan 07 ships unpaginated; field is always omitted/empty. */
  nextPageToken?: string;
}

// ---- Files ----------------------------------------------------------------

export interface GeminiFileResource {
  /** `files/<24hex>` */
  name: string;
  displayName: string;
  mimeType: string;
  /** Bytes as string (Google uses `sizeBytes` as a stringified int64). */
  sizeBytes: string;
  createTime: string; // RFC 3339
  updateTime: string;
  /** Always `ACTIVE` in Plan 07 (no async upload pipeline). */
  state: "ACTIVE";
  /** Download URL the SDK will follow. Points at `:download` route on this server. */
  uri: string;
}

export interface GeminiFilesListResponse {
  files: GeminiFileResource[];
  nextPageToken?: string;
}
