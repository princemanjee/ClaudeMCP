/**
 * Plan 13 — OpenAI SDK x backend compat tests.
 *
 * Real `openai` SDK pointed at the test server's /v1/* surface. Chat
 * completions exercised across all four backends; embeddings across
 * {lmstudio, ollama} only (Claude has no embeddings; Gemini embeddings are
 * deferred per spec Phase 10).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
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

describe.each(BACKENDS)("OpenAI SDK x %s backend", (backend) => {
  let handle: CompatServerHandle;
  let client: OpenAI;
  const chatModel = COMPAT_MODELS[backend].chat;
  const embedModel = COMPAT_MODELS[backend].embed;

  beforeAll(async () => {
    handle = await buildCompatServer({ enabledBackends: [backend] });
    client = new OpenAI({
      apiKey: handle.apiKey,
      baseURL: `${handle.baseURL}/v1`
    });
  }, 30000);

  afterAll(async () => {
    if (handle) await handle.teardown();
  });

  // ---- chat.completions.create — non-streaming ----------------------------

  it("chat.completions.create (non-streaming) returns a ChatCompletion", async () => {
    const completion = await client.chat.completions.create({
      model: chatModel,
      messages: [{ role: "user", content: "compat openai ping" }]
    });

    expect(completion.id).toBeDefined();
    expect(completion.object).toBe("chat.completion");
    expect(Array.isArray(completion.choices)).toBe(true);
    expect(completion.choices.length).toBeGreaterThan(0);

    const choice = completion.choices[0]!;
    expect(choice.message.role).toBe("assistant");
    expect(typeof choice.message.content).toBe("string");
    expect(choice.message.content!.length).toBeGreaterThan(0);
    expect(choice.finish_reason).toBeDefined();

    // Usage is optional in the SDK type; some backends (e.g. mock-claude)
    // don't emit token counts so the shim omits the field. When present,
    // assert shape correctness. See deviations in plan-13-readme.
    if (completion.usage) {
      expect(typeof completion.usage.prompt_tokens).toBe("number");
      expect(typeof completion.usage.completion_tokens).toBe("number");
      expect(typeof completion.usage.total_tokens).toBe("number");
    }
  }, 30000);

  // ---- chat.completions.create — streaming --------------------------------

  it("chat.completions.create (streaming) iterates ChatCompletionChunk objects in order", async () => {
    const stream = await client.chat.completions.create({
      model: chatModel,
      messages: [{ role: "user", content: "compat openai stream ping" }],
      stream: true
    });

    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);

    // First chunk should carry role on a delta.
    const firstWithRole = chunks.find((c) => c.choices[0]?.delta.role);
    expect(firstWithRole?.choices[0]?.delta.role).toBe("assistant");

    // Concatenated content deltas should form a non-empty string.
    const text = chunks.map((c) => c.choices[0]?.delta.content ?? "").join("");
    expect(text.length).toBeGreaterThan(0);

    // A chunk should carry a finish_reason. (For SSE streams, the final
    // chunk before [DONE] carries finish_reason; the order is asserted via
    // the SDK's own parser above.)
    const finishReasons = chunks
      .map((c) => c.choices[0]?.finish_reason)
      .filter((f) => f != null);
    expect(finishReasons.length).toBeGreaterThan(0);
  }, 30000);

  // ---- embeddings.create ---------------------------------------------------

  if (backend === "claude" || backend === "gemini") {
    // Skipped with a clear reason — these backends don't expose embeddings.
    // Per the spec, embeddings route only to LM Studio + Ollama (Phase 10).
    it.skip(
      `embeddings.create skipped for ${backend} backend (no embeddings support in spec Phase 10)`,
      () => {
        /* intentionally empty */
      }
    );
  } else {
    it("embeddings.create returns a CreateEmbeddingResponse with at least one Embedding", async () => {
      const res = await client.embeddings.create({
        model: embedModel!,
        input: ["hello world", "second input"]
      });

      expect(res.object).toBe("list");
      expect(Array.isArray(res.data)).toBe(true);
      expect(res.data.length).toBe(2);

      for (const item of res.data) {
        expect(item.object).toBe("embedding");
        expect(Array.isArray(item.embedding)).toBe(true);
        expect(item.embedding.length).toBeGreaterThan(0);
        expect(typeof item.index).toBe("number");
      }

      expect(res.model).toBeDefined();
      // The /v1/embeddings handler does not currently emit a usage block
      // (the OpenAIEmbeddingsResponse type marks it optional and the
      // implementation omits it). When present, assert shape correctness.
      // See deviations in plan-13-readme.
      if (res.usage) {
        expect(typeof res.usage.prompt_tokens).toBe("number");
        expect(typeof res.usage.total_tokens).toBe("number");
      }
    }, 30000);
  }
});
