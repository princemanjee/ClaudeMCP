import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileStore } from "../../../src/fileStore.js";
import { geminiRequestToNormalized } from "../../../src/geminiShim/requestTranslator.js";
import { ShimRequestError } from "../../../src/geminiShim/errors.js";
import type { GeminiGenerateContentRequest } from "../../../src/geminiShim/types.js";

let dir: string;
let store: FileStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claudemcp-rt-"));
  store = new FileStore({
    dir,
    ttlMs: 60_000,
    maxTotalBytes: 1_000_000,
    sweepIntervalMs: 0
  });
});

afterEach(() => {
  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("geminiRequestToNormalized — text-only", () => {
  it("translates a single user text part", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hello" }] }]
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.model).toBe("gemini-pro");
    expect(req.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] }
    ]);
  });

  it("maps role 'model' to 'assistant'", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [
        { role: "user", parts: [{ text: "q" }] },
        { role: "model", parts: [{ text: "a" }] }
      ]
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.messages[0]?.role).toBe("user");
    expect(req.messages[1]?.role).toBe("assistant");
  });

  it("defaults role to user when omitted", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [{ parts: [{ text: "hi" }] }]
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.messages[0]?.role).toBe("user");
  });

  it("preserves multi-part content", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [
        {
          role: "user",
          parts: [{ text: "part one" }, { text: "part two" }]
        }
      ]
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.messages[0]?.content).toEqual([
      { type: "text", text: "part one" },
      { type: "text", text: "part two" }
    ]);
  });
});

describe("geminiRequestToNormalized — systemInstruction", () => {
  it("accepts a bare string", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: "be helpful"
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.system).toBe("be helpful");
  });

  it("accepts { parts: [...] } shape", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: { parts: [{ text: "rule one" }] }
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.system).toBe("rule one");
  });

  it("joins multi-part parts with \\n\\n", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: { parts: [{ text: "rule a" }, { text: "rule b" }] }
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.system).toBe("rule a\n\nrule b");
  });

  it("accepts a flat parts array", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: [{ text: "flat" }]
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.system).toBe("flat");
  });
});

describe("geminiRequestToNormalized — inlineData", () => {
  it("maps image/* MIME to image block", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/png", data: "AAAA" } }
          ]
        }
      ]
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.messages[0]?.content[0]).toEqual({
      type: "image",
      mediaType: "image/png",
      data: "AAAA"
    });
  });

  it("maps non-image MIME to document block", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "application/pdf", data: "PDFB" } }
          ]
        }
      ]
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.messages[0]?.content[0]).toEqual({
      type: "document",
      mediaType: "application/pdf",
      data: "PDFB"
    });
  });
});

describe("geminiRequestToNormalized — fileData", () => {
  it("resolves a Gemini-format URI to inline bytes", async () => {
    const meta = await store.upload(Buffer.from("hi"), "h.txt", "text/plain");
    const hash = meta.id.slice("file_".length);
    const body: GeminiGenerateContentRequest = {
      contents: [
        {
          role: "user",
          parts: [
            {
              fileData: {
                mimeType: "text/plain",
                fileUri: `files/${hash}`
              }
            }
          ]
        }
      ]
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    const block = req.messages[0]?.content[0];
    expect(block).toMatchObject({
      type: "document",
      mediaType: "text/plain"
    });
    expect(
      Buffer.from((block as { data: string }).data, "base64").toString("utf8")
    ).toBe("hi");
  });

  it("accepts the Anthropic-format URI (file_<hash>)", async () => {
    const meta = await store.upload(Buffer.from("hi"), "h.txt", "text/plain");
    const body: GeminiGenerateContentRequest = {
      contents: [
        {
          role: "user",
          parts: [
            {
              fileData: {
                mimeType: "text/plain",
                fileUri: meta.id
              }
            }
          ]
        }
      ]
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.messages[0]?.content[0]).toMatchObject({
      type: "document",
      mediaType: "text/plain"
    });
  });

  it("uses mime to pick image vs document", async () => {
    const meta = await store.upload(
      Buffer.from([0x89, 0x50]),
      "img",
      "image/png"
    );
    const body: GeminiGenerateContentRequest = {
      contents: [
        {
          role: "user",
          parts: [
            {
              fileData: {
                mimeType: "image/png",
                fileUri: meta.id
              }
            }
          ]
        }
      ]
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect((req.messages[0]?.content[0] as { type: string }).type).toBe("image");
  });

  it("rejects missing file with 400", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [
        {
          role: "user",
          parts: [
            {
              fileData: {
                mimeType: "image/png",
                fileUri: "files/aaaaaaaaaaaaaaaaaaaaaaaa"
              }
            }
          ]
        }
      ]
    };
    await expect(
      geminiRequestToNormalized(body, "gemini-pro", store)
    ).rejects.toBeInstanceOf(ShimRequestError);
  });
});

