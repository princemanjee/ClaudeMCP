/**
 * Plan 13 — Google Generative AI SDK x backend compat tests.
 *
 * Real `@google/generative-ai` SDK pointed at the test server's
 * /v1beta/models/* surface. The Gemini shim dispatches to whichever backend
 * resolves the requested model id; for non-Gemini backends, Plan 07's
 * translators map request/response shapes both ways so the SDK still sees
 * Gemini-typed `GenerateContentResult` etc.
 *
 * Note on package choice: `@google/generative-ai@0.24.1` is used (the package
 * the Gemini shim was built against). Google has since published
 * `@google/genai` as a successor with a different API surface (the legacy
 * package's last release was 2025-04). The new package does NOT match the
 * shim's expected wire envelope, so the legacy package — still on npm and
 * functional — is the right choice for this compat suite. See
 * docs/plan-13-compat-tests-readme.md for full deviation context.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  buildCompatServer,
  COMPAT_MODELS,
  type CompatBackendId,
  type CompatServerHandle
} from "./setup.js";

const BACKENDS: ReadonlyArray<CompatBackendId> = [
  "claude",
  "gemini",
  "lmstudio",
  "ollama"
];

describe.each(BACKENDS)("Google GenerativeAI SDK x %s backend", (backend) => {
  let handle: CompatServerHandle;
  let client: GoogleGenerativeAI;
  const modelId = COMPAT_MODELS[backend].chat;

  beforeAll(async () => {
    handle = await buildCompatServer({ enabledBackends: [backend] });
    client = new GoogleGenerativeAI(handle.apiKey);
  }, 30000);

  afterAll(async () => {
    if (handle) await handle.teardown();
  });

  // ---- getGenerativeModel + generateContent --------------------------------

  it("getModel + generateContent returns a GenerateContentResult", async () => {
    const model = client.getGenerativeModel(
      { model: modelId },
      { baseUrl: handle.baseURL }
    );

    const result = await model.generateContent("compat google-sdk ping");
    expect(result.response).toBeDefined();
    expect(typeof result.response.text()).toBe("string");
    expect(result.response.text().length).toBeGreaterThan(0);

    const candidates = result.response.candidates;
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates!.length).toBeGreaterThan(0);

    const first = candidates![0]!;
    expect(first.content).toBeDefined();
    expect(Array.isArray(first.content.parts)).toBe(true);
    expect(first.content.parts.length).toBeGreaterThan(0);

    // usageMetadata: optional per the shim's translation, but when present
    // assert shape correctness.
    const usage = result.response.usageMetadata;
    if (usage) {
      expect(typeof usage.promptTokenCount).toBe("number");
      expect(typeof usage.candidatesTokenCount).toBe("number");
    }
  }, 30000);

  // ---- generateContentStream ----------------------------------------------

  it("generateContentStream yields chunks then a resolved response", async () => {
    const model = client.getGenerativeModel(
      { model: modelId },
      { baseUrl: handle.baseURL }
    );

    const result = await model.generateContentStream(
      "compat google-sdk stream ping"
    );

    const chunks: string[] = [];
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text.length > 0) chunks.push(text);
    }

    expect(chunks.length).toBeGreaterThan(0);

    const final = await result.response;
    expect(final.candidates).toBeDefined();
    expect(final.candidates!.length).toBeGreaterThan(0);
    expect(final.text().length).toBeGreaterThan(0);
  }, 30000);

  // ---- countTokens --------------------------------------------------------
  // The Google SDK's model.countTokens(...) wraps the request as
  // {generateContentRequest: {contents: [...]}}. The Gemini shim now unwraps
  // that envelope so the bare {contents} translator path applies (the same
  // bare shape that direct curl callers use is also still accepted).

  it("countTokens returns {totalTokens} for the SDK's wrapped envelope", async () => {
    const model = client.getGenerativeModel(
      { model: modelId },
      { baseUrl: handle.baseURL }
    );
    const result = await model.countTokens("count these tokens please");
    expect(typeof result.totalTokens).toBe("number");
    expect(result.totalTokens).toBeGreaterThan(0);
  }, 30000);

  // ---- files lifecycle ----------------------------------------------------
  // The Google SDK's GoogleAIFileManager.uploadFile posts a one-shot
  // `multipart/related` body to `/upload/v1beta/files`. The shim now mounts
  // that alias and accepts the SDK's multipart shape (the simpler curl-style
  // `multipart/form-data` POST to `/v1beta/files` continues to work).

  it("files.uploadFile via the SDK round-trips through /upload/v1beta/files", async () => {
    const { GoogleAIFileManager } = await import(
      "@google/generative-ai/server"
    );
    const fm = new GoogleAIFileManager(handle.apiKey, {
      baseUrl: handle.baseURL
    });
    const buf = Buffer.from("compat google-sdk upload bytes");
    const uploaded = await fm.uploadFile(buf, {
      mimeType: "text/plain",
      displayName: "compat-upload.txt"
    });
    expect(uploaded.file?.name?.startsWith("files/")).toBe(true);
    expect(uploaded.file?.mimeType).toBe("text/plain");
    // Cleanup so other backend iterations start from a clean store.
    if (uploaded.file?.name) {
      try {
        await fm.deleteFile(uploaded.file.name);
      } catch {
        /* best effort */
      }
    }
  }, 30000);
});
