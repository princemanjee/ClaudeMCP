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

  it("rejects image content blocks", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "X" } }
            ]
          }
        ]
      },
      /image|multimodal/i
    );
  });

  it("rejects document content blocks", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "X" } }]
          }
        ]
      },
      /document|multimodal/i
    );
  });

  it("rejects tool_use content blocks in the request", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "calc", input: {} }]
          }
        ]
      },
      /tool/i
    );
  });

  it("rejects tool_result content blocks in the request", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]
          }
        ]
      },
      /tool/i
    );
  });

  it("rejects non-empty tools field", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "calc", input_schema: {} }]
      },
      /tool/i
    );
  });

  it("rejects tool_choice field when present", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: { type: "auto" }
      },
      /tool_choice/i
    );
  });

  it("rejects non-empty stop_sequences", () => {
    assertRejected(
      {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        stop_sequences: ["STOP"]
      },
      /stop_sequences/i
    );
  });

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
