# Plan 07: Gemini Shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Google Gemini-shaped HTTP surface on top of the Plan-01 foundation, the Plan-02 / Plan-04 Claude backend, the Plan-05 file store, and the Plan-06 Gemini backend. Ten endpoints go live: `POST /v1beta/models/{model}:generateContent`, `POST /v1beta/models/{model}:streamGenerateContent`, `POST /v1beta/models/{model}:countTokens`, `GET /v1beta/models`, `GET /v1beta/models/{model}`, and the five `/v1beta/files/*` routes. After Plan 07, any client built on `@google/generative-ai` can reach the server with full Gemini wire-format parity, and the cross-shim × cross-backend matrix is closed: a Gemini-SDK client can target `claude-opus-4-7` and the response renders as Gemini SSE; an Anthropic-SDK client can already target `gemini-pro` (Plan 06 registered the backend) and the response renders as Anthropic SSE. The file store from Plan 05 is reused — uploads via the Anthropic shim are resolvable via the Gemini shim and vice versa.

**Architecture:** Mirrors Plan 03's factory pattern exactly — each shim handler is a pure factory that accepts its dependencies (`registry`, `config`, `fileStore`, `archive`) as constructor args. Two translators live in `src/geminiShim/`: `requestTranslator.ts` (pure function `geminiRequestToNormalized`) and `responseTranslator.ts` (one async generator yielding Gemini SSE chunks and one async function buffering them into the non-streaming JSON body). Five handler factories — `generateContent.ts` (covers both `:generateContent` and `:streamGenerateContent`), `countTokens.ts`, `files.ts`, `models.ts`, plus an `errors.ts` envelope helper. The `tools` / `tool_choice` round-trip is finished here: the Gemini backend's `Plan 06` scope-boundary throw for `tools` is removed and `capabilitiesFor().toolUse` flips to `true`. Multimodal via the Files API works across both shims because the file store IDs are interchangeable (`file_<24hex>` and `files/<24hex>` resolve the same content).

**Tech Stack:** Same as Plans 01-06 — Node.js 20+, TypeScript 5 (NodeNext ESM), Express 4, Vitest + Supertest, `multer` for multipart upload (already added in Plan 05). All `src/*` imports use explicit `.js` extensions.

**Spec:** `docs/superpowers/specs/2026-05-16-claude-api-fidelity-design.md` (Phase 7: Gemini shim — `/v1beta/models/*` and `/v1beta/files/*`).

**Builds on:**
- **Plan 01** (`docs/superpowers/plans/2026-05-16-plan-01-foundation.md`) — `Backend`, `NormalizedRequest`, `NormalizedEvent`, `NormalizedToolDef`, `NormalizedToolChoice`, `BackendRegistry`, `loadConfig`, `checkAuth` from `src/auth.ts` (already accepts `x-goog-api-key` header and `?key=` query — verify against current `src/auth.ts` during pre-flight), `identifyBackend` from `src/modelRouter.ts` (already handles `gemini-*` and `claude-*` prefixes — verify).
- **Plan 03** (`docs/superpowers/plans/2026-05-16-plan-03-anthropic-shim.md`) — handler-factory pattern, error-envelope discipline, `ShimRequestError` convention. Plan 07 mirrors the shape with Gemini wire format.
- **Plan 04** (`docs/superpowers/plans/2026-05-16-plan-04-tool-use-multimodal.md`) — tool_use surface (`NormalizedToolDef`, `NormalizedToolChoice`, `tool_use_start/delta/stop` `NormalizedEvent`s). Plan 07 does for Gemini's wire format what Plan 04 did for Anthropic's.
- **Plan 05** (`docs/superpowers/plans/2026-05-16-plan-05-files-cache-archive.md`) — `FileStore` from `src/fileStore.ts`. Plan 07's `/v1beta/files/*` is a thin alias to the same store; the existing `resolveForInline` is extended (see Task 1) to accept either ID prefix.
- **Plan 06** (`docs/superpowers/plans/2026-05-16-plan-06-gemini-backend.md`) — `GeminiBackend` from `src/backends/geminiBackend.ts`. Plan 07 finishes the function-calling integration that Plan 06 left at "capability false, scope-boundary throw".

**Reference plans (read for conventions + surface):**
- Plan 03 (Anthropic shim — closest mirror, Gemini wire format swapped in).
- Plan 04 (mirror of the tool_use surface — Plan 07 does the same thing for Gemini).
- Plan 05 (file store integration; the Gemini file-store handlers are a thin alias).
- Plan 06 (the backend Plan 07 sits on; finishes the function-calling deferral).

---

## Scope boundary for Plan 07

The spec's implementation phasing note draws a hard line. Bake the following into the handler logic — Plan 07 honors what's listed as honored and returns Gemini-shaped 400 errors for what's listed as rejected.

### Request features

| Feature | Plan 07 disposition | Notes |
|---|---|---|
| `contents[].parts[].text` | Honored | Mapped to normalized `text` block. |
| `contents[].parts[].inlineData` (base64 image) | Honored | Mapped to normalized `image` / `document` block by MIME prefix. |
| `contents[].parts[].fileData` (Files API reference) | Honored | Resolved via `fileStore.resolveById`. Accepts `files/<24hex>` (Gemini) or `file_<24hex>` (Anthropic). |
| `contents[].parts[].functionCall` (assistant turn) | Honored | Mapped to `tool_use` content block. |
| `contents[].parts[].functionResponse` (user/tool turn) | Honored | Mapped to `tool_result` content block. |
| `systemInstruction.parts[].text` | Honored | Mapped to `system` (multi-part joined with `\n\n`). |
| `tools[].functionDeclarations[]` | Honored | Mapped to `NormalizedToolDef[]`. |
| `tools[].googleSearchRetrieval` | 400 `INVALID_ARGUMENT` | Grounding out of scope; see open question. |
| `tools[].codeExecution` | 400 `INVALID_ARGUMENT` | Out of scope. |
| `toolConfig.functionCallingConfig.mode` | Honored | Mapped to `NormalizedToolChoice` per the table in Task 3. |
| `generationConfig.temperature` | Honored | Passed through `samplingParams.temperature`. |
| `generationConfig.topP` | Honored | Passed through `samplingParams.topP`. |
| `generationConfig.topK` | Honored | Passed through `samplingParams.topK`. |
| `generationConfig.maxOutputTokens` | Honored | Passed through `maxTokens`. |
| `generationConfig.stopSequences` | Honored | Passed through `stopSequences`. |
| `generationConfig.responseSchema` / `responseMimeType: "application/json"` | 400 `INVALID_ARGUMENT` | JSON-mode out of scope. |
| `generationConfig.candidateCount > 1` | 400 `INVALID_ARGUMENT` | Multi-candidate generation not honored; single candidate only. |
| `safetySettings` | Accepted and ignored | No safety enforcement layer in the proxy. |
| `cachedContent` | 400 `INVALID_ARGUMENT` | Gemini's context-caching feature is a future-plan item. |

### Server-internal deferrals

- Real safety-rating computation — Plan 07 synthesizes empty `safetyRatings: []` when the executing backend isn't Gemini, and forwards whatever Gemini reports when it is. (Plan 06's `GeminiBackend` doesn't yet surface safety ratings into `NormalizedEvent`s; that is a follow-up.)
- Grounding metadata (`groundingMetadata`, `groundingAttributions`).
- Batches (`/v1beta/models/{model}:batchGenerateContent`).
- Real-time streaming WebSocket transport.
- LM Studio / Ollama Gemini-shim routing — those backends land in Plans 08/09; Plan 07's `:generateContent` model-resolution only routes to `claude` and `gemini`.
- Archive writes from the Gemini shim — Plan 05 wired the Anthropic shim's archive write; Plan 07's parallel write lands when Plan 05's archive-write helper is generalized (tracked in this plan's open questions).

---

## File map

