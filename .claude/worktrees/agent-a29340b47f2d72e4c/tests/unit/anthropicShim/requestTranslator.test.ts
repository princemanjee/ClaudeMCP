import { describe, expect, it } from "vitest";
import { anthropicRequestToNormalized } from "../../../src/anthropicShim/requestTranslator.js";
import { ShimRequestError } from "../../../src/anthropicShim/errors.js";

describe("anthropicRequestToNormalized — happy paths", () => {
  it("translates the simplest text-only request", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }]
    });
    expect(out).toEqual({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] }
      ]
    });
  });

  it("preserves multi-block text content", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" }
          ]
        }
      ]
    });
    expect(out.messages[0]?.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" }
    ]);
  });

  it("string system prompt becomes NormalizedRequest.system as-is", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      system: "you are helpful",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(out.system).toBe("you are helpful");
  });

  it("array system prompt is joined with double newline", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      system: [
        { type: "text", text: "be concise" },
        { type: "text", text: "be polite" }
      ],
      messages: [{ role: "user", content: "hi" }]
    });
    expect(out.system).toBe("be concise\n\nbe polite");
  });

  it("forwards max_tokens", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: "hi" }]
    });
    expect(out.maxTokens).toBe(4096);
  });

  it("forwards sampling params (claudeBackend will ignore — that's fine)", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      messages: [{ role: "user", content: "hi" }]
    });
    expect(out.samplingParams).toEqual({
      temperature: 0.7,
      topP: 0.9,
      topK: 40
    });
  });

  it("forwards metadata", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      metadata: { user_id: "u_42" },
      messages: [{ role: "user", content: "hi" }]
    });
    expect(out.metadata).toEqual({ user_id: "u_42" });
  });

  it("preserves message ordering across roles", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" }
      ]
    });
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("anthropicRequestToNormalized — required-field validation", () => {
  it("throws 400 when model is missing", () => {
    expect(() =>
      anthropicRequestToNormalized({
        // @ts-expect-error — testing runtime validation
        messages: [{ role: "user", content: "hi" }]
      })
    ).toThrow(ShimRequestError);
  });

  it("throws 400 when messages is missing", () => {
    expect(() =>
      anthropicRequestToNormalized({
        model: "claude-sonnet-4-6"
        // messages omitted
      } as never)
    ).toThrow(/messages/i);
  });

  it("throws 400 when messages is empty", () => {
    expect(() =>
      anthropicRequestToNormalized({
        model: "claude-sonnet-4-6",
        messages: []
      })
    ).toThrow(/at least one message/i);
  });

  it("throws 400 when a message has an unsupported role", () => {
    expect(() =>
      anthropicRequestToNormalized({
        model: "claude-sonnet-4-6",
        messages: [
          // @ts-expect-error — testing runtime validation
          { role: "system", content: "no" }
        ]
      })
    ).toThrow(/role/i);
  });

  it("throws 400 when a content block has an unknown type", () => {
    expect(() =>
      anthropicRequestToNormalized({
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            // @ts-expect-error — testing runtime validation
            content: [{ type: "neon-pixel-art", text: "?" }]
          }
        ]
      })
    ).toThrow(/unknown.*type/i);
  });
});

describe("anthropicRequestToNormalized — Plan 03 scope rejections", () => {
  function assertRejected(body: unknown, pattern: RegExp): void {
    let caught: unknown;
    try {
      anthropicRequestToNormalized(body as never);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ShimRequestError);
    expect((caught as ShimRequestError).status).toBe(400);
    expect((caught as ShimRequestError).message).toMatch(pattern);
  }

  it("rejects thinking field", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled", budget_tokens: 1024 }
      },
      /thinking/i
    );
  });

  it("rejects cache_control on a content block", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "hi",
                cache_control: { type: "ephemeral" }
              } as unknown as { type: "text"; text: string }
            ]
          }
        ]
      },
      /cache_control/i
    );
  });

  it("accepts empty stop_sequences array (treated as not supplied)", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      stop_sequences: []
    });
    expect(out.stopSequences).toBeUndefined();
  });

  it("accepts empty tools array (treated as not supplied)", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tools: []
    });
    expect(out.tools).toBeUndefined();
  });
});

describe("anthropicRequestToNormalized — Plan 04 passthroughs", () => {
  it("translates an image content block with base64 source", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAAAA" }
            }
          ]
        }
      ]
    });
    expect(out.messages[0]?.content).toEqual([
      { type: "text", text: "describe" },
      { type: "image", mediaType: "image/png", data: "AAAAAA" }
    ]);
  });

  it("translates a document content block with base64 source", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" }
            }
          ]
        }
      ]
    });
    expect(out.messages[0]?.content).toEqual([
      { type: "document", mediaType: "application/pdf", data: "JVBERi0=" }
    ]);
  });

  it("rejects image source.type 'url' (lands in Plan 05 — fetch + inline)", () => {
    expect(() =>
      anthropicRequestToNormalized({
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [{ type: "image", source: { type: "url", url: "https://example.com/x.png" } }]
          }
        ]
      })
    ).toThrow(/url|source/i);
  });

  it("rejects image source.type 'file' (file_<hash> resolution lands in Plan 05)", () => {
    expect(() =>
      anthropicRequestToNormalized({
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [{ type: "image", source: { type: "file", file_id: "file_abc" } }]
          }
        ]
      })
    ).toThrow(/file|source/i);
  });

  it("translates a tool_use content block in an assistant message", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "compute" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "calc", input: { x: 1, y: 2 } }
          ]
        }
      ]
    });
    expect(out.messages[1]?.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "calc", input: { x: 1, y: 2 } }
    ]);
  });

  it("translates a tool_result with string content shorthand", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "3" }]
        }
      ]
    });
    expect(out.messages[0]?.content).toEqual([
      { type: "tool_result", toolUseId: "toolu_1", content: "3" }
    ]);
  });

  it("translates a tool_result with content-block array (joins text)", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "text", text: "result" },
                { type: "text", text: ": 3" }
              ]
            }
          ]
        }
      ]
    });
    expect(out.messages[0]?.content).toEqual([
      { type: "tool_result", toolUseId: "toolu_1", content: "result\n: 3" }
    ]);
  });

  it("translates the tools array", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "calculator",
          description: "Adds two numbers",
          input_schema: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" } }
          }
        }
      ]
    });
    expect(out.tools).toEqual([
      {
        name: "calculator",
        description: "Adds two numbers",
        inputSchema: {
          type: "object",
          properties: { x: { type: "number" }, y: { type: "number" } }
        }
      }
    ]);
  });

  it("translates tool_choice 'auto' / 'any' / 'none' / named", () => {
    const auto = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "auto" }
    });
    expect(auto.toolChoice).toBe("auto");
    const any = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "any" }
    });
    expect(any.toolChoice).toBe("any");
    const none = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "none" }
    });
    expect(none.toolChoice).toBe("none");
    const named = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "tool", name: "calc" }
    });
    expect(named.toolChoice).toEqual({ type: "tool", name: "calc" });
  });

  it("translates stop_sequences", () => {
    const out = anthropicRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      stop_sequences: ["STOP", "END"]
    });
    expect(out.stopSequences).toEqual(["STOP", "END"]);
  });
});