describe("geminiRequestToNormalized — function calling", () => {
  it("flattens function declarations across multiple tools", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [
        {
          functionDeclarations: [
            { name: "a", description: "A", parameters: { type: "object" } },
            { name: "b" }
          ]
        },
        {
          functionDeclarations: [{ name: "c", description: "C" }]
        }
      ]
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.tools?.length).toBe(3);
    expect(req.tools?.map((t) => t.name)).toEqual(["a", "b", "c"]);
  });

  it("maps AUTO → 'auto'", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } }
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.toolChoice).toBe("auto");
  });

  it("maps ANY → 'any'", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      toolConfig: { functionCallingConfig: { mode: "ANY" } }
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.toolChoice).toBe("any");
  });

  it("maps NONE → 'none'", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      toolConfig: { functionCallingConfig: { mode: "NONE" } }
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.toolChoice).toBe("none");
  });

  it("maps MODE_UNSPECIFIED → 'auto'", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      toolConfig: { functionCallingConfig: { mode: "MODE_UNSPECIFIED" } }
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.toolChoice).toBe("auto");
  });

  it("absent toolConfig → undefined toolChoice", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }]
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.toolChoice).toBeUndefined();
  });

  it("functionCall → tool_use with synthesized id, functionResponse → tool_result matching id", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [
        {
          role: "model",
          parts: [{ functionCall: { name: "calc", args: { x: 1 } } }]
        },
        {
          role: "function",
          parts: [
            {
              functionResponse: {
                name: "calc",
                response: { result: 2 }
              }
            }
          ]
        }
      ]
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    const tu = req.messages[0]?.content[0] as {
      type: string;
      id: string;
      name: string;
      input: unknown;
    };
    const tr = req.messages[1]?.content[0] as {
      type: string;
      toolUseId: string;
      content: string;
    };
    expect(tu.type).toBe("tool_use");
    expect(tu.name).toBe("calc");
    expect(tu.input).toEqual({ x: 1 });
    expect(tr.type).toBe("tool_result");
    expect(tr.toolUseId).toBe(tu.id);
    expect(JSON.parse(tr.content)).toEqual({ result: 2 });
  });

  it("role 'function' maps to user", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [
        {
          role: "model",
          parts: [{ functionCall: { name: "calc", args: {} } }]
        },
        {
          role: "function",
          parts: [{ functionResponse: { name: "calc", response: {} } }]
        }
      ]
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.messages[1]?.role).toBe("user");
  });
});

describe("geminiRequestToNormalized — generationConfig passthroughs", () => {
  it("forwards sampling params trio", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { temperature: 0.5, topP: 0.9, topK: 40 }
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.samplingParams).toEqual({
      temperature: 0.5,
      topP: 0.9,
      topK: 40
    });
  });

  it("forwards maxOutputTokens to maxTokens", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { maxOutputTokens: 1024 }
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.maxTokens).toBe(1024);
  });

  it("forwards stopSequences", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { stopSequences: ["END"] }
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.stopSequences).toEqual(["END"]);
  });

  it("silently accepts safetySettings", async () => {
    const body: GeminiGenerateContentRequest = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      safetySettings: [{ category: "X", threshold: "Y" }]
    };
    const req = await geminiRequestToNormalized(body, "gemini-pro", store);
    expect(req.model).toBe("gemini-pro");
  });
});

describe("geminiRequestToNormalized — scope rejections", () => {
  async function expect400(body: GeminiGenerateContentRequest): Promise<void> {
    await expect(
      geminiRequestToNormalized(body, "gemini-pro", store)
    ).rejects.toBeInstanceOf(ShimRequestError);
  }

  it("rejects empty contents array", async () => {
    await expect400({ contents: [] });
  });

  it("rejects missing contents", async () => {
    await expect400({} as GeminiGenerateContentRequest);
  });

  it("rejects googleSearchRetrieval", async () => {
    await expect400({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [{ googleSearchRetrieval: {} } as any]
    });
  });

  it("rejects codeExecution", async () => {
    await expect400({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [{ codeExecution: {} } as any]
    });
  });

  it("rejects candidateCount > 1", async () => {
    await expect400({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { candidateCount: 5 }
    });
  });

  it("accepts candidateCount === 1", async () => {
    const req = await geminiRequestToNormalized(
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { candidateCount: 1 }
      },
      "gemini-pro",
      store
    );
    expect(req.model).toBe("gemini-pro");
  });

  it("rejects responseMimeType: application/json", async () => {
    await expect400({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { responseMimeType: "application/json" }
    });
  });

  it("rejects responseSchema", async () => {
    await expect400({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { responseSchema: { type: "object" } }
    });
  });

  it("rejects cachedContent", async () => {
    await expect400({
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      cachedContent: "cache_abc"
    });
  });

  it("rejects unknown part shape", async () => {
    await expect400({
      contents: [{ role: "user", parts: [{ weirdPart: true } as any] }]
    });
  });
});
