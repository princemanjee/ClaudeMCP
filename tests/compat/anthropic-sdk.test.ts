/**
 * Plan 13 — Anthropic SDK × backend compat tests.
 *
 * Real `@anthropic-ai/sdk` client instantiated against the test server,
 * parameterized over all four backends via describe.each. The SDK's own
 * parsers fail loud on any envelope drift; the assertions below are shape
 * sanity checks rather than behavior coverage.
 *
 * Note on `models.list`: the server's canonical /v1/models endpoint returns
 * OpenAI-shape (per src/server.ts header comment). The Anthropic-shape route
 * lives at /v1/anthropic/models. The Anthropic SDK has no per-call baseURL
 * override that cleanly rewrites just one resource's path, so we exercise
 * the Anthropic-shape models surface via raw fetch instead of through the
 * SDK. (See docs/plan-13-compat-tests-readme.md "Deviations" for context.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
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

describe.each(BACKENDS)("Anthropic SDK x %s backend", (backend) => {
  let handle: CompatServerHandle;
  let client: Anthropic;
  const model = COMPAT_MODELS[backend].chat;

  beforeAll(async () => {
    handle = await buildCompatServer({ enabledBackends: [backend] });
    client = new Anthropic({
      apiKey: handle.apiKey,
      baseURL: handle.baseURL
    });
  }, 30000);

  afterAll(async () => {
    if (handle) await handle.teardown();
  });

  // ---- messages.create — non-streaming ------------------------------------

  it("messages.create (non-streaming) returns a Message with a content array", async () => {
    const msg = await client.messages.create({
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: "compat ping" }]
    });

    expect(msg.id).toBeDefined();
    expect(msg.type).toBe("message");
    expect(msg.role).toBe("assistant");
    expect(Array.isArray(msg.content)).toBe(true);
    expect(msg.content.length).toBeGreaterThan(0);

    const first = msg.content[0]!;
    expect(first.type).toBe("text");
    if (first.type === "text") {
      expect(typeof first.text).toBe("string");
      expect(first.text.length).toBeGreaterThan(0);
    }
    expect(msg.model).toBeDefined();
    expect(msg.stop_reason).toBeDefined();
    expect(msg.usage).toBeDefined();
    expect(typeof msg.usage.input_tokens).toBe("number");
    expect(typeof msg.usage.output_tokens).toBe("number");
  }, 30000);

  // ---- messages.stream (helper-method API) --------------------------------

  it("messages.stream produces SDK-typed events and resolves a final Message", async () => {
    const stream = client.messages.stream({
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: "compat stream ping" }]
    });

    const seen: string[] = [];
    stream.on("text", () => seen.push("text"));
    stream.on("message", () => seen.push("message"));

    const finalMsg = await stream.finalMessage();
    expect(finalMsg.content.length).toBeGreaterThan(0);
    expect(finalMsg.stop_reason).toBeDefined();
    // At minimum one "text" event and one terminal "message" event.
    expect(seen).toContain("text");
    expect(seen).toContain("message");
  }, 30000);

  // ---- messages.create({stream:true}) — raw event iterator ----------------

  it("messages.create (streaming, raw event iterator) emits start -> delta -> stop in order", async () => {
    const stream = await client.messages.create({
      model,
      max_tokens: 256,
      stream: true,
      messages: [{ role: "user", content: "compat raw stream ping" }]
    });

    const kinds: string[] = [];
    for await (const event of stream) {
      kinds.push(event.type);
    }

    // SDK enforces the event-type sequence:
    //   message_start, (content_block_start, content_block_delta+, content_block_stop)+,
    //   message_delta, message_stop
    expect(kinds[0]).toBe("message_start");
    expect(kinds[kinds.length - 1]).toBe("message_stop");
    expect(kinds).toContain("content_block_start");
    expect(kinds).toContain("content_block_delta");
    expect(kinds).toContain("content_block_stop");
  }, 30000);

  // ---- messages.countTokens ------------------------------------------------

  it("messages.countTokens returns a positive input_tokens", async () => {
    const res = await client.messages.countTokens({
      model,
      messages: [{ role: "user", content: "count me please" }]
    });
    expect(res.input_tokens).toBeGreaterThan(0);
    expect(typeof res.input_tokens).toBe("number");
  }, 30000);

  // ---- Anthropic-shape models list (via raw fetch, not SDK) ---------------

  it("/v1/anthropic/models returns a paginated list of Anthropic-shape Model entries", async () => {
    const res = await fetch(`${handle.baseURL}/v1/anthropic/models?limit=20`, {
      headers: { "x-api-key": handle.apiKey }
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      data: Array<{ id: string; type: string; display_name: string; created_at: string }>;
    };
    expect(Array.isArray(page.data)).toBe(true);
    expect(page.data.length).toBeGreaterThan(0);
    const m = page.data[0]!;
    expect(m.type).toBe("model");
    expect(typeof m.id).toBe("string");
    expect(typeof m.display_name).toBe("string");
    expect(typeof m.created_at).toBe("string");
  }, 30000);

  // ---- files lifecycle (Anthropic SDK beta.files) -------------------------
  // The Anthropic SDK 0.96 exposes the files API under `client.beta.files.*`.

  it("beta.files.* lifecycle round-trips through the SDK", async () => {
    const fileContent = Buffer.from("compat test file contents", "utf-8");

    const uploaded = await client.beta.files.upload({
      file: await toFile(fileContent, "compat-test.txt", { type: "text/plain" })
    });
    expect(uploaded.id).toMatch(/^file_/);
    expect(uploaded.type).toBe("file");
    expect(uploaded.filename).toBe("compat-test.txt");

    // list — uploaded file should appear.
    const list = await client.beta.files.list({ limit: 100 });
    const found = list.data.find((f) => f.id === uploaded.id);
    expect(found).toBeDefined();
    expect(found?.filename).toBe("compat-test.txt");

    // retrieveMetadata by id.
    const retrieved = await client.beta.files.retrieveMetadata(uploaded.id);
    expect(retrieved.id).toBe(uploaded.id);
    expect(retrieved.filename).toBe("compat-test.txt");

    // delete — returns DeletedFile.
    const deleted = await client.beta.files.delete(uploaded.id);
    expect(deleted.id).toBe(uploaded.id);
    expect(deleted.type).toBe("file_deleted");

    // After delete, retrieveMetadata should reject.
    await expect(client.beta.files.retrieveMetadata(uploaded.id)).rejects.toThrow();
  }, 30000);
});