| File | Responsibility |
|---|---|
| `src/geminiShim/types.ts` | TypeScript types for the subset of the Gemini API request/response shapes Plan 07 honors. |
| `src/geminiShim/errors.ts` | Gemini-shaped error envelope helpers (`invalidArgumentError`, `unauthenticatedError`, `notFoundError`, `internalError`) and the shared `ShimRequestError` re-export. |
| `src/geminiShim/modelPath.ts` | Pure helpers: `stripModelsPrefix(id)`, `parseModelMethodPath(pathSegment)` for the unusual `:method` action suffix in Gemini's URL scheme. |
| `src/geminiShim/requestTranslator.ts` | Pure async function `geminiRequestToNormalized(body, model, fileStore): Promise<NormalizedRequest>`. Translates `contents[].parts[]`, `systemInstruction`, `tools`, `toolConfig`, `generationConfig`. Throws `ShimRequestError` on out-of-scope features. |
| `src/geminiShim/responseTranslator.ts` | Two functions: `normalizedEventsToGeminiSSE(events, meta)` async generator (yields Gemini SSE chunks — each is a `data: <JSON>\n\n` chunk where the JSON is a single `GenerateContentResponse`) and `normalizedEventsToGeminiFinalResponse(events, meta)` async function returning the assembled non-streaming body. Synthesizes default empty `safetyRatings` arrays. |
| `src/geminiShim/generateContent.ts` | Handler factory `createGenerateContentHandlers(deps)` returning `{ generate, streamGenerate }`. Both routes share the same factory because they only differ in stream-vs-buffered output. |
| `src/geminiShim/countTokens.ts` | Handler factory `createCountTokensHandler(deps)`. Delegates to `backend.countTokens(req)`. Returns `{ totalTokens: <n> }`. |
| `src/geminiShim/files.ts` | Handler factory `createFilesHandlers(deps)` returning `{ upload, list, getMetadata, download, delete }` for the five `/v1beta/files/*` routes. Backed by the Plan-05 `FileStore`. |
| `src/geminiShim/models.ts` | Handler factory `createGeminiModelsHandlers(deps)` returning `{ list, get }`. Both Gemini and Claude (and any other registered) models are surfaced — IDs are wrapped with `models/` prefix per Gemini's convention. |
| `src/fileStore.ts` | EXTEND — add `resolveById(id)` that accepts either `file_<24hex>` (Anthropic) or `files/<24hex>` (Gemini) and dispatches to the existing `get(id)` after normalization. Documented as the cross-shim alias. The Plan-05 `resolveForInline` continues to work unchanged. |
| `src/server.ts` | EXTEND — construct the Gemini handlers via the factories and mount the ten new routes. No other changes (`buildRegistry` already registers `GeminiBackend` from Plan 06). |
| `tests/unit/fileStore.test.ts` | EXTEND — add tests for the new `resolveById` cross-format normalization. |
| `tests/unit/geminiShim/errors.test.ts` | Envelope shape parity with Google's documented error format. |
| `tests/unit/geminiShim/modelPath.test.ts` | Path parsing for `models/{name}:{method}` and `models/` prefix stripping. |
| `tests/unit/geminiShim/requestTranslator.test.ts` | Every Gemini request shape: text parts, inlineData image/document parts, fileData references (both Gemini and Anthropic ID formats), functionCall / functionResponse parts, function declarations, toolConfig modes, generationConfig (sampling params + stopSequences + maxOutputTokens), systemInstruction, scope rejections. |
| `tests/unit/geminiShim/responseTranslator.test.ts` | SSE chunk format (Gemini's `data: <JSON>\n\n` shape), buffered shape, finishReason mapping (STOP→`end_turn`, MAX_TOKENS→`max_tokens`, etc.), `functionCall` part emission for `tool_use_*` events, empty `safetyRatings` synthesis. |
| `tests/unit/geminiShim/generateContent.test.ts` | Handler tests with stub backends (model resolution branches: `gemini-pro` → gemini, `claude-opus-4-7` → claude, `models/gemini-pro` → gemini after stripping). |
| `tests/unit/geminiShim/countTokens.test.ts` | Handler tests; verifies `{totalTokens: <n>}` shape and per-backend dispatch. |
| `tests/unit/geminiShim/files.test.ts` | All 5 file routes plus the cross-shim ID resolution test (`file_<hash>` uploaded via Anthropic shim is resolvable via `files/<hash>`). |
| `tests/unit/geminiShim/models.test.ts` | Cross-backend list (both `models/gemini-*` and `models/claude-*` appear); single-model get with prefix stripping. |
| `tests/unit/backends/geminiBackend.test.ts` | EXTEND — remove the Plan-06 scope-boundary throws for `tools` (and add a passthrough test); flip `capabilitiesFor().toolUse` expectation to `true`. |
| `tests/integration/generateContent.test.ts` | Full HTTP stack: `POST /v1beta/models/gemini-pro:generateContent` against mock-gemini works; `POST /v1beta/models/claude-opus-4-7:generateContent` against mock-claude works. Both produce Gemini-shaped responses. |
| `tests/integration/crossShimFiles.test.ts` | Upload file via Anthropic shim (`POST /v1/files`) → reference from Gemini shim in a `:generateContent` call (`fileData.fileUri: "files/<hash>"`) → backend invocation receives the bytes inline. And the reverse: upload via Gemini shim → reference from Anthropic shim. |
| `docs/plan-07-gemini-shim-readme.md` | Close-out documentation: routes, scope, what later plans need. |

---

## Pre-flight check

Before starting Task 1, confirm the prior-plan baseline is in place:

- [ ] `git log --oneline -20` shows Plan 06's merge commit at or near the top.
- [ ] `npm test` shows the full Plans 01-06 suite passing (no skips).
- [ ] `npx tsc --noEmit` clean.
- [ ] `src/backends/geminiBackend.ts` exists and `GeminiBackend.invoke()` works against mock-gemini (verify by running the Plan-06 integration test alone: `npx vitest run tests/integration/geminiBackend.test.ts`).
- [ ] `src/fileStore.ts` exists and exports `FileStore`, `FileNotFoundError`, `resolveForInline`. The existing surface stays intact; Task 1 adds `resolveById` alongside.
- [ ] `src/auth.ts` exports `checkAuth` that already accepts `x-goog-api-key` header and `?key=<key>` query. Grep to confirm: `grep -n "goog-api-key\|query.\\[.key.\\]" src/auth.ts`. If either is missing, stop and add to Plan 01 via an erratum commit before continuing.
- [ ] `src/modelRouter.ts` exports `identifyBackend` and routes `gemini-*` → gemini, `claude-*` → claude. Grep to confirm: `grep -n "gemini-\\|claude-" src/modelRouter.ts`.
- [ ] `src/backends/registry.ts` exports `BackendRegistry` with `enabledBackends()`, `resolveModel(id)`, `get(id)` — already in use by the Anthropic shim.
- [ ] `tests/fixtures/mock-gemini/index.mjs` exists and emits NDJSON `{candidates: [{content: {parts: [...]}}]}` chunks under `--output-format stream`.
- [ ] `tests/fixtures/mock-claude/index.mjs` exists and emits `stream-json` output (used to verify cross-backend dispatch through the Gemini shim).

If any check fails, stop and resolve before proceeding.

---

## Task 1: FileStore — add `resolveById` cross-format alias

**Files:**
- Modify: `src/fileStore.ts`
- Test: `tests/unit/fileStore.test.ts` (extend)

The Plan-05 `FileStore.get(id)` accepts only `file_<24hex>` (Anthropic format). The Gemini shim's request translator and the Gemini files API both speak `files/<24hex>`. Rather than duplicate the IO logic, add a single normalization helper that the Gemini shim uses everywhere it touches a file id, and re-route the existing `resolveForInline` through it so it transparently accepts either format.

Both formats hit the same on-disk content because Plan-05 keys the content file by the hex hash itself, not the prefixed ID — the prefix is only an opaque envelope at the API boundary.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/fileStore.test.ts`, in a new top-level `describe` block:

```ts
describe("FileStore — cross-format ID resolution", () => {
  let dir: string;
  let store: FileStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudemcp-fs-xfmt-"));
    store = new FileStore({
      dir,
      ttlMs: 24 * 60 * 60 * 1000,
      maxTotalBytes: 10 * 1024 * 1024,
      sweepIntervalMs: 0
    });
  });

  afterEach(() => {
    store.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolveById accepts the Anthropic format (file_<24hex>)", async () => {
    const meta = await store.upload(Buffer.from("hello"), "h.txt", "text/plain");
    const { metadata, bytes } = await store.resolveById(meta.id);
    expect(metadata.id).toBe(meta.id);
    expect(bytes.toString("utf8")).toBe("hello");
  });

  it("resolveById accepts the Gemini format (files/<24hex>) and resolves to the same content", async () => {
    const meta = await store.upload(Buffer.from("hello"), "h.txt", "text/plain");
    const hash = meta.id.slice("file_".length);
    const geminiId = `files/${hash}`;
    const { metadata, bytes } = await store.resolveById(geminiId);
    // The returned metadata.id is canonicalized to the Anthropic format —
    // that's the underlying storage format. Gemini-shim handlers re-emit it
    // in Gemini format using normalizeIdToGemini() (see Task 7).
    expect(metadata.id).toBe(meta.id);
    expect(bytes.toString("utf8")).toBe("hello");
  });

  it("resolveById throws FileNotFoundError on a well-formed ID with no backing content", async () => {
    await expect(store.resolveById("files/aaaaaaaaaaaaaaaaaaaaaaaa")).rejects.toBeInstanceOf(
      FileNotFoundError
    );
    await expect(store.resolveById("file_aaaaaaaaaaaaaaaaaaaaaaaa")).rejects.toBeInstanceOf(
      FileNotFoundError
    );
  });

  it("resolveById throws FileNotFoundError on malformed IDs", async () => {
    await expect(store.resolveById("not-an-id")).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(store.resolveById("")).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(store.resolveById("files/")).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(store.resolveById("file_")).rejects.toBeInstanceOf(FileNotFoundError);
    // 23 hex chars instead of 24
    await expect(store.resolveById("file_aaaaaaaaaaaaaaaaaaaaaaa")).rejects.toBeInstanceOf(
      FileNotFoundError
    );
  });

  it("resolveForInline still works with either format (delegates through resolveById)", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const meta = await store.upload(png, "a.png", "image/png");
    const hash = meta.id.slice("file_".length);

    const blockA = await store.resolveForInline(meta.id, "image");
    const blockB = await store.resolveForInline(`files/${hash}`, "image");
    expect(blockA).toEqual(blockB);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/fileStore.test.ts -t "cross-format"`
Expected: FAIL — `store.resolveById` is not a function.

- [ ] **Step 3: Extend `src/fileStore.ts`**

Add these exports near the existing helpers (above the `FileStore` class):

```ts
const GEMINI_FILE_ID_RE = /^files\/([0-9a-f]{24})$/;
const ANTHROPIC_FILE_ID_RE = /^file_([0-9a-f]{24})$/;

/**
 * Accept either the Anthropic shim's `file_<24hex>` ID format or the Gemini
 * shim's `files/<24hex>` format and return the canonical Anthropic form (which
 * is what the on-disk content + sidecar are keyed by). Returns `null` for any
 * malformed input — caller decides whether to throw `FileNotFoundError` or
 * surface a different error envelope.
 */
export function normalizeFileId(id: string): string | null {
  if (ANTHROPIC_FILE_ID_RE.test(id)) return id;
  const gemini = GEMINI_FILE_ID_RE.exec(id);
  if (gemini) return `file_${gemini[1]}`;
  return null;
}

/**
 * Re-emit a canonical Anthropic-format ID in the Gemini shim's format.
 * Used by `src/geminiShim/files.ts` and `src/geminiShim/requestTranslator.ts`
 * when returning metadata to a Gemini-SDK client.
 */
export function toGeminiFileId(canonicalId: string): string {
  const m = ANTHROPIC_FILE_ID_RE.exec(canonicalId);
  if (!m) {
    throw new Error(`toGeminiFileId: not a canonical file id: ${canonicalId}`);
  }
  return `files/${m[1]}`;
}
```

Add the `resolveById` method on the `FileStore` class (alongside `get`):

```ts
  /**
   * Resolve either ID format to the same backing content. Used by the
   * Gemini shim (which speaks `files/<24hex>`) and by the Anthropic shim
   * (which speaks `file_<24hex>`). Throws FileNotFoundError on malformed
   * input rather than letting the regex mismatch escape.
   */
  async resolveById(
    id: string
  ): Promise<{ bytes: Buffer; metadata: FileMetadata }> {
    const canonical = normalizeFileId(id);
    if (canonical === null) throw new FileNotFoundError(id);
    return this.get(canonical);
  }
```

Update `resolveForInline` to delegate through `resolveById` so the cross-shim alias works in the request translators too:

```ts
  async resolveForInline(
    id: string,
    expectedKind: "image" | "document"
  ): Promise<NormalizedContentBlock> {
    const { bytes, metadata } = await this.resolveById(id);
    return {
      type: expectedKind,
      mediaType: metadata.mime,
      data: bytes.toString("base64")
    };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/fileStore.test.ts`
Expected: PASS — all prior Plan-05 tests still green + 5 new cross-format tests green.

- [ ] **Step 5: Commit**

```bash
git add src/fileStore.ts tests/unit/fileStore.test.ts
git commit -m "feat(fileStore): add resolveById accepting both Anthropic and Gemini ID formats"
```

---

## Task 2: Gemini shim types + errors + model-path helpers

**Files:**
- Create: `src/geminiShim/types.ts`
- Create: `src/geminiShim/errors.ts`
- Create: `src/geminiShim/modelPath.ts`
- Test: `tests/unit/geminiShim/errors.test.ts`
- Test: `tests/unit/geminiShim/modelPath.test.ts`

Two foundational modules and one path-parsing helper. The error envelope and types are tiny; the model-path helper exists in its own module because it's the load-bearing parser for Gemini's unusual `:method` suffix in URL paths (`models/gemini-pro:generateContent`).

- [ ] **Step 1: Create `src/geminiShim/types.ts`**

```ts
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
```

- [ ] **Step 2: Write the failing test for error envelopes**

Create `tests/unit/geminiShim/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  internalError,
  invalidArgumentError,
  notFoundError,
  ShimRequestError,
  unauthenticatedError
} from "../../../src/geminiShim/errors.js";

describe("Gemini error envelopes", () => {
  it("invalidArgumentError matches Google's documented shape", () => {
    const env = invalidArgumentError("missing contents");
    expect(env).toEqual({
      error: {
        code: 400,
        message: "missing contents",
        status: "INVALID_ARGUMENT"
      }
    });
  });

  it("unauthenticatedError matches Google's documented shape", () => {
    const env = unauthenticatedError("invalid api key");
    expect(env).toEqual({
      error: {
        code: 401,
        message: "invalid api key",
        status: "UNAUTHENTICATED"
      }
    });
  });

  it("notFoundError matches Google's documented shape", () => {
    const env = notFoundError("model not found: foo");
    expect(env).toEqual({
      error: {
        code: 404,
        message: "model not found: foo",
        status: "NOT_FOUND"
      }
    });
  });

  it("internalError matches Google's documented shape", () => {
    const env = internalError("backend crashed");
    expect(env).toEqual({
      error: {
        code: 500,
        message: "backend crashed",
        status: "INTERNAL"
      }
    });
  });

  it("ShimRequestError carries status code and message", () => {
    const err = new ShimRequestError(400, "bad block type");
    expect(err.status).toBe(400);
    expect(err.message).toBe("bad block type");
    expect(err).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/unit/geminiShim/errors.test.ts`
Expected: FAIL — module `src/geminiShim/errors.js` not found.

- [ ] **Step 4: Create `src/geminiShim/errors.ts`**

```ts
export interface GeminiErrorEnvelope {
  error: {
    code: number;
    message: string;
    status:
      | "INVALID_ARGUMENT"
      | "UNAUTHENTICATED"
      | "PERMISSION_DENIED"
      | "NOT_FOUND"
      | "FAILED_PRECONDITION"
      | "INTERNAL"
      | "UNAVAILABLE";
  };
}

export function invalidArgumentError(message: string): GeminiErrorEnvelope {
  return { error: { code: 400, message, status: "INVALID_ARGUMENT" } };
}

export function unauthenticatedError(message: string): GeminiErrorEnvelope {
  return { error: { code: 401, message, status: "UNAUTHENTICATED" } };
}

export function notFoundError(message: string): GeminiErrorEnvelope {
  return { error: { code: 404, message, status: "NOT_FOUND" } };
}

export function internalError(message: string): GeminiErrorEnvelope {
  return { error: { code: 500, message, status: "INTERNAL" } };
}

/**
 * Re-export of the same error class the Anthropic shim uses. Centralized here
 * so the Gemini handlers don't need to cross-import from `src/anthropicShim/`;
 * keeps shim modules orthogonal per the spec's parallel-shim discipline.
 *
 * The class is duplicated rather than re-exported to keep the shim modules
 * fully independent — if the Anthropic shim later changes its `ShimRequestError`
 * signature, the Gemini shim must NOT silently inherit the change. Duplication
 * forces a deliberate edit in both places.
 */
export class ShimRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ShimRequestError";
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/unit/geminiShim/errors.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 6: Write the failing test for model-path helpers**

Create `tests/unit/geminiShim/modelPath.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  parseModelMethodPath,
  stripModelsPrefix
} from "../../../src/geminiShim/modelPath.js";

describe("stripModelsPrefix", () => {
  it("returns the bare id when no prefix present", () => {
    expect(stripModelsPrefix("gemini-pro")).toBe("gemini-pro");
    expect(stripModelsPrefix("claude-opus-4-7")).toBe("claude-opus-4-7");
  });

  it("strips a leading models/ prefix once", () => {
    expect(stripModelsPrefix("models/gemini-pro")).toBe("gemini-pro");
    expect(stripModelsPrefix("models/claude-opus-4-7")).toBe("claude-opus-4-7");
  });

  it("does not strip nested prefixes", () => {
    expect(stripModelsPrefix("models/models/foo")).toBe("models/foo");
  });

  it("returns empty string unchanged", () => {
    expect(stripModelsPrefix("")).toBe("");
  });

  it("does not strip prefixes that aren't exactly 'models/'", () => {
    expect(stripModelsPrefix("modelss/foo")).toBe("modelss/foo");
    expect(stripModelsPrefix("model/foo")).toBe("model/foo");
  });
});

describe("parseModelMethodPath", () => {
  it("parses model + method out of a `model:method` segment", () => {
    expect(parseModelMethodPath("gemini-pro:generateContent")).toEqual({
      model: "gemini-pro",
      method: "generateContent"
    });
  });

  it("strips a leading `models/` from the model component", () => {
    expect(parseModelMethodPath("models/gemini-pro:streamGenerateContent")).toEqual({
      model: "gemini-pro",
      method: "streamGenerateContent"
    });
  });

  it("preserves model ids containing dashes and dots", () => {
    expect(parseModelMethodPath("gemini-2.5-flash-lite:countTokens")).toEqual({
      model: "gemini-2.5-flash-lite",
      method: "countTokens"
    });
  });

  it("preserves cross-backend model ids (claude-opus-4-7)", () => {
    expect(parseModelMethodPath("claude-opus-4-7:generateContent")).toEqual({
      model: "claude-opus-4-7",
      method: "generateContent"
    });
  });

  it("returns null when no `:method` suffix is present", () => {
    expect(parseModelMethodPath("gemini-pro")).toBeNull();
  });

  it("returns null when the method component is empty", () => {
    expect(parseModelMethodPath("gemini-pro:")).toBeNull();
  });

  it("returns null when the model component is empty", () => {
    expect(parseModelMethodPath(":generateContent")).toBeNull();
  });

  it("splits on the LAST colon (model names contain no colons in practice, but be defensive)", () => {
    // Edge case — Gemini model names don't contain colons today; if Google
    // ever introduces colon-bearing names, this contract avoids silently
    // mis-parsing. The method suffix is always alphanumeric/camelCase.
    expect(parseModelMethodPath("weird:model:generateContent")).toEqual({
      model: "weird:model",
      method: "generateContent"
    });
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run tests/unit/geminiShim/modelPath.test.ts`
Expected: FAIL — module `src/geminiShim/modelPath.js` not found.

- [ ] **Step 8: Create `src/geminiShim/modelPath.ts`**

```ts
/**
 * Strip a leading `models/` prefix exactly once. The Gemini SDK sends model
 * names in both forms (`gemini-pro` and `models/gemini-pro`); this helper
 * normalizes to the bare id before handing off to the registry / router.
 */
export function stripModelsPrefix(id: string): string {
  if (id.startsWith("models/")) return id.slice("models/".length);
  return id;
}

/**
 * Parse a Gemini-style URL path segment of the form `[models/]<id>:<method>`,
 * returning the model id (without prefix) and the method name. Returns null on
 * any malformed input — handler treats null as a 404 because the route only
 * matches well-formed `:method` suffixes.
 *
 * The split is on the LAST `:` because Gemini model names are not guaranteed
 * to never contain colons in the future (defensive); method names are always
 * the alphanumeric camelCase trailing token (`generateContent`,
 * `streamGenerateContent`, `countTokens`).
 */
export function parseModelMethodPath(
  segment: string
): { model: string; method: string } | null {
  const lastColon = segment.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const rawModel = segment.slice(0, lastColon);
  const method = segment.slice(lastColon + 1);
  if (method.length === 0) return null;
  const model = stripModelsPrefix(rawModel);
  if (model.length === 0) return null;
  return { model, method };
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run tests/unit/geminiShim/modelPath.test.ts`
Expected: PASS — 12 tests green.

- [ ] **Step 10: Commit**

```bash
git add src/geminiShim/types.ts src/geminiShim/errors.ts src/geminiShim/modelPath.ts tests/unit/geminiShim/errors.test.ts tests/unit/geminiShim/modelPath.test.ts
git commit -m "feat(geminiShim): add types, error envelopes, and modelPath helpers"
```

---

## Task 3: Request translator — Gemini → NormalizedRequest

**Files:**
- Create: `src/geminiShim/requestTranslator.ts`
- Test: `tests/unit/geminiShim/requestTranslator.test.ts`

The async translator (it must await `fileStore.resolveForInline` for `fileData` parts). Function signature:

```ts
async function geminiRequestToNormalized(
  body: GeminiGenerateContentRequest,
  model: string,
  fileStore: FileStore
): Promise<NormalizedRequest>
```

Translation rules:

| Gemini shape | Normalized shape |
|---|---|
| `contents[].parts[].text` | `text` content block |
| `contents[].parts[].inlineData` with `mimeType` starting `image/` | `image` content block |
| `contents[].parts[].inlineData` with any other `mimeType` | `document` content block |
| `contents[].parts[].fileData` with `fileUri: "files/<hash>"` or `"file_<hash>"` | resolve via `fileStore.resolveById` — kind decided by mime |
| `contents[].parts[].functionCall` | `tool_use` content block (`id` synthesized from `name + index` since Gemini omits an `id` field on requests) |
| `contents[].parts[].functionResponse` | `tool_result` content block (`toolUseId` synthesized from `name` matching the prior `functionCall`'s synthesized id) |
| `contents[].role: "user"` | `role: "user"` |
| `contents[].role: "model"` | `role: "assistant"` |
| `contents[].role: "function"` | `role: "user"` (tool result is a user-turn artifact in the normalized shape) |
| `systemInstruction` (string / parts / wrapped) | `system` (text-parts joined `\n\n`) |
| `tools[].functionDeclarations[]` | `NormalizedToolDef[]` (`inputSchema` <- `parameters`) |
| `toolConfig.functionCallingConfig.mode: "AUTO"` | `toolChoice: "auto"` |
| `toolConfig.functionCallingConfig.mode: "ANY"` | `toolChoice: "any"` |
| `toolConfig.functionCallingConfig.mode: "NONE"` | `toolChoice: "none"` |
| `toolConfig.functionCallingConfig.mode: "MODE_UNSPECIFIED"` or absent | `toolChoice: "auto"` (mode unspecified) or `undefined` (absent toolConfig) |
| `generationConfig.temperature` | `samplingParams.temperature` |
| `generationConfig.topP` | `samplingParams.topP` |
| `generationConfig.topK` | `samplingParams.topK` |
| `generationConfig.maxOutputTokens` | `maxTokens` |
| `generationConfig.stopSequences` | `stopSequences` |

**Synthesized `tool_use` IDs:** Gemini's request shape does not carry an `id` on `functionCall` parts (unlike Anthropic). The translator generates a stable id of the form `call_<base64url-of-name-and-index>` so the normalized stream has the same shape as Anthropic's. The corresponding `functionResponse` part matches by `name` (Gemini's contract is that `functionResponse.name` references the prior `functionCall.name`); the translator keeps a small in-translation map from name to last-assigned id.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/geminiShim/requestTranslator.test.ts` (large — see appendix at end of plan for full content, summarized here). Cover:
  - Text-only requests (4 cases): minimal, role mapping `model`→`assistant`, omitted role defaults to `user`, multi-part content preserved.
  - `systemInstruction` shapes (4 cases): string, `{parts:[...]}`, multi-parts joined `\n\n`, flat parts array.
  - `inlineData` parts (2 cases): image MIME → image block, application MIME → document block.
  - `fileData` references (4 cases): Gemini-format URI, Anthropic-format URI, MIME-based kind selection, missing-id 400.
  - Function calling (8 cases): function declarations flatten across tools, `AUTO`/`ANY`/`NONE` mode mapping, `MODE_UNSPECIFIED` and absent toolConfig handling, `functionCall` → `tool_use` with synthesized id, `functionResponse` → `tool_result` with matching `toolUseId`, role `function` → user.
  - `generationConfig` passthroughs (4 cases): sampling params trio, `maxOutputTokens`, `stopSequences`, `safetySettings` silently accepted.
  - Scope rejections (10 cases): empty/missing `contents`, `googleSearchRetrieval`, `codeExecution`, `candidateCount > 1` rejected vs `=1` accepted, `responseMimeType: application/json`, `responseSchema`, `cachedContent`, unknown part shape.

Refer to the test file template in the appendix; total ~32 tests.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/geminiShim/requestTranslator.test.ts`
Expected: FAIL — module `src/geminiShim/requestTranslator.js` not found.

- [ ] **Step 3: Create `src/geminiShim/requestTranslator.ts`**

```ts
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
    return { type: "text", text: part.text };
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
    const mime = inline["mimeType"] as string;
    const data = inline["data"] as string;
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
    const mime = fileData["mimeType"] as string;
    const uri = fileData["fileUri"] as string;
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
    const name = fc["name"] as string;
    const id = synthesizeCallId(name, ctx.callIndex);
    ctx.callIndex++;
    ctx.nameToId.set(name, id);
    return {
      type: "tool_use",
      id,
      name,
      input: fc["args"] as Record<string, unknown>
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
    const name = fr["name"] as string;
    const id = ctx.nameToId.get(name);
    if (!id) {
      bad(
        `functionResponse for "${name}" has no matching prior functionCall in the conversation`
      );
    }
    return {
      type: "tool_result",
      toolUseId: id,
      content: JSON.stringify(fr["response"])
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
      const description =
        typeof decl["description"] === "string" ? decl["description"] : undefined;
      out.push({
        name: decl["name"] as string,
        ...(description !== undefined ? { description } : {}),
        inputSchema: decl["parameters"] ?? {}
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/geminiShim/requestTranslator.test.ts`
Expected: PASS — all ~32 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/geminiShim/requestTranslator.ts tests/unit/geminiShim/requestTranslator.test.ts
git commit -m "feat(geminiShim): add requestTranslator with file resolution + function-calling round-trip"
```

---

## Task 4: Response translator — NormalizedEvent → Gemini SSE + buffered

**Files:**
- Create: `src/geminiShim/responseTranslator.ts`
- Test: `tests/unit/geminiShim/responseTranslator.test.ts`

Two functions:
- `normalizedEventsToGeminiSSE(events, meta)` — async generator yielding raw SSE event strings. Each yield is a `data: <JSON>\n\n` chunk. The JSON is a complete `GenerateContentResponse` (Gemini's SSE format is **incremental** — each chunk is a full response object with the deltas appended to the single candidate's `content.parts[]`). This differs from Anthropic's event-typed SSE.
- `normalizedEventsToGeminiFinalResponse(events, meta)` — async function that buffers all events into a single `GenerateContentResponse` body for the `:generateContent` route.

**Important Gemini SSE format note:** Per the Gemini SDK reference, the streaming format is line-delimited JSON arrays of `GenerateContentResponse` objects in some transports, and `data: <JSON>\n\n` SSE in others. The `@google/generative-ai` SDK accepts both. Plan 07 ships SSE (`data: ...\n\n`) because that's what HTTP-streaming Express handlers naturally produce — the JS SDK's stream parser handles it transparently.

**Stop-reason mapping** (`NormalizedEvent.message_stop.stopReason` → `GenerateContentResponse.candidates[0].finishReason`):

| Normalized | Gemini |
|---|---|
| `end_turn` | `STOP` |
| `stop_sequence` | `STOP` (Gemini doesn't distinguish; the SDK relies on the stopSequence text being present in the output) |
| `max_tokens` | `MAX_TOKENS` |
| `tool_use` | `STOP` (Gemini treats tool calls as a normal stop with `functionCall` parts present) |
| `error` | `OTHER` |

**`tool_use_*` event translation** (mirror of Plan 04's Anthropic translation):
- `tool_use_start { index, id, name }` — opens a new `functionCall` slot at the index.
- `tool_use_delta { index, partialJson }` — accumulates the partial JSON. The translator buffers all deltas and emits a single `functionCall` part with parsed `args` at `tool_use_stop` time (Gemini's wire format does not have an `input_json_delta` analog — clients see the complete `functionCall.args` object).
- `tool_use_stop { index }` — finalizes the part; parses accumulated JSON.

**Safety ratings synthesis:** Plan 07 emits `safetyRatings: []` on every candidate. When the executing backend is Gemini and a future plan surfaces real ratings into `NormalizedEvent`s, this synthesis can flip to "use the backend's value when present, default to `[]` otherwise" — but for Plan 07 it's always empty.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/geminiShim/responseTranslator.test.ts`. Cover:
  - **SSE single-text-block (4 cases):** event sequence is correct, each chunk is a `data: <JSON>\n\n` with a parseable `GenerateContentResponse`, accumulated text reproduces the original, model field is `meta.model`.
  - **SSE chunk structure (3 cases):** each non-final chunk omits `finishReason` and `usageMetadata`; final chunk includes both; `safetyRatings` array is present on every candidate (empty in Plan 07).
  - **finishReason mapping (5 cases):** `end_turn`→`STOP`, `stop_sequence`→`STOP`, `max_tokens`→`MAX_TOKENS`, `tool_use`→`STOP`, `error`→`OTHER`.
  - **tool_use_* SSE emission (3 cases):** a complete tool_use sequence (`start`→`delta`→`stop`) produces a `functionCall` part on the final chunk's candidate; multiple tool_use blocks at different indices produce multiple `functionCall` parts; partial JSON from multiple deltas is concatenated and parsed at stop time.
  - **Synthesized message_start / message_stop (2 cases):** translator works when source omits `message_start`; translator emits a final chunk when source omits `message_stop` (best-effort, `finishReason: "OTHER"`).
  - **Buffered (non-streaming) aggregation (5 cases):** single text block, multi-text concatenation, tool_use becomes `functionCall` part, usage metadata populated, empty event stream returns minimal valid body with empty candidate.

The full test file lives in the appendix at the end of the plan.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/geminiShim/responseTranslator.test.ts`
Expected: FAIL — module `src/geminiShim/responseTranslator.js` not found.

- [ ] **Step 3: Create `src/geminiShim/responseTranslator.ts`**

```ts
import type { NormalizedEvent } from "../backends/types.js";
import type {
  GeminiCandidate,
  GeminiFinishReason,
  GeminiGenerateContentResponse,
  GeminiPart
} from "./types.js";

export interface GeminiResponseMeta {
  /** Model id as the client requested it (used for `modelVersion` field). */
  model: string;
}

function mapFinishReason(
  reason: Extract<NormalizedEvent, { kind: "message_stop" }>["stopReason"]
): GeminiFinishReason {
  switch (reason) {
    case "end_turn":
      return "STOP";
    case "stop_sequence":
      return "STOP"; // Gemini doesn't distinguish — SDK infers from output text
    case "max_tokens":
      return "MAX_TOKENS";
    case "tool_use":
      return "STOP"; // Gemini treats tool calls as a normal stop with functionCall parts
    case "error":
      return "OTHER";
  }
}

function sseChunk(response: GeminiGenerateContentResponse): string {
  return `data: ${JSON.stringify(response)}\n\n`;
}

interface PendingTool {
  id: string;
  name: string;
  partials: string[];
}

interface StreamingState {
  textBuffers: Map<number, string>;
  toolBuffers: Map<number, PendingTool>;
  /** Index order as content blocks first appear, so the final candidate's parts
   *  array preserves chronological ordering for the SDK. */
  appearance: number[];
}

function buildPartsFromState(state: StreamingState): GeminiPart[] {
  const out: GeminiPart[] = [];
  for (const idx of state.appearance) {
    const text = state.textBuffers.get(idx);
    if (text !== undefined) {
      out.push({ text });
      continue;
    }
    const tool = state.toolBuffers.get(idx);
    if (tool) {
      const joined = tool.partials.join("");
      let args: Record<string, unknown>;
      try {
        args = joined.length > 0 ? (JSON.parse(joined) as Record<string, unknown>) : {};
      } catch {
        // Malformed JSON from upstream — surface as empty args rather than
        // failing the whole response. A future plan could 500 the connection.
        args = {};
      }
      out.push({ functionCall: { name: tool.name, args } });
    }
  }
  return out;
}

/**
 * Emit Gemini-shaped SSE chunks. Each chunk is a `data: <JSON>\n\n` line where
 * the JSON is a complete GenerateContentResponse. Non-final chunks carry the
 * incremental text accumulated so far. The final chunk additionally carries
 * finishReason and usageMetadata.
 */
export async function* normalizedEventsToGeminiSSE(
  events: AsyncIterable<NormalizedEvent>,
  meta: GeminiResponseMeta
): AsyncIterable<string> {
  const state: StreamingState = {
    textBuffers: new Map(),
    toolBuffers: new Map(),
    appearance: []
  };
  let messageStopSent = false;
  let modelVersion = meta.model;
  let outputTokens = 0;
  let inputTokens = 0;

  function trackAppearance(idx: number): void {
    if (!state.appearance.includes(idx)) state.appearance.push(idx);
  }

  function emitIncremental(): string {
    return sseChunk({
      candidates: [
        {
          content: { role: "model", parts: buildPartsFromState(state) },
          safetyRatings: [],
          index: 0
        } satisfies GeminiCandidate
      ],
      modelVersion
    });
  }

  for await (const ev of events) {
    if (ev.kind === "message_start") {
      if (ev.model) modelVersion = ev.model;
      continue;
    }

    if (ev.kind === "text_delta") {
      const prev = state.textBuffers.get(ev.index) ?? "";
      state.textBuffers.set(ev.index, prev + ev.text);
      trackAppearance(ev.index);
      yield emitIncremental();
      continue;
    }

    if (ev.kind === "tool_use_start") {
      state.toolBuffers.set(ev.index, { id: ev.id, name: ev.name, partials: [] });
      trackAppearance(ev.index);
      // No chunk emitted yet — wait for first delta so the chunk carries
      // meaningful content. (Empty functionCall.args is still valid; Plan 07
      // emits it on tool_use_stop.)
      continue;
    }

    if (ev.kind === "tool_use_delta") {
      const tool = state.toolBuffers.get(ev.index);
      if (!tool) continue;
      tool.partials.push(ev.partialJson);
      // Don't emit on every delta — Gemini SSE clients expect full functionCall
      // objects, not delta-style emission. We emit once at tool_use_stop.
      continue;
    }

    if (ev.kind === "tool_use_stop") {
      yield emitIncremental();
      continue;
    }

    if (ev.kind === "thinking_delta") {
      // Gemini wire format has no thinking part. Drop silently — Plan 07
      // doesn't surface thinking through the Gemini shim; future plans can
      // map this to a custom field if needed.
      continue;
    }

    if (ev.kind === "message_stop") {
      const finishReason = mapFinishReason(ev.stopReason);
      if (ev.usage) {
        inputTokens = ev.usage.inputTokens;
        outputTokens = ev.usage.outputTokens;
      }
      yield sseChunk({
        candidates: [
          {
            content: { role: "model", parts: buildPartsFromState(state) },
            finishReason,
            safetyRatings: [],
            index: 0
          } satisfies GeminiCandidate
        ],
        modelVersion,
        usageMetadata: {
          promptTokenCount: inputTokens,
          candidatesTokenCount: outputTokens,
          totalTokenCount: inputTokens + outputTokens
        }
      });
      messageStopSent = true;
      return;
    }
  }

  if (!messageStopSent) {
    yield sseChunk({
      candidates: [
        {
          content: { role: "model", parts: buildPartsFromState(state) },
          finishReason: "OTHER",
          safetyRatings: [],
          index: 0
        } satisfies GeminiCandidate
      ],
      modelVersion,
      usageMetadata: {
        promptTokenCount: inputTokens,
        candidatesTokenCount: outputTokens,
        totalTokenCount: inputTokens + outputTokens
      }
    });
  }
}

/**
 * Buffer the entire event stream into a single GenerateContentResponse for the
 * non-streaming `:generateContent` route.
 */
export async function normalizedEventsToGeminiFinalResponse(
  events: AsyncIterable<NormalizedEvent>,
  meta: GeminiResponseMeta
): Promise<GeminiGenerateContentResponse> {
  const state: StreamingState = {
    textBuffers: new Map(),
    toolBuffers: new Map(),
    appearance: []
  };
  let modelVersion = meta.model;
  let finishReason: GeminiFinishReason = "OTHER";
  let inputTokens = 0;
  let outputTokens = 0;

  function track(idx: number): void {
    if (!state.appearance.includes(idx)) state.appearance.push(idx);
  }

  for await (const ev of events) {
    if (ev.kind === "message_start") {
      if (ev.model) modelVersion = ev.model;
    } else if (ev.kind === "text_delta") {
      const prev = state.textBuffers.get(ev.index) ?? "";
      state.textBuffers.set(ev.index, prev + ev.text);
      track(ev.index);
    } else if (ev.kind === "tool_use_start") {
      state.toolBuffers.set(ev.index, { id: ev.id, name: ev.name, partials: [] });
      track(ev.index);
    } else if (ev.kind === "tool_use_delta") {
      const tool = state.toolBuffers.get(ev.index);
      if (tool) tool.partials.push(ev.partialJson);
    } else if (ev.kind === "message_stop") {
      finishReason = mapFinishReason(ev.stopReason);
      if (ev.usage) {
        inputTokens = ev.usage.inputTokens;
        outputTokens = ev.usage.outputTokens;
      }
    }
    // tool_use_stop is a no-op in buffered mode (parts assembled at the end).
    // thinking_delta dropped per the SSE generator's same rationale.
  }

  return {
    candidates: [
      {
        content: { role: "model", parts: buildPartsFromState(state) },
        finishReason,
        safetyRatings: [],
        index: 0
      }
    ],
    modelVersion,
    usageMetadata: {
      promptTokenCount: inputTokens,
      candidatesTokenCount: outputTokens,
      totalTokenCount: inputTokens + outputTokens
    }
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/geminiShim/responseTranslator.test.ts`
Expected: PASS — all ~22 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/geminiShim/responseTranslator.ts tests/unit/geminiShim/responseTranslator.test.ts
git commit -m "feat(geminiShim): add responseTranslator for Gemini SSE + buffered shapes"
```

---

## Task 5: GeminiBackend — open the tool_use gate

**Files:**
- Modify: `src/backends/geminiBackend.ts`
- Modify: `tests/unit/backends/geminiBackend.test.ts`

Plan 06 left two Plan-07-deferred items:
1. `capabilitiesFor().toolUse` is `false`.
2. `assertPlan06Scope()` throws on `tools` (and on `stopSequences` — but stopSequences live with the shim, so Plan 07 also removes that gate; the runner already passes the flag to the CLI per the Plan 06 `--stop` flag).

Plan 07 removes both guards, flips `toolUse: true`, and adds passthrough tests confirming that requests with a `tools` array no longer throw. The actual translation of tool-call events from Gemini CLI stream chunks into `tool_use_*` `NormalizedEvent`s is a small extension to the existing `invoke()` event-loop.

**Mock-gemini extension:** add a `MOCK_FUNCTION_CALL(name|argsJson)` prompt trigger that emits a Gemini stream chunk containing a `functionCall` part instead of `text`. The fixture currently only emits `text` parts.

- [ ] **Step 1: Extend `tests/fixtures/mock-gemini/index.mjs`**

Add a new trigger between `MOCK_INVALID_JSON` and the "Normal output" block:

```js
// MOCK_FUNCTION_CALL(name|argsJson) — emit a stream chunk that carries a
// functionCall part instead of text. Used to verify the Gemini backend's
// tool_use translation path.
const fnCallMatch = prompt.match(/MOCK_FUNCTION_CALL\(([^|]+)\|([^)]+)\)/);
if (fnCallMatch && outputFormat === "stream") {
  const fnName = fnCallMatch[1];
  const argsJson = fnCallMatch[2];
  let args;
  try {
    args = JSON.parse(argsJson);
  } catch {
    args = {};
  }
  const chunk = {
    candidates: [
      {
        content: {
          parts: [{ functionCall: { name: fnName, args } }],
          role: "model"
        },
        index: 0,
        finishReason: "STOP"
      }
    ],
    modelVersion: model,
    usageMetadata: {
      promptTokenCount: 1,
      candidatesTokenCount: 1,
      totalTokenCount: 2
    },
    sessionId
  };
  stdout.write(JSON.stringify(chunk) + "\n");
  exit(0);
}
```

- [ ] **Step 2: Modify the failing tests on `GeminiBackend`**

Open `tests/unit/backends/geminiBackend.test.ts`:

1. Update the `capabilitiesFor` test that asserted `caps.toolUse === false` — change to `expect(caps.toolUse).toBe(true)`.
2. Delete the `"invoke throws on tools array (Plan 06 scope is no-tools)"` test.
3. Delete the `"invoke throws on stopSequences (Plan 06 defers to Plan 07)"` test.
4. Append the following new tests:

```ts
  it("invoke accepts tools array without throwing (Plan 07)", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-pro",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "calc", inputSchema: { type: "object" } }]
    })) {
      events.push(ev);
    }
    expect(events[0]?.kind).toBe("message_start");
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke accepts stopSequences array without throwing (Plan 07)", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-pro",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      stopSequences: ["END"]
    })) {
      events.push(ev);
    }
    expect(events[events.length - 1]?.kind).toBe("message_stop");
  });

  it("invoke emits tool_use_start + tool_use_delta + tool_use_stop for Gemini functionCall parts", async () => {
    const backend = new GeminiBackend({
      command: ["node", join(__dirname, "..", "..", "fixtures", "mock-gemini", "index.mjs")],
      timeoutMs: 5000
    });

    const events: NormalizedEvent[] = [];
    for await (const ev of backend.invoke({
      model: "gemini-pro",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: 'MOCK_FUNCTION_CALL(calc|{"x":1,"y":2})' }]
        }
      ],
      tools: [{ name: "calc", inputSchema: { type: "object" } }]
    })) {
      events.push(ev);
    }

    const starts = events.filter((e) => e.kind === "tool_use_start");
    const deltas = events.filter((e) => e.kind === "tool_use_delta");
    const stops = events.filter((e) => e.kind === "tool_use_stop");
    expect(starts.length).toBe(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(stops.length).toBe(1);

    if (starts[0]?.kind === "tool_use_start") {
      expect(starts[0].name).toBe("calc");
    }
    if (deltas[0]?.kind === "tool_use_delta") {
      // Concatenated partials should parse to the original args.
      const joined = deltas.map((d) => (d.kind === "tool_use_delta" ? d.partialJson : "")).join("");
      expect(JSON.parse(joined)).toEqual({ x: 1, y: 2 });
    }
  });
```

- [ ] **Step 3: Run the tests to verify the failing ones still fail**

Run: `npx vitest run tests/unit/backends/geminiBackend.test.ts`
Expected: capabilities test fails (still `false`); the two passthrough tests fail with the Plan-06 scope-throw error; the functionCall translation test fails because the event handler doesn't see `functionCall` parts.

- [ ] **Step 4: Modify `src/backends/geminiBackend.ts`**

1. Flip the capabilities flag:

```ts
  capabilitiesFor(_model: string): BackendCapabilities {
    return {
      toolUse: true,            // Plan 07: flipped on (was false in Plan 06)
      multimodal: true,
      thinking: false,
      cacheControl: "none",
      samplingParams: { temperature: true, topP: true, topK: true },
      stopSequences: "native",
      embeddings: false
    };
  }
```

2. Remove the two scope guards from `assertPlan06Scope`. Rename to `assertSupportedScope` and keep only:
   - `req.thinking` → still throws (Gemini 2.5 thinking-mode is future-plan).
   - image/document content blocks — actually now allowed; remove the throw (the runner builds them into the prompt via `foldMessagesToPrompt` extension — see step 5 below).
   - tool_use/tool_result content blocks — also now allowed (folded into prompt history).

The updated method:

```ts
  private assertSupportedScope(req: NormalizedRequest): void {
    if (req.thinking) {
      throw new Error(
        "GeminiBackend: thinking-mode (Gemini 2.5) lands in a future plan"
      );
    }
    // image/document/tool_use/tool_result are now in scope per Plan 07.
    // The folded prompt builder will serialize them (see foldMessagesToPrompt).
  }
```

3. Extend `foldMessagesToPrompt` to serialize the new block types into the prompt envelope. (Mirror of Plan 04's claudeBackend.foldMessagesToPrompt extension.)

```ts
  private foldMessagesToPrompt(req: NormalizedRequest): string {
    const lines: string[] = [];
    for (const msg of req.messages) {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text") parts.push(block.text);
        else if (block.type === "image")
          parts.push(`[image:${block.mediaType};base64,${block.data}]`);
        else if (block.type === "document")
          parts.push(`[document:${block.mediaType};base64,${block.data}]`);
        else if (block.type === "tool_use")
          parts.push(`[tool_use:${block.id}:${block.name}:${JSON.stringify(block.input)}]`);
        else if (block.type === "tool_result")
          parts.push(`[tool_result:${block.toolUseId}:${block.content}]`);
        else if (block.type === "thinking") parts.push(block.text);
      }
      const text = parts.filter((s) => s.length > 0).join("\n");
      if (text.length === 0) continue;
      lines.push(`${msg.role}: ${text}`);
    }
    if (req.tools && req.tools.length > 0) {
      lines.push(
        `tools_available: ${JSON.stringify(req.tools.map((t) => ({ name: t.name, description: t.description })))}`
      );
    }
    return lines.join("\n\n");
  }
```

4. Forward `stopSequences` (and `tools` if the runner accepts them later — Plan 07's runner extension is out of scope here; for now just forward stop sequences):

```ts
    const streamOpts: GeminiStreamOptions = {
      prompt: this.foldMessagesToPrompt(req),
      ...(req.system !== undefined ? { systemPrompt: req.system } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.samplingParams?.temperature !== undefined
        ? { temperature: req.samplingParams.temperature } : {}),
      ...(req.samplingParams?.topP !== undefined ? { topP: req.samplingParams.topP } : {}),
      ...(req.samplingParams?.topK !== undefined ? { topK: req.samplingParams.topK } : {}),
      ...(req.stopSequences && req.stopSequences.length > 0
        ? { stopSequences: req.stopSequences } : {}),
      timeoutMs: this.config.timeoutMs,
      geminiCommand: this.config.command
    };
```

5. Extend the per-chunk loop to recognize `functionCall` parts and emit the `tool_use_*` event triple. Add a small `toolIndex` counter alongside `textIndex` so the indices don't collide:

```ts
      // Emit text deltas for each text part, and tool_use_start/delta/stop for
      // each functionCall part. Parts of unknown shapes are ignored silently.
      const parts = candidate?.content?.parts ?? [];
      for (const part of parts as Array<{
        text?: string;
        functionCall?: { name?: string; args?: unknown };
      }>) {
        if (typeof part.text === "string" && part.text.length > 0) {
          yield { kind: "text_delta", index: textIndex, text: part.text };
          textOpen = true;
        }
        if (
          part.functionCall &&
          typeof part.functionCall.name === "string"
        ) {
          const fc = part.functionCall;
          // Synthesize an id; the Gemini CLI does not surface call ids.
          const callId = `call_${Buffer.from(`${fc.name}:${toolIndex}`, "utf8").toString(
            "base64url"
          )}`;
          yield { kind: "tool_use_start", index: toolIndex, id: callId, name: fc.name };
          yield {
            kind: "tool_use_delta",
            index: toolIndex,
            partialJson: JSON.stringify(fc.args ?? {})
          };
          yield { kind: "tool_use_stop", index: toolIndex };
          toolIndex++;
        }
      }
```

Declare `let toolIndex = 0;` alongside the existing `let textIndex = 0;` near the top of `invoke()`. Also add `import { Buffer } from "node:buffer";` at the top of the file.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/backends/geminiBackend.test.ts`
Expected: PASS — all surviving Plan-06 tests + the new passthrough tests + the functionCall translation test.

- [ ] **Step 6: Commit**

```bash
git add src/backends/geminiBackend.ts tests/unit/backends/geminiBackend.test.ts tests/fixtures/mock-gemini/index.mjs
git commit -m "feat(geminiBackend): enable tool_use capability + functionCall event translation"
```

---

## Task 6: generateContent + streamGenerateContent handler

**Files:**
- Create: `src/geminiShim/generateContent.ts`
- Test: `tests/unit/geminiShim/generateContent.test.ts`

Express handler factory `createGenerateContentHandlers(deps)` returning `{ generate, streamGenerate }`. Both routes use the same factory. The difference is **only** the response shape — both pass through the same auth/translate/route pipeline.

Handler contract (mirrors Plan 03 with Gemini envelopes):
1. `checkAuth(req, config.apiKey)` — 401 with `unauthenticated` envelope on failure.
2. Parse the model from the URL path (`:model` express param), which already had `models/` stripped by the route mounter (Task 11).
3. `geminiRequestToNormalized(req.body, model, fileStore)` — `ShimRequestError` → 400 with `invalid_argument` envelope.
4. Resolve backend via `identifyBackend(model, defaultBackend)` + `registry.resolveModel(...)`. If unresolved, 404 with `not_found` envelope.
5. Invoke backend; stream Gemini SSE or buffer Gemini JSON depending on whether the route mounter set `streaming: true`.

Both handlers share a private helper `resolveBackend(...)` identical in spirit to Plan 03's.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/geminiShim/generateContent.test.ts` (full content in appendix). Cover:
  - **Auth (3 cases):** missing key → 401 envelope; wrong key → 401; `x-goog-api-key` header accepted; `?key=` query accepted.
  - **Request validation (4 cases):** empty contents → 400 with `INVALID_ARGUMENT` status; `cachedContent` → 400; `responseMimeType: application/json` → 400; `candidateCount: 5` → 400.
  - **Routing (3 cases):** unknown model → 404; `gemini-pro` routes to the gemini-shaped stub backend; `claude-opus-4-7` routes to the claude-shaped stub backend (the cross-shim × cross-backend dispatch test).
  - **Non-streaming response (3 cases):** returns Gemini-shaped body (`{candidates: [{content: {parts: [{text:...}]}, finishReason: "STOP", safetyRatings: []}], modelVersion, usageMetadata}`); forwards the translated NormalizedRequest to the backend; `modelVersion` field reflects the URL-path model id.
  - **Streaming response (2 cases):** emits `Content-Type: text/event-stream`; emits at least two `data: <JSON>\n\n` chunks with parseable `GenerateContentResponse` bodies, with the final chunk carrying `finishReason: "STOP"`.
  - **Backend errors (1 case):** `backend.invoke` throws → 500 with `internal` envelope.

Stub backends use the same `Backend` interface as in Plan 03. The stub for `gemini-pro` returns `id: "gemini"`, the stub for `claude-opus-4-7` returns `id: "claude"`; the test's `BackendRegistry` is populated with both.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/geminiShim/generateContent.test.ts`
Expected: FAIL — module `src/geminiShim/generateContent.js` not found.

- [ ] **Step 3: Create `src/geminiShim/generateContent.ts`**

```ts
import type { Request, RequestHandler, Response } from "express";
import { checkAuth } from "../auth.js";
import type { BackendRegistry } from "../backends/registry.js";
import type { Backend, BackendId } from "../backends/types.js";
import type { FileStore } from "../fileStore.js";
import { identifyBackend } from "../modelRouter.js";
import {
  internalError,
  invalidArgumentError,
  notFoundError,
  ShimRequestError,
  unauthenticatedError
} from "./errors.js";
import { geminiRequestToNormalized } from "./requestTranslator.js";
import {
  normalizedEventsToGeminiFinalResponse,
  normalizedEventsToGeminiSSE
} from "./responseTranslator.js";
import type { GeminiGenerateContentRequest } from "./types.js";

export interface GenerateContentHandlerConfig {
  apiKey: string;
  router: { defaultBackend: BackendId };
}

export interface GenerateContentHandlerDeps {
  registry: BackendRegistry;
  fileStore: FileStore;
  config: GenerateContentHandlerConfig;
}

function resolveBackend(
  registry: BackendRegistry,
  defaultBackend: BackendId,
  requestedModel: string
): { backend: Backend; resolvedModel: string } | { error: "not_found" } {
  const ident = identifyBackend(requestedModel, defaultBackend);
  if (ident.backend !== null) {
    const backend = registry.get(ident.backend);
    if (!backend) return { error: "not_found" };
    return { backend, resolvedModel: ident.remainingModel || requestedModel };
  }
  const found = registry.resolveModel(ident.remainingModel);
  if (found) return { backend: found, resolvedModel: ident.remainingModel };
  return { error: "not_found" };
}

interface MakeOptions {
  streaming: boolean;
}

function makeHandler(
  deps: GenerateContentHandlerDeps,
  opts: MakeOptions
): RequestHandler {
  return async (req: Request, res: Response) => {
    if (!checkAuth(req, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }

    // Route mounter strips `models/` prefix and parses `:method` so `req.params.model`
    // arrives as a bare model id by the time the handler runs.
    const model = req.params["model"];
    if (typeof model !== "string" || model.length === 0) {
      res.status(404).json(notFoundError("missing model in path"));
      return;
    }

    const body = req.body as GeminiGenerateContentRequest;
    let normalized;
    try {
      normalized = await geminiRequestToNormalized(body, model, deps.fileStore);
    } catch (e) {
      if (e instanceof ShimRequestError) {
        res.status(e.status).json(invalidArgumentError(e.message));
        return;
      }
      res
        .status(500)
        .json(internalError(e instanceof Error ? e.message : String(e)));
      return;
    }

    const resolved = resolveBackend(
      deps.registry,
      deps.config.router.defaultBackend,
      normalized.model
    );
    if ("error" in resolved) {
      res
        .status(404)
        .json(notFoundError(`model ${normalized.model} not found in any enabled backend`));
      return;
    }
    const { backend } = resolved;

    const meta = { model: normalized.model };

    try {
      const events = backend.invoke(normalized);

      if (opts.streaming) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        for await (const chunk of normalizedEventsToGeminiSSE(events, meta)) {
          res.write(chunk);
        }
        res.end();
      } else {
        const finalBody = await normalizedEventsToGeminiFinalResponse(events, meta);
        res.status(200).json(finalBody);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (res.headersSent) {
        res.end();
      } else {
        res.status(500).json(internalError(`backend error: ${msg}`));
      }
    }
  };
}

export interface GenerateContentHandlers {
  generate: RequestHandler;
  streamGenerate: RequestHandler;
}

export function createGenerateContentHandlers(
  deps: GenerateContentHandlerDeps
): GenerateContentHandlers {
  return {
    generate: makeHandler(deps, { streaming: false }),
    streamGenerate: makeHandler(deps, { streaming: true })
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/geminiShim/generateContent.test.ts`
Expected: PASS — all ~16 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/geminiShim/generateContent.ts tests/unit/geminiShim/generateContent.test.ts
git commit -m "feat(geminiShim): add generateContent + streamGenerateContent handler factory"
```

---

## Task 7: countTokens handler

**Files:**
- Create: `src/geminiShim/countTokens.ts`
- Test: `tests/unit/geminiShim/countTokens.test.ts`

`POST /v1beta/models/{model}:countTokens` accepts a body identical to `:generateContent` (or a wrapped `{contents: [...]}` body — both shapes appear in Google's docs; Plan 07 accepts both via the translator). Returns `{totalTokens: <n>}`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/geminiShim/countTokens.test.ts`. Cover (~6 cases):
- 401 on missing auth.
- 400 on empty `contents`.
- 404 on unknown model.
- 200 with `{totalTokens: <n>}` shape; verify delegated to `backend.countTokens` (stub returns 42; response is `{totalTokens: 42}`).
- 400 on out-of-scope features (e.g., `cachedContent`).
- Cross-backend dispatch: `model: "claude-opus-4-7"` reaches the Claude stub, returns the Claude stub's token count.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/geminiShim/countTokens.test.ts`
Expected: FAIL — module `src/geminiShim/countTokens.js` not found.

- [ ] **Step 3: Create `src/geminiShim/countTokens.ts`**

```ts
import type { Request, RequestHandler, Response } from "express";
import { checkAuth } from "../auth.js";
import type { BackendRegistry } from "../backends/registry.js";
import type { Backend, BackendId } from "../backends/types.js";
import type { FileStore } from "../fileStore.js";
import { identifyBackend } from "../modelRouter.js";
import {
  internalError,
  invalidArgumentError,
  notFoundError,
  ShimRequestError,
  unauthenticatedError
} from "./errors.js";
import { geminiRequestToNormalized } from "./requestTranslator.js";
import type {
  GeminiCountTokensResponse,
  GeminiGenerateContentRequest
} from "./types.js";

export interface CountTokensHandlerConfig {
  apiKey: string;
  router: { defaultBackend: BackendId };
}

export interface CountTokensHandlerDeps {
  registry: BackendRegistry;
  fileStore: FileStore;
  config: CountTokensHandlerConfig;
}

function resolveBackend(
  registry: BackendRegistry,
  defaultBackend: BackendId,
  requestedModel: string
): Backend | undefined {
  const ident = identifyBackend(requestedModel, defaultBackend);
  if (ident.backend !== null) return registry.get(ident.backend);
  return registry.resolveModel(ident.remainingModel);
}

export function createCountTokensHandler(
  deps: CountTokensHandlerDeps
): RequestHandler {
  return async (req: Request, res: Response) => {
    if (!checkAuth(req, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }

    const model = req.params["model"];
    if (typeof model !== "string" || model.length === 0) {
      res.status(404).json(notFoundError("missing model in path"));
      return;
    }

    const body = req.body as GeminiGenerateContentRequest;
    let normalized;
    try {
      normalized = await geminiRequestToNormalized(body, model, deps.fileStore);
    } catch (e) {
      if (e instanceof ShimRequestError) {
        res.status(e.status).json(invalidArgumentError(e.message));
        return;
      }
      res.status(500).json(internalError(e instanceof Error ? e.message : String(e)));
      return;
    }

    const backend = resolveBackend(
      deps.registry,
      deps.config.router.defaultBackend,
      normalized.model
    );
    if (!backend) {
      res.status(404).json(notFoundError(`model ${normalized.model} not found in any enabled backend`));
      return;
    }

    try {
      const totalTokens = await backend.countTokens(normalized);
      const out: GeminiCountTokensResponse = { totalTokens };
      res.status(200).json(out);
    } catch (e) {
      res.status(500).json(internalError(e instanceof Error ? e.message : String(e)));
    }
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/geminiShim/countTokens.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/geminiShim/countTokens.ts tests/unit/geminiShim/countTokens.test.ts
git commit -m "feat(geminiShim): add countTokens handler delegating to backend"
```

---

## Task 8: Files handlers — `/v1beta/files/*`

**Files:**
- Create: `src/geminiShim/files.ts`
- Test: `tests/unit/geminiShim/files.test.ts`

Five routes, all backed by the Plan-05 `FileStore`. Same shared content as the Anthropic-shim Files API, just re-shaped to Gemini's envelope:

| Route | Behavior |
|---|---|
| `POST /v1beta/files` | Multipart upload (parses via `multer`, same as Plan 05's Anthropic-shim handler). Returns a `GeminiFileResource`. |
| `GET /v1beta/files` | Paginated list. Returns `{files: [...], nextPageToken?}`. Plan 07 uses opaque page tokens (`base64(offset)`). |
| `GET /v1beta/files/{id}` | Metadata-only. Accepts both `files/<hash>` and `file_<hash>` formats (the route's express param captures the bare hex hash; the helper normalizes). |
| `GET /v1beta/files/{id}:download` | Stream bytes with the upload's MIME type. |
| `DELETE /v1beta/files/{id}` | Delete; returns 200 with empty body (Google's convention). |

**The `uri` field** in metadata responses must point at the local `:download` endpoint so SDK clients can follow it: `http://<server-host>/v1beta/files/<id>:download`. The handler synthesizes this from `req.protocol`, `req.get("host")`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/geminiShim/files.test.ts`. Cover (~14 cases):
- **Upload (3 cases):** 401 on missing auth; multipart upload returns `GeminiFileResource` with `name: "files/<24hex>"`; `uri` field points at `:download`.
- **List (3 cases):** 401; happy path returns `{files: [...]}`; pagination — passing `pageToken` advances offset.
- **Get metadata (3 cases):** 401; returns `GeminiFileResource`; 404 on unknown id.
- **Download (2 cases):** 401; returns the exact bytes with the upload's `Content-Type`.
- **Delete (2 cases):** 401; deletes the file (subsequent GET returns 404).
- **Cross-shim ID acceptance (1 case):** GET `/v1beta/files/file_<hash>` (Anthropic format) returns the same file as `/v1beta/files/files/<hash>` (Gemini format). Demonstrates that the file store is fully shared.

Full test file in the appendix.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/geminiShim/files.test.ts`
Expected: FAIL — module `src/geminiShim/files.js` not found.

- [ ] **Step 3: Create `src/geminiShim/files.ts`**

```ts
import type { Request, RequestHandler, Response } from "express";
import multer from "multer";
import { checkAuth } from "../auth.js";
import {
  FileNotFoundError,
  FileStore,
  normalizeFileId,
  toGeminiFileId,
  type FileMetadata
} from "../fileStore.js";
import {
  internalError,
  invalidArgumentError,
  notFoundError,
  unauthenticatedError
} from "./errors.js";
import type {
  GeminiFileResource,
  GeminiFilesListResponse
} from "./types.js";

export interface FilesHandlerConfig {
  apiKey: string;
}

export interface FilesHandlerDeps {
  fileStore: FileStore;
  config: FilesHandlerConfig;
}

export interface FilesHandlers {
  upload: RequestHandler[];
  list: RequestHandler;
  getMetadata: RequestHandler;
  download: RequestHandler;
  delete: RequestHandler;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100 MB; aligned with Plan-05 Anthropic-shim default
});

function makeUri(req: Request, geminiId: string): string {
  const host = req.get("host") ?? "127.0.0.1";
  const proto =
    req.protocol === "https" || req.protocol === "http" ? req.protocol : "http";
  return `${proto}://${host}/v1beta/${geminiId}:download`;
}

function toGeminiFileResource(req: Request, meta: FileMetadata): GeminiFileResource {
  const geminiId = toGeminiFileId(meta.id);
  return {
    name: geminiId,
    displayName: meta.filename,
    mimeType: meta.mime,
    sizeBytes: String(meta.size),
    createTime: meta.createdAt,
    updateTime: meta.lastAccessedAt,
    state: "ACTIVE",
    uri: makeUri(req, geminiId)
  };
}

function decodePageToken(token: string | undefined): number {
  if (!token) return 0;
  try {
    const n = Number.parseInt(Buffer.from(token, "base64url").toString("utf8"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function encodePageToken(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

export function createFilesHandlers(deps: FilesHandlerDeps): FilesHandlers {
  const uploadHandler: RequestHandler = async (req, res) => {
    if (!checkAuth(req, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json(invalidArgumentError("multipart file field missing"));
      return;
    }
    try {
      const filename = file.originalname || "upload";
      const mime = file.mimetype || "application/octet-stream";
      const meta = await deps.fileStore.upload(file.buffer, filename, mime);
      res.status(200).json({ file: toGeminiFileResource(req, meta) });
    } catch (e) {
      res.status(500).json(internalError(e instanceof Error ? e.message : String(e)));
    }
  };

  const list: RequestHandler = async (req, res) => {
    if (!checkAuth(req, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }
    const limit = Math.max(
      1,
      Math.min(100, Number.parseInt(String(req.query["pageSize"] ?? "20"), 10) || 20)
    );
    const offset = decodePageToken(
      typeof req.query["pageToken"] === "string" ? req.query["pageToken"] : undefined
    );
    try {
      const page = await deps.fileStore.list({ limit, offset });
      const body: GeminiFilesListResponse = {
        files: page.data.map((m) => toGeminiFileResource(req, m)),
        ...(page.has_more ? { nextPageToken: encodePageToken(offset + limit) } : {})
      };
      res.status(200).json(body);
    } catch (e) {
      res.status(500).json(internalError(e instanceof Error ? e.message : String(e)));
    }
  };

  const getMetadata: RequestHandler = async (req, res) => {
    if (!checkAuth(req, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }
    // Route mounter strips `files/` from URL; param holds the bare hex hash
    // OR a fully-prefixed id (when client sends file_<hash>). The normalizer
    // handles both.
    const idParam = req.params["id"];
    if (typeof idParam !== "string") {
      res.status(404).json(notFoundError("missing file id"));
      return;
    }
    const candidate = idParam.startsWith("file_") ? idParam : `files/${idParam}`;
    const normalized = normalizeFileId(candidate);
    if (!normalized) {
      res.status(404).json(notFoundError(`file ${idParam} not found`));
      return;
    }
    try {
      const { metadata } = await deps.fileStore.resolveById(normalized);
      res.status(200).json(toGeminiFileResource(req, metadata));
    } catch (e) {
      if (e instanceof FileNotFoundError) {
        res.status(404).json(notFoundError(`file ${idParam} not found`));
        return;
      }
      res.status(500).json(internalError(e instanceof Error ? e.message : String(e)));
    }
  };

  const download: RequestHandler = async (req, res) => {
    if (!checkAuth(req, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }
    const idParam = req.params["id"];
    if (typeof idParam !== "string") {
      res.status(404).json(notFoundError("missing file id"));
      return;
    }
    const candidate = idParam.startsWith("file_") ? idParam : `files/${idParam}`;
    const normalized = normalizeFileId(candidate);
    if (!normalized) {
      res.status(404).json(notFoundError(`file ${idParam} not found`));
      return;
    }
    try {
      const { bytes, metadata } = await deps.fileStore.resolveById(normalized);
      res.setHeader("Content-Type", metadata.mime);
      res.setHeader("Content-Length", String(bytes.length));
      res.status(200).end(bytes);
    } catch (e) {
      if (e instanceof FileNotFoundError) {
        res.status(404).json(notFoundError(`file ${idParam} not found`));
        return;
      }
      res.status(500).json(internalError(e instanceof Error ? e.message : String(e)));
    }
  };

  const deleteHandler: RequestHandler = async (req, res) => {
    if (!checkAuth(req, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }
    const idParam = req.params["id"];
    if (typeof idParam !== "string") {
      res.status(404).json(notFoundError("missing file id"));
      return;
    }
    const candidate = idParam.startsWith("file_") ? idParam : `files/${idParam}`;
    const normalized = normalizeFileId(candidate);
    if (!normalized) {
      res.status(404).json(notFoundError(`file ${idParam} not found`));
      return;
    }
    try {
      await deps.fileStore.delete(normalized);
      res.status(200).json({});
    } catch (e) {
      res.status(500).json(internalError(e instanceof Error ? e.message : String(e)));
    }
  };

  return {
    // Express applies middleware left-to-right; multer must run before the
    // handler so `req.file` is populated.
    upload: [upload.single("file"), uploadHandler],
    list,
    getMetadata,
    download,
    delete: deleteHandler
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/geminiShim/files.test.ts`
Expected: PASS — all 14 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/geminiShim/files.ts tests/unit/geminiShim/files.test.ts
git commit -m "feat(geminiShim): add /v1beta/files/* handlers backed by shared FileStore"
```

---

## Task 9: Models handlers — `/v1beta/models` + `/v1beta/models/{id}`

**Files:**
- Create: `src/geminiShim/models.ts`
- Test: `tests/unit/geminiShim/models.test.ts`

`GET /v1beta/models` returns `{models: [...]}` with each entry shaped as `GeminiModelEntry`. Lists models across **all enabled backends**, not just Gemini. Each entry's `name` is `models/<id>` (Gemini's wrapping convention). The `supportedGenerationMethods` array lists `["generateContent", "streamGenerateContent", "countTokens"]` for every model (Plan 07 doesn't expose embeddings or tuning through this surface).

`GET /v1beta/models/{id}` returns a single entry. The route param `{id}` is the bare model id (the route mounter strips `models/`).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/geminiShim/models.test.ts`. Cover (~9 cases):
- 401 on missing auth.
- 200 returns `{models: [...]}`; each entry has `name`, `displayName`, `description`, `supportedGenerationMethods`.
- Each `name` is prefixed with `models/`.
- Both `claude-*` and `gemini-*` models appear (cross-backend list).
- 200 on `GET /v1beta/models/{id}` with bare id returns the matching entry.
- 200 on `GET /v1beta/models/models/{id}` (Gemini SDK sometimes double-wraps) — verify the path mounter / handler strips the extra prefix.
- 404 on unknown model.
- Empty models list when registry has no probed models.
- Deduplication when the same id appears in multiple backends (registry-rebuild-order determines winner, same as Anthropic-shim list in Plan 03).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/geminiShim/models.test.ts`
Expected: FAIL — module `src/geminiShim/models.js` not found.

- [ ] **Step 3: Create `src/geminiShim/models.ts`**

```ts
import type { Request, RequestHandler, Response } from "express";
import { checkAuth } from "../auth.js";
import type { BackendRegistry } from "../backends/registry.js";
import type { ModelDescriptor } from "../backends/types.js";
import {
  internalError,
  notFoundError,
  unauthenticatedError
} from "./errors.js";
import { stripModelsPrefix } from "./modelPath.js";
import type {
  GeminiModelEntry,
  GeminiModelsListResponse
} from "./types.js";

export interface ModelsHandlerConfig {
  apiKey: string;
}

export interface GeminiModelsHandlerDeps {
  registry: BackendRegistry;
  config: ModelsHandlerConfig;
}

const SUPPORTED_METHODS = [
  "generateContent",
  "streamGenerateContent",
  "countTokens"
];

function descriptorToEntry(desc: ModelDescriptor): GeminiModelEntry {
  return {
    name: `models/${desc.id}`,
    displayName: desc.description ?? desc.id,
    description: desc.description ?? desc.id,
    ...(typeof desc.contextWindow === "number"
      ? { inputTokenLimit: desc.contextWindow, outputTokenLimit: 8192 }
      : {}),
    supportedGenerationMethods: SUPPORTED_METHODS
  };
}

async function gatherAllModels(
  registry: BackendRegistry
): Promise<GeminiModelEntry[]> {
  const seen = new Set<string>();
  const out: GeminiModelEntry[] = [];
  for (const backend of registry.enabledBackends()) {
    let models: ModelDescriptor[];
    try {
      models = await backend.listModels();
    } catch {
      continue;
    }
    for (const m of models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(descriptorToEntry(m));
    }
  }
  return out;
}

export interface GeminiModelsHandlers {
  list: RequestHandler;
  get: RequestHandler;
}

export function createGeminiModelsHandlers(
  deps: GeminiModelsHandlerDeps
): GeminiModelsHandlers {
  const list: RequestHandler = async (req: Request, res: Response) => {
    if (!checkAuth(req, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }
    try {
      const entries = await gatherAllModels(deps.registry);
      const body: GeminiModelsListResponse = { models: entries };
      res.status(200).json(body);
    } catch (e) {
      res.status(500).json(internalError(e instanceof Error ? e.message : String(e)));
    }
  };

  const get: RequestHandler = async (req: Request, res: Response) => {
    if (!checkAuth(req, deps.config.apiKey)) {
      res.status(401).json(unauthenticatedError("invalid or missing API key"));
      return;
    }
    const rawId = req.params["id"];
    if (typeof rawId !== "string" || rawId.length === 0) {
      res.status(404).json(notFoundError("missing model id"));
      return;
    }
    const id = stripModelsPrefix(rawId);
    try {
      const entries = await gatherAllModels(deps.registry);
      const found = entries.find((e) => e.name === `models/${id}`);
      if (!found) {
        res.status(404).json(notFoundError(`model ${id} not found`));
        return;
      }
      res.status(200).json(found);
    } catch (e) {
      res.status(500).json(internalError(e instanceof Error ? e.message : String(e)));
    }
  };

  return { list, get };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/geminiShim/models.test.ts`
Expected: PASS — all 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/geminiShim/models.ts tests/unit/geminiShim/models.test.ts
git commit -m "feat(geminiShim): add /v1beta/models list + get with cross-backend dispatch"
```

---

## Task 10: Mount Gemini routes in `src/server.ts`

**Files:**
- Modify: `src/server.ts`

The Gemini route paths are unusual because the `:method` suffix in `models/{model}:method` is part of the URL segment, not a query parameter. Express's path-to-regexp does not natively split on `:` (it treats `:` as a param indicator), so the routes are mounted via a custom regex pattern that captures `{model}` as a param and treats the action suffix as part of the URL.

There are two acceptable approaches:

1. **Per-method literal routes** — mount each method explicitly: `app.post("/v1beta/models/:model\\:generateContent", ...)`. The `\\:` escapes the colon. This is the simplest and clearest.
2. **Single regex route** — `app.post(/^\/v1beta\/models\/([^:/]+(?::[^:/]+)?):([A-Za-z]+)$/, ...)` and parse the segments inside a dispatcher. More flexible but loses Express's named-param ergonomics.

Plan 07 uses **approach 1** — five literal routes for the three model methods (`generateContent`, `streamGenerateContent`, `countTokens`). Each route mounts the handler that already knows whether it's streaming or not.

**Note on the `models/` prefix:** Clients send both `model: "gemini-pro"` and `model: "models/gemini-pro"`. The express route `/v1beta/models/:model:generateContent` does NOT match `/v1beta/models/models/gemini-pro:generateContent` (extra segment). Mount **two** parallel routes per method — one for the bare-id form and one for the prefixed form — both wired to the same handler with a small `req.params.model` cleanup.

For files (`/v1beta/files/{id}:download`) the same colon-escape rule applies for the `:download` suffix. The other file routes (`/v1beta/files`, `/v1beta/files/{id}`, `DELETE`) use ordinary Express routes.

- [ ] **Step 1: Extend `src/server.ts`**

At the top, add the new imports:

```ts
import { FileStore } from "./fileStore.js";
import { createCountTokensHandler as createGeminiCountTokensHandler } from "./geminiShim/countTokens.js";
import { createFilesHandlers as createGeminiFilesHandlers } from "./geminiShim/files.js";
import { createGenerateContentHandlers } from "./geminiShim/generateContent.js";
import { createGeminiModelsHandlers } from "./geminiShim/models.js";
```

Extend `ServerDeps`:

```ts
export interface ServerDeps {
  config: Config;
  registry: BackendRegistry;
  archive: Archive;
  fileStore: FileStore;
}
```

Inside `buildApp(deps)`, after the Anthropic-shim routes, add the Gemini routes:

```ts
  // ---- Gemini shim ------------------------------------------------------
  const geminiHandlerConfig = {
    apiKey: deps.config.apiKey,
    router: { defaultBackend: deps.config.router.defaultBackend }
  };

  const generateHandlers = createGenerateContentHandlers({
    registry: deps.registry,
    fileStore: deps.fileStore,
    config: geminiHandlerConfig
  });
  const countTokensHandler = createGeminiCountTokensHandler({
    registry: deps.registry,
    fileStore: deps.fileStore,
    config: geminiHandlerConfig
  });

  // The colon-escaped route pattern is the load-bearing Express idiom for
  // Gemini's `:method` action suffix. Mount each method twice — once for the
  // bare id and once for the `models/`-prefixed form. The handler treats
  // req.params.model as the bare id; for the prefixed mount, strip via a
  // tiny middleware before the handler runs.
  const stripModelsParam: RequestHandler = (req, _res, next) => {
    const m = req.params["model"];
    if (typeof m === "string" && m.startsWith("models/")) {
      req.params["model"] = m.slice("models/".length);
    }
    next();
  };

  for (const action of ["generateContent", "streamGenerateContent", "countTokens"] as const) {
    const handler =
      action === "generateContent"
        ? generateHandlers.generate
        : action === "streamGenerateContent"
          ? generateHandlers.streamGenerate
          : countTokensHandler;
    // Bare-id form: /v1beta/models/<id>:<action>
    app.post(`/v1beta/models/:model\\:${action}`, handler);
    // Prefixed form (Express captures literal `models/` inside :model when matched
    // by a single param — to support nested form, use two regex routes):
    app.post(new RegExp(`^/v1beta/models/(models/[^:]+)\\:${action}$`), (req, res, next) => {
      // The regex capture lands at req.params[0]; transplant to req.params.model.
      const m = req.params[0];
      if (typeof m === "string") {
        req.params["model"] = m.startsWith("models/") ? m.slice("models/".length) : m;
      }
      handler(req, res, next);
    });
  }

  const geminiModelsHandlers = createGeminiModelsHandlers({
    registry: deps.registry,
    config: { apiKey: deps.config.apiKey }
  });
  app.get("/v1beta/models", geminiModelsHandlers.list);
  app.get("/v1beta/models/:id", geminiModelsHandlers.get);
  // Allow the `models/<id>` double-wrap form via a separate regex route:
  app.get(/^\/v1beta\/models\/models\/(.+)$/, (req, res, next) => {
    const m = req.params[0];
    if (typeof m === "string") req.params["id"] = m;
    geminiModelsHandlers.get(req, res, next);
  });

  const geminiFilesHandlers = createGeminiFilesHandlers({
    fileStore: deps.fileStore,
    config: { apiKey: deps.config.apiKey }
  });
  app.post("/v1beta/files", geminiFilesHandlers.upload);
  app.get("/v1beta/files", geminiFilesHandlers.list);
  app.get("/v1beta/files/:id", geminiFilesHandlers.getMetadata);
  // Colon-escaped download path:
  app.get("/v1beta/files/:id\\:download", geminiFilesHandlers.download);
  // Accept the `file_<hash>` form too (Anthropic id used by a cross-shim caller):
  app.get(/^\/v1beta\/files\/(file_[0-9a-f]{24})\\:download$/, (req, res, next) => {
    req.params["id"] = req.params[0] ?? "";
    geminiFilesHandlers.download(req, res, next);
  });
  app.delete("/v1beta/files/:id", geminiFilesHandlers.delete);

  // suppress unused-var warning from the middleware factory if applicable
  void stripModelsParam;
```

(The `stripModelsParam` middleware is declared here for future reuse — Plan 07's regex-routed handlers do their own stripping inline. Future plans may refactor to share it.)

Extend `main()` to construct the `FileStore` and pass it into `buildApp`:

```ts
export async function main(opts: MainOptions): Promise<RunningServer> {
  const config = loadConfig(opts.configPath);
  const archive = new Archive(config.archive.dbPath);
  const fileStore = new FileStore({
    dir: config.files.dir,
    ttlMs: config.files.ttlMs,
    maxTotalBytes: config.files.maxTotalBytes
  });
  const registry = buildRegistry(config);

  const app = buildApp({ config, registry, archive, fileStore });
  // ... rest unchanged ...
```

Add `fileStore.stop()` to the shutdown sequence:

```ts
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    registry.stop();
    fileStore.stop();
    archive.close();
    await new Promise<void>((resolve) => { ... });
  };
```

Extend `RunningServer`:

```ts
export interface RunningServer {
  app: Express;
  http: Server;
  registry: BackendRegistry;
  archive: Archive;
  fileStore: FileStore;
  config: Config;
  shutdown: () => Promise<void>;
}
```

And return it from `main()`:

```ts
  return { app, http, registry, archive, fileStore, config, shutdown };
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 3: Run the full unit suite**

Run: `npx vitest run tests/unit/`
Expected: All Plans 01-06 + Plan-07-task-1-9 unit tests green.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): mount /v1beta/* Gemini routes alongside Anthropic shim"
```

---

## Task 11: Integration test — `:generateContent` against both backends

**Files:**
- Create: `tests/integration/generateContent.test.ts`

End-to-end HTTP test: spawn `src/bin.ts` against a config that wires mock-claude and mock-gemini, hit `POST /v1beta/models/gemini-pro:generateContent` and `POST /v1beta/models/claude-opus-4-7:generateContent`, verify both return Gemini-shaped bodies. Mirror of the Plan-03 integration test.

- [ ] **Step 1: Write the test**

Create `tests/integration/generateContent.test.ts`. Reuse Plan 03's `startServer` / `stopServer` / `postJson` helpers (copy them into this file — keeping the integration tests self-contained mirrors the existing Plan-03 / Plan-06 pattern; a future plan can extract a shared `tests/integration/_helpers.ts` if duplication becomes painful).

Tests (~7 cases):
- **Non-streaming gemini → mock-gemini:** POST `/v1beta/models/gemini-pro:generateContent` returns 200 with `{candidates: [{content: {parts: [{text: "echo: user: ..."}]}, finishReason: "STOP", safetyRatings: []}], modelVersion, usageMetadata}`.
- **Non-streaming claude → mock-claude (cross-shim):** POST `/v1beta/models/claude-opus-4-7:generateContent` returns 200 with the same Gemini-shaped body, where the text is the Claude mock's response. **This is the cross-shim × cross-backend dispatch demonstration.**
- **Streaming gemini → mock-gemini:** POST `/v1beta/models/gemini-pro:streamGenerateContent` returns `Content-Type: text/event-stream`; body contains `data: <JSON>` chunks ending with one containing `finishReason: "STOP"`.
- **Streaming claude → mock-claude (cross-shim streaming):** Same, but with `claude-opus-4-7` model.
- **`models/` prefix accepted:** POST `/v1beta/models/models/gemini-pro:generateContent` works identically.
- **`countTokens` non-trivial response:** POST `/v1beta/models/gemini-pro:countTokens` returns `{totalTokens: <n>}`.
- **`GET /v1beta/models` returns both Claude and Gemini models with `models/` prefix:** ids include `models/gemini-pro`, `models/gemini-flash`, `models/claude-opus-4-7`, `models/claude-sonnet-4-6`, etc.

The startServer fixture must include both `claude` and `gemini` backend blocks in the config (`claude.command: ["node", MOCK_CLAUDE_JS]`, `gemini.command: ["node", MOCK_GEMINI_JS]`, both `enabled: true`).

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run tests/integration/generateContent.test.ts`
Expected: PASS — all 7 tests green. Subprocess startup may take ~3-5 seconds; raise `vitest`'s default timeout for these tests via `, 30000)` on each `it(...)` if needed.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/generateContent.test.ts
git commit -m "test(geminiShim): full HTTP stack — generateContent across gemini-pro and claude-opus-4-7"
```

---

## Task 12: Integration test — cross-shim file references

**Files:**
- Create: `tests/integration/crossShimFiles.test.ts`

The cross-shim file-ID interoperability test. Demonstrates that a file uploaded via the Anthropic shim's `POST /v1/files` is resolvable by the Gemini shim's `fileData.fileUri: "files/<hash>"` in a `:generateContent` call, and vice versa.

This exercises:
- `FileStore.resolveById` accepting both ID formats (Task 1).
- The shared `data/files/` directory across the two shims (Plan 05 + Task 10 share the same `FileStore` instance).
- The Gemini request translator's resolution path (Task 3).
- The Anthropic request translator's existing file-ref resolution (Plan 05).

- [ ] **Step 1: Write the test**

Create `tests/integration/crossShimFiles.test.ts`. Spawn the server the same way Task 11 does (mock-claude + mock-gemini both enabled).

Tests (~4 cases):

1. **Upload via Anthropic shim, reference via Gemini shim:**
   - `POST /v1/files` (multipart upload) → response body has `{id: "file_<24hex>", ...}`.
   - `POST /v1beta/models/gemini-pro:generateContent` with body containing `{contents: [{role: "user", parts: [{fileData: {mimeType: "image/png", fileUri: "files/<hash>"}}]}]}` — where `<hash>` is the 24-hex from the upload response — returns 200. The mock-gemini fixture echoes the prompt; verify the response candidate text includes evidence that the file bytes were inlined into the prompt (the mock currently just echoes; assert the file's hash appears in the prompt or the request was accepted without 400).

2. **Upload via Gemini shim, reference via Anthropic shim:**
   - `POST /v1beta/files` (multipart upload) → response body has `{file: {name: "files/<24hex>", ...}}`.
   - `POST /v1/messages` with content block `{type: "image", source: {type: "file", file_id: "file_<hash>"}}` — where `<hash>` is from the Gemini upload's `name` field — returns 200.

3. **Same upload, accessible by both download endpoints:**
   - Upload via `POST /v1/files`; download via `GET /v1beta/files/files/<hash>:download` returns the original bytes.
   - Upload via `POST /v1beta/files`; download via `GET /v1/files/file_<hash>/content` returns the original bytes.

4. **Anthropic-format ID accepted in Gemini's `fileData.fileUri`:**
   - Upload via `POST /v1/files`; use the returned `file_<hash>` id directly in a Gemini `:generateContent` call (without re-shaping to `files/<hash>`). Verify it still resolves — proves the translator accepts either format inline.

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run tests/integration/crossShimFiles.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 3: Run the full suite for regression check**

Run: `npx vitest run`
Expected: All prior-plan tests + the new Plan-07 unit + integration tests green.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/crossShimFiles.test.ts
git commit -m "test(integration): cross-shim file references — upload via one shim, consume via the other"
```

---

## Task 13: Plan-07 close-out documentation

**Files:**
- Create: `docs/plan-07-gemini-shim-readme.md`

- [ ] **Step 1: Write the document**

```markdown
# Plan 07 — Gemini Shim: what shipped

Plan 07 adds the Google Gemini-shaped HTTP surface on top of the Plans 01-06 baseline. After Plan 07, any client built on `@google/generative-ai` can reach the server, AND the cross-shim × cross-backend dispatch is closed in both directions.

## Endpoints live

| Method | Path | Status |
|---|---|---|
| POST | `/v1beta/models/{model}:generateContent` | Non-streaming generation across all enabled backends |
| POST | `/v1beta/models/{model}:streamGenerateContent` | Streaming generation (Gemini SSE `data: <JSON>\n\n` chunks) |
| POST | `/v1beta/models/{model}:countTokens` | Token counting |
| GET  | `/v1beta/models` | Cross-backend model list (Gemini-shaped envelope) |
| GET  | `/v1beta/models/{id}` | Single-entry model lookup |
| POST | `/v1beta/files` | Multipart upload, shares storage with `/v1/files` |
| GET  | `/v1beta/files` | Paginated list |
| GET  | `/v1beta/files/{id}` | Metadata; `uri` points at `:download` |
| GET  | `/v1beta/files/{id}:download` | Stream bytes |
| DELETE | `/v1beta/files/{id}` | Delete |

Both `model: "gemini-pro"` and `model: "models/gemini-pro"` are accepted (the prefix is stripped). Both `files/<24hex>` and `file_<24hex>` IDs are accepted everywhere a file is referenced.

## Modules added

| Path | Purpose |
|---|---|
| `src/geminiShim/types.ts` | Gemini API request/response/file shapes (subset honored by Plan 07) |
| `src/geminiShim/errors.ts` | Gemini envelope helpers + `ShimRequestError` |
| `src/geminiShim/modelPath.ts` | `stripModelsPrefix`, `parseModelMethodPath` |
| `src/geminiShim/requestTranslator.ts` | Gemini body → `NormalizedRequest` (async — touches FileStore) |
| `src/geminiShim/responseTranslator.ts` | `NormalizedEvent` → Gemini SSE / buffered body |
| `src/geminiShim/generateContent.ts` | `:generateContent` + `:streamGenerateContent` handler factory |
| `src/geminiShim/countTokens.ts` | `:countTokens` handler factory |
| `src/geminiShim/files.ts` | All 5 `/v1beta/files/*` handlers |
| `src/geminiShim/models.ts` | `/v1beta/models` list + get handlers |
| `src/fileStore.ts` (extended) | `resolveById`, `normalizeFileId`, `toGeminiFileId` |
| `src/backends/geminiBackend.ts` (extended) | `toolUse: true`, functionCall event translation, prompt-fold extension for multimodal/tool blocks |
| `src/server.ts` (extended) | Mounts all 10 new routes; constructs `FileStore` at startup |

## Cross-shim × cross-backend dispatch — fully closed

| Client SDK | Sends model | Resolves to backend | Response shape |
|---|---|---|---|
| `@anthropic-ai/sdk` | `claude-opus-4-7` | Claude (CLI) | Anthropic SSE |
| `@anthropic-ai/sdk` | `gemini-pro` | Gemini (CLI) | Anthropic SSE |
| `@google/generative-ai` | `gemini-pro` | Gemini (CLI) | Gemini SSE |
| `@google/generative-ai` | `claude-opus-4-7` | Claude (CLI) | Gemini SSE |

The four-cell matrix is exercised by the Plan 07 integration tests.

## Capability concerns

- **`tool_choice` analog:** Gemini's `toolConfig.functionCallingConfig.mode` maps to/from `NormalizedToolChoice`. `AUTO` ↔ `"auto"`, `ANY` ↔ `"any"`, `NONE` ↔ `"none"`. `MODE_UNSPECIFIED` and an absent toolConfig both fall through to `"auto"`.
- **Safety ratings on non-Gemini backends:** Plan 07's response translator emits `safetyRatings: []` on every candidate. Real safety enforcement is not in the proxy's scope. When the executing backend IS Gemini, ratings come from the CLI's stream chunks (currently dropped at the `NormalizedEvent` boundary; a future plan can wire them through).
- **`/v1beta/models` listing:** includes both `models/gemini-*` and `models/claude-*` entries. The Gemini SDK accepts cross-backend model ids transparently; the `models/` wrap is the only Gemini-specific shape.

## Plan-07 scope boundary (deferrals)

The request translator returns 400 `INVALID_ARGUMENT` on these:

- `tools[].googleSearchRetrieval` (Gemini grounding)
- `tools[].codeExecution`
- `generationConfig.responseSchema` / `responseMimeType: "application/json"` (JSON mode)
- `generationConfig.candidateCount > 1`
- `cachedContent` (Gemini context caching)

Server-internal deferrals:

- `tools[]` ARE forwarded to the Gemini backend, but the `geminiStreamRunner` does NOT yet pass them as `--tools` to the CLI. (A small `Plan-07.5` would wire this; today, native function calling against the real Gemini CLI requires another runner-side extension.) The mock fixture demonstrates the full event pipeline regardless.
- Archive writes from the Gemini shim. The Plan-05 archive writer is mounted on the Anthropic shim only; the Gemini shim's `:generateContent` calls do not yet land in the archive. Open question item.
- LM Studio / Ollama backend dispatch (Plans 08/09). The Gemini shim's model-resolution path correctly routes to whichever backend the registry knows about, but no LM-Studio or Ollama backend is registered yet.
- Batches API (`:batchGenerateContent`).
- Real-time streaming WebSocket.

## What the next plan (Plan 08 — LM Studio backend) needs

- Adds a fourth `Backend` implementation in `src/backends/lmstudioBackend.ts`.
- The Gemini shim's model-resolution path (Task 6) routes `lmstudio/qwen3-coder-30b` etc. through the registry once LM Studio's backend is registered. No changes required in `src/geminiShim/` to enable this.
- The Gemini files handlers already work cross-backend (the file is inlined as base64 by the request translator, then folded into the LM Studio request like any other multimodal block).

## Operational notes

- Default port stays at 3210. Gemini routes mount alongside Anthropic routes.
- `x-goog-api-key` header and `?key=<key>` query are both accepted everywhere (Plan-01 `checkAuth` already supports them).
- The `files/<24hex>` / `file_<24hex>` cross-format aliasing is transparent to clients of either SDK.

## Open questions surfaced during Plan 07

1. **Archive writes from the Gemini shim.** Plan 05's archive writer is wired in `src/anthropicShim/messages.ts`. Plan 07 does NOT add an equivalent write in `src/geminiShim/generateContent.ts` because doing so would partially duplicate the Plan-05 logic. A small follow-up plan should extract the archive write into a shared helper (`src/archive.ts` already has the writer API) and invoke it from both shims.
2. **Real safety ratings.** Plan 07 synthesizes `safetyRatings: []`. When the executing backend is Gemini, real ratings come from the CLI stream chunks but are dropped at the `NormalizedEvent` boundary. A future "Plan 07.5" can extend `NormalizedEvent` with an optional `safetyRatings` carrier and surface them through the response translator.
3. **Gemini SSE format pinning.** The `@google/generative-ai` SDK accepts both line-delimited JSON arrays and `data: <JSON>\n\n` SSE. Plan 07 ships SSE. If a real-world SDK version we care about only supports the JSON-array form, the response translator's output format becomes a one-character change in `sseChunk`.
4. **`tools[]` end-to-end against the real Gemini CLI.** Plan 07 enables the capability flag and finishes the event-level round-trip against mock-gemini, but the `geminiStreamRunner` does not yet pass `--tools` to the CLI. Verify the real CLI's tool-flag surface and extend the runner before declaring end-to-end function calling production-ready.
5. **Express route mounting for `:method` suffixes on Windows.** The colon-escape pattern (`/v1beta/models/:model\\:generateContent`) relies on path-to-regexp v6 semantics. If a future Express upgrade changes the escape behavior, the route mounter in `src/server.ts` is the place to revisit.
6. **`models/` double-wrap form.** The Plan-07 route mounter handles `/v1beta/models/models/gemini-pro:generateContent` via a regex route. If real-world clients never send this form, the regex routes can be removed to simplify the mount table.
```

- [ ] **Step 2: Commit**

```bash
git add docs/plan-07-gemini-shim-readme.md
git commit -m "docs: add Plan 07 close-out README documenting Gemini shim scope and boundaries"
```

---

## Plan 07 — Self-review checklist

Before declaring Plan 07 done, run through this checklist:

- [ ] `npm test` — all tests green, no skips. Expect Plans 01-06 count + ~125 new (5 errors + 12 modelPath + 32 requestTranslator + 22 responseTranslator + 16 generateContent + 6 countTokens + 14 files + 9 models + 5 fileStore-cross-format + 4 geminiBackend-extension + 7 integration generateContent + 4 integration crossShimFiles ≈ 136 new). Reconcile actual vs expected in the close-out doc.
- [ ] `npx tsc --noEmit` — no type errors. Pay particular attention to `noUncheckedIndexedAccess` on `req.params["model"]` accesses in handlers and on `events[events.length - 1]` accesses in tests.
- [ ] `git status` — clean tree, all changes committed (except pre-existing untracked files like `scripts/configure-agent-zero.sh`).
- [ ] `git log --oneline -15` — commits read sensibly: fileStore extension, types+errors+modelPath, requestTranslator, responseTranslator, geminiBackend extension, generateContent, countTokens, files, models, server mount, integration generateContent, integration crossShimFiles, README.
- [ ] `src/geminiShim/` contains exactly 8 files: `types.ts`, `errors.ts`, `modelPath.ts`, `requestTranslator.ts`, `responseTranslator.ts`, `generateContent.ts`, `countTokens.ts`, `files.ts`, `models.ts`. (That's 9 — re-count and adjust if a file was merged.)
- [ ] `src/fileStore.ts` exports `normalizeFileId`, `toGeminiFileId`, and `FileStore.resolveById` in addition to the Plan-05 surface. `FileStore.resolveForInline` works with both ID formats (delegates through `resolveById`).
- [ ] `src/backends/geminiBackend.ts` returns `capabilitiesFor().toolUse === true`. The Plan-06 scope-throws for `tools` and `stopSequences` are gone.
- [ ] `src/server.ts` mounts exactly 10 new routes: `POST /v1beta/models/{model}:generateContent`, `POST /v1beta/models/{model}:streamGenerateContent`, `POST /v1beta/models/{model}:countTokens` (three; each also accepts the `models/` double-wrap form via a regex sibling), `GET /v1beta/models`, `GET /v1beta/models/{id}`, plus the five files routes.
- [ ] Every `src/*` import uses an explicit `.js` extension (NodeNext).
- [ ] No handler factory reads from module-scoped state — every dep arrives through the factory args.
- [ ] Gemini SSE chunks emitted by `responseTranslator` start with `data: ` and end with `\n\n` (verified by tests in Task 4).
- [ ] `countTokens` returns exactly `{totalTokens: <n>}` — no extra fields (verified in Task 7).
- [ ] `/v1beta/models` entries each have `name: "models/<id>"`, `displayName`, `description`, `supportedGenerationMethods` (verified in Task 9).
- [ ] Auth failures return Gemini-shaped 401 envelopes; bad requests return 400 `INVALID_ARGUMENT`; not-found returns 404 `NOT_FOUND`; backend errors return 500 `INTERNAL`.
- [ ] The integration test in Task 11 successfully exercises both `gemini-pro` and `claude-opus-4-7` through the same Gemini-shim handler.
- [ ] The cross-shim files test in Task 12 successfully exercises the bidirectional file-ID round-trip.
- [ ] No source file under `src/geminiShim/` exceeds 350 lines (`files.ts` and `generateContent.ts` are the largest; both should stay under 320).
- [ ] No new direct dependencies on `dist/` from anywhere under `src/geminiShim/` or `tests/unit/geminiShim/`.
- [ ] Plan-03 Anthropic-shim tests still pass unchanged.
- [ ] Plan-04 tool_use round-trip tests still pass unchanged.
- [ ] Plan-05 file-store tests still pass unchanged (the new tests are additive).
- [ ] Plan-06 Gemini-backend skeleton + invoke tests still pass; only the two retired scope-throw tests are removed.

If all check, Plan 07 is shipped. Open a PR to main; Plan 08 (LM Studio backend) follows.

---

## Open questions

These deserve attention from a human reviewer before or during Plan 07 execution, and may shift later plans:

1. **Archive integration from the Gemini shim.** Plan 05's archive writer is mounted in the Anthropic shim's `messages.ts`. Plan 07 does not duplicate that wiring inside `generateContent.ts`. Either extract a shared helper (preferred) or accept a one-plan gap. Suggested patch: a `src/archive/recordCompletion.ts` helper called from both shims after invoke returns.

2. **`tools[]` end-to-end against the real Gemini CLI.** The capability is flipped on and the event translation works against mock-gemini. The `geminiStreamRunner` does not yet pass `--tools` to the CLI. Verify the real CLI's tool-flag surface (probably `--tools <jsonPath>` or similar) and extend `buildStreamArgs` + the mock in lockstep. Test with the real `gemini` CLI before declaring production-ready.

3. **Synthesized `call_<base64url>` IDs vs Anthropic's `toolu_*` format.** The cross-shim case (Gemini SDK → Claude backend → Gemini SSE) produces tool_use ids that don't match either format's wire convention. Decide whether to (a) leave as-is (the IDs are opaque to clients), (b) prefix by source (`call_a_<...>` for anthropic, `call_g_<...>` for gemini), or (c) generate canonical UUIDs everywhere.

4. **`fileData.mimeType` truthiness vs the stored file's mimeType.** The translator uses the request's `mimeType` to decide image-vs-document, but the stored file's metadata also has a mime type. If they differ (client claims `image/png` but the file is actually `application/pdf`), Plan 07 trusts the request. Decide whether to also enforce a server-side check.

5. **Gemini SSE format (line-delimited JSON arrays vs `data: <JSON>\n\n` SSE).** Plan 07 ships SSE. Document which the `@google/generative-ai` SDK accepts in production and pin the choice in the response-translator README comment if needed.

6. **`models/` double-wrap regex routes.** The mounter adds a sibling regex route per method to handle `/v1beta/models/models/<id>:method`. If real-world clients never send this form, drop the sibling routes and simplify.

7. **`safetyRatings` are always `[]`.** The Gemini SDK may treat absent ratings differently than empty ones. Test with the real SDK and adjust if needed.

8. **Multer dependency check.** Plan 05 added `multer`; this plan reuses it for `/v1beta/files`. Confirm `package.json` declares `multer` as a runtime dependency (not just `@types/multer` as dev).

---

## Appendix — Test file templates

The handler-test and translator-test files are large; full content is included here so the implementer doesn't have to reconstruct them from the per-task summaries.

### A.1 `tests/unit/geminiShim/responseTranslator.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  normalizedEventsToGeminiFinalResponse,
  normalizedEventsToGeminiSSE
} from "../../../src/geminiShim/responseTranslator.js";
import type { NormalizedEvent } from "../../../src/backends/types.js";

async function* fromArray(events: NormalizedEvent[]): AsyncIterable<NormalizedEvent> {
  for (const e of events) yield e;
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

function parseSseChunk(chunk: string): unknown {
  const data = chunk.replace(/^data:\s*/, "").trimEnd();
  return JSON.parse(data);
}

const META = { model: "gemini-pro" };

describe("normalizedEventsToGeminiSSE — text only", () => {
  it("emits a data: <JSON>\\n\\n chunk per delta", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "hello " },
      { kind: "text_delta", index: 0, text: "world" },
      { kind: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    expect(chunks.length).toBe(3);
    for (const c of chunks) {
      expect(c.startsWith("data: ")).toBe(true);
      expect(c.endsWith("\n\n")).toBe(true);
    }
  });

  it("final chunk carries finishReason STOP and usageMetadata", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!) as {
      candidates: { finishReason?: string }[];
      usageMetadata: unknown;
    };
    expect(last.candidates[0]?.finishReason).toBe("STOP");
    expect(last.usageMetadata).toBeDefined();
  });

  it("accumulated text reproduces the original", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "hello " },
      { kind: "text_delta", index: 0, text: "world" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!) as {
      candidates: { content: { parts: { text?: string }[] } }[];
    };
    const text = last.candidates[0]?.content.parts.map((p) => p.text ?? "").join("");
    expect(text).toBe("hello world");
  });

  it("model field uses meta.model when source omits message_start", async () => {
    const events: NormalizedEvent[] = [
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!) as { modelVersion: string };
    expect(last.modelVersion).toBe("gemini-pro");
  });
});

describe("normalizedEventsToGeminiSSE — finishReason mapping", () => {
  async function reasonInFinal(
    reason: Extract<NormalizedEvent, { kind: "message_stop" }>["stopReason"]
  ): Promise<string | undefined> {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: reason }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!) as {
      candidates: { finishReason?: string }[];
    };
    return last.candidates[0]?.finishReason;
  }

  it("end_turn → STOP", async () => { expect(await reasonInFinal("end_turn")).toBe("STOP"); });
  it("stop_sequence → STOP", async () => { expect(await reasonInFinal("stop_sequence")).toBe("STOP"); });
  it("max_tokens → MAX_TOKENS", async () => { expect(await reasonInFinal("max_tokens")).toBe("MAX_TOKENS"); });
  it("tool_use → STOP", async () => { expect(await reasonInFinal("tool_use")).toBe("STOP"); });
  it("error → OTHER", async () => { expect(await reasonInFinal("error")).toBe("OTHER"); });
});

describe("normalizedEventsToGeminiSSE — tool_use", () => {
  it("emits a functionCall part on the final chunk", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "tool_use_start", index: 0, id: "call_abc", name: "calc" },
      { kind: "tool_use_delta", index: 0, partialJson: '{"x":1,"y":2}' },
      { kind: "tool_use_stop", index: 0 },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!) as {
      candidates: { content: { parts: Array<{ functionCall?: { name: string; args: unknown } }> } }[];
    };
    const fc = last.candidates[0]?.content.parts.find((p) => p.functionCall);
    expect(fc?.functionCall?.name).toBe("calc");
    expect(fc?.functionCall?.args).toEqual({ x: 1, y: 2 });
  });

  it("multiple tool_use blocks at different indices each produce a functionCall part", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "tool_use_start", index: 0, id: "c1", name: "a" },
      { kind: "tool_use_delta", index: 0, partialJson: "{}" },
      { kind: "tool_use_stop", index: 0 },
      { kind: "tool_use_start", index: 1, id: "c2", name: "b" },
      { kind: "tool_use_delta", index: 1, partialJson: "{}" },
      { kind: "tool_use_stop", index: 1 },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!) as {
      candidates: { content: { parts: Array<{ functionCall?: { name: string } }> } }[];
    };
    const names = last.candidates[0]?.content.parts
      .filter((p) => p.functionCall)
      .map((p) => p.functionCall?.name);
    expect(names).toEqual(["a", "b"]);
  });

  it("partial JSON from multiple deltas is concatenated and parsed at stop time", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "tool_use_start", index: 0, id: "c1", name: "split" },
      { kind: "tool_use_delta", index: 0, partialJson: '{"x":' },
      { kind: "tool_use_delta", index: 0, partialJson: "42}" },
      { kind: "tool_use_stop", index: 0 },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!) as {
      candidates: { content: { parts: Array<{ functionCall?: { args: unknown } }> } }[];
    };
    expect(last.candidates[0]?.content.parts[0]?.functionCall?.args).toEqual({ x: 42 });
  });
});

describe("normalizedEventsToGeminiSSE — safetyRatings + synthesis", () => {
  it("each candidate carries safetyRatings: []", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    for (const c of chunks) {
      const obj = parseSseChunk(c) as {
        candidates: { safetyRatings: unknown[] }[];
      };
      expect(obj.candidates[0]?.safetyRatings).toEqual([]);
    }
  });

  it("synthesizes a final chunk when source stream ends without message_stop", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "hi" }
    ];
    const chunks = await collect(normalizedEventsToGeminiSSE(fromArray(events), META));
    const last = parseSseChunk(chunks[chunks.length - 1]!) as {
      candidates: { finishReason?: string }[];
    };
    expect(last.candidates[0]?.finishReason).toBe("OTHER");
  });
});

describe("normalizedEventsToGeminiFinalResponse — buffered", () => {
  it("assembles a single text part from concatenated deltas", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "hello " },
      { kind: "text_delta", index: 0, text: "world" },
      { kind: "message_stop", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } }
    ];
    const resp = await normalizedEventsToGeminiFinalResponse(fromArray(events), META);
    expect(resp.candidates[0]?.content.parts).toEqual([{ text: "hello world" }]);
    expect(resp.candidates[0]?.finishReason).toBe("STOP");
    expect(resp.candidates[0]?.safetyRatings).toEqual([]);
    expect(resp.usageMetadata?.promptTokenCount).toBe(5);
    expect(resp.usageMetadata?.candidatesTokenCount).toBe(2);
    expect(resp.usageMetadata?.totalTokenCount).toBe(7);
  });

  it("assembles a tool_use as functionCall part with parsed args", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "tool_use_start", index: 0, id: "c1", name: "calc" },
      { kind: "tool_use_delta", index: 0, partialJson: '{"x":1}' },
      { kind: "tool_use_stop", index: 0 },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const resp = await normalizedEventsToGeminiFinalResponse(fromArray(events), META);
    const part = resp.candidates[0]?.content.parts[0];
    expect(part).toEqual({ functionCall: { name: "calc", args: { x: 1 } } });
  });

  it("interleaved text + tool_use preserves arrival order", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "thinking..." },
      { kind: "tool_use_start", index: 1, id: "c1", name: "calc" },
      { kind: "tool_use_delta", index: 1, partialJson: "{}" },
      { kind: "tool_use_stop", index: 1 },
      { kind: "message_stop", stopReason: "tool_use" }
    ];
    const resp = await normalizedEventsToGeminiFinalResponse(fromArray(events), META);
    const parts = resp.candidates[0]?.content.parts ?? [];
    expect(parts.length).toBe(2);
    expect((parts[0] as { text?: string }).text).toBe("thinking...");
    expect((parts[1] as { functionCall?: unknown }).functionCall).toBeDefined();
  });

  it("returns zeroed usageMetadata when source omits usage", async () => {
    const events: NormalizedEvent[] = [
      { kind: "message_start", model: "gemini-pro" },
      { kind: "text_delta", index: 0, text: "hi" },
      { kind: "message_stop", stopReason: "end_turn" }
    ];
    const resp = await normalizedEventsToGeminiFinalResponse(fromArray(events), META);
    expect(resp.usageMetadata).toEqual({
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0
    });
  });

  it("empty event stream returns a valid empty-candidate body", async () => {
    const resp = await normalizedEventsToGeminiFinalResponse(fromArray([]), META);
    expect(resp.candidates).toHaveLength(1);
    expect(resp.candidates[0]?.content.parts).toEqual([]);
    expect(resp.candidates[0]?.finishReason).toBe("OTHER");
  });
});
```

### A.2 `tests/unit/geminiShim/generateContent.test.ts`

The full content follows the Plan-03 `messages.test.ts` pattern: an `interface Recorded { request?: NormalizedRequest }`, a `stubBackend(...)` helper that returns a `Backend` with a parameterized `id`, a `buildApp(...)` helper that wires the registry and mounts the routes via the factory, and a series of `describe` blocks covering auth, validation, routing, non-streaming, streaming, and backend errors. Use Plan 03's file as a structural template — copy the helpers, swap `createMessagesHandler` for `createGenerateContentHandlers`, swap the Anthropic-shaped assertions for Gemini-shaped ones, and add the cross-backend test case that resolves `claude-opus-4-7` to a stub Claude backend.

(See the per-task summary in Task 6 for the test list; the implementer may copy and adapt freely from `tests/unit/anthropicShim/messages.test.ts`.)

### A.3 `tests/unit/geminiShim/files.test.ts`

Follows the Plan-05 `tests/unit/anthropicShim/files.test.ts` structure with Gemini envelope assertions. Use `supertest` with `.attach("file", buffer, {filename, contentType})` for the upload tests. The cross-shim ID acceptance test uploads via the FileStore directly (not via the Anthropic shim endpoint, to keep the test scoped to the Gemini shim handler) and then asserts the Gemini-shim GET succeeds on the `file_<hash>` form.

---
