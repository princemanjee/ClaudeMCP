import { describe, expect, it } from "vitest";
import { openaiRequestToNormalized } from "../../../src/openaiShim/requestTranslator.js";
import {
  SYSTEM_FORMAT_RULES,
  SYSTEM_PRELUDE
} from "../../../src/openaiShim/promptBuilder.js";
import { ShimRequestError } from "../../../src/openaiShim/errors.js";

function userText(req: ReturnType<typeof openaiRequestToNormalized>): string {
  const first = req.messages[0];
  if (!first) throw new Error("expected at least one message");
  const block = first.content[0];
  if (!block || block.type !== "text") throw new Error("expected text block");
  return block.text;
}

describe("openaiRequestToNormalized — happy paths", () => {
  it("translates the simplest text-only request into the legacy envelope", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }]
    });
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]?.role).toBe("user");
    const body = userText(req);
    expect(body).toContain("<user>hello</user>");
    expect(body.endsWith("Produce your next response.")).toBe(true);
  });

  it("system prompt starts with SYSTEM_PRELUDE and ends with SYSTEM_FORMAT_RULES", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }]
    });
    expect(req.system).toBeDefined();
    expect(req.system?.startsWith(SYSTEM_PRELUDE)).toBe(true);
    expect(req.system?.endsWith(SYSTEM_FORMAT_RULES)).toBe(true);
  });

  it("caller's system message is wrapped in [Caller's system message] block", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "you are a pirate" },
        { role: "user", content: "hi" }
      ]
    });
    expect(req.system).toContain(
      "[Caller's system message]:\n<<<\nyou are a pirate\n>>>"
    );
  });

  it("tools array is rendered into the system prompt as AVAILABLE TOOLS block", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "calc",
            description: "do math",
            parameters: { type: "object", properties: { x: { type: "number" } } }
          }
        }
      ]
    });
    expect(req.system).toContain("AVAILABLE TOOLS:");
    expect(req.system).toContain("- name: calc");
    expect(req.system).toContain("description: do math");
    expect(req.system).toContain("parameters (JSON Schema):");
  });

  it("empty tools array renders 'AVAILABLE TOOLS: (none)'", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      tools: []
    });
    expect(req.system).toContain("AVAILABLE TOOLS: (none)");
  });

  it("assistant tool_calls are re-inlined as <assistant_tool_use><tool_use>...", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "what's the weather" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "weather", arguments: '{"city":"Paris"}' }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "sunny, 22C"
        }
      ]
    });
    const body = userText(req);
    expect(body).toContain("<assistant_tool_use>");
    expect(body).toContain(
      '<tool_use>{"name":"weather","arguments":{"city":"Paris"}}</tool_use>'
    );
    expect(body).toContain("</assistant_tool_use>");
    expect(body).toContain('<tool_result id="call_1">sunny, 22C</tool_result>');
  });

  it("legacy role:function is mapped to tool_result using name when id absent", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "do it" },
        { role: "function", name: "calc", content: "42" }
      ]
    });
    const body = userText(req);
    expect(body).toContain('<tool_result id="calc">42</tool_result>');
  });

  it("content array of text parts is concatenated", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "first " },
            { type: "text", text: "second" }
          ]
        }
      ]
    });
    const body = userText(req);
    expect(body).toContain("<user>first second</user>");
  });

  it("forwards max_tokens", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100
    });
    expect(req.maxTokens).toBe(100);
  });

  it("max_completion_tokens wins over max_tokens", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
      max_completion_tokens: 200
    });
    expect(req.maxTokens).toBe(200);
  });

  it("forwards temperature and top_p as samplingParams", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      top_p: 0.9
    });
    expect(req.samplingParams?.temperature).toBe(0.7);
    expect(req.samplingParams?.topP).toBe(0.9);
  });

  it("forwards presence_penalty and frequency_penalty via metadata", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      presence_penalty: 0.5,
      frequency_penalty: 0.1
    });
    expect(req.metadata?.["presence_penalty"]).toBe(0.5);
    expect(req.metadata?.["frequency_penalty"]).toBe(0.1);
  });

  it("forwards user via metadata", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      user: "user-123"
    });
    expect(req.metadata?.["user"]).toBe("user-123");
  });

  it("normalizes stop as string to single-element array", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      stop: "STOP"
    });
    expect(req.stopSequences).toEqual(["STOP"]);
  });

  it("normalizes stop as array verbatim", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      stop: ["A", "B"]
    });
    expect(req.stopSequences).toEqual(["A", "B"]);
  });

  it("empty stop string is treated as not supplied", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      stop: ""
    });
    expect(req.stopSequences).toBeUndefined();
  });

  it("model omitted falls back to claude-code-cli sentinel (back-compat)", () => {
    const req = openaiRequestToNormalized({
      messages: [{ role: "user", content: "hi" }]
    });
    expect(req.model).toBe("claude-code-cli");
  });

  it("messages array preserves single-user-message shape with full conversation in body", () => {
    const req = openaiRequestToNormalized({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" }
      ]
    });
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]?.role).toBe("user");
    const body = userText(req);
    expect(body).toContain("<user>hi</user>");
    expect(body).toContain("<assistant>hello</assistant>");
    expect(body).toContain("<user>again</user>");
  });
});

describe("openaiRequestToNormalized — required-field validation", () => {
  it("throws 400 when body is not an object", () => {
    expect(() => openaiRequestToNormalized(null as unknown)).toThrow(
      ShimRequestError
    );
  });

  it("throws 400 when messages is missing", () => {
    try {
      openaiRequestToNormalized({ model: "x" });
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ShimRequestError);
      expect((e as ShimRequestError).status).toBe(400);
    }
  });

  it("throws 400 when messages is empty", () => {
    expect(() =>
      openaiRequestToNormalized({ model: "x", messages: [] })
    ).toThrow(ShimRequestError);
  });

  it("throws 400 when a message has an unsupported role", () => {
    expect(() =>
      openaiRequestToNormalized({
        model: "x",
        messages: [{ role: "developer", content: "hi" }]
      })
    ).toThrow(ShimRequestError);
  });

  it("throws 400 when content is null on a user turn", () => {
    expect(() =>
      openaiRequestToNormalized({
        model: "x",
        messages: [{ role: "user", content: null }]
      })
    ).toThrow(ShimRequestError);
  });

  it("accepts null content on an assistant turn when tool_calls is set", () => {
    expect(() =>
      openaiRequestToNormalized({
        model: "x",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "weather", arguments: "{}" }
              }
            ]
          }
        ]
      })
    ).not.toThrow();
  });
});

describe("openaiRequestToNormalized — Plan 10 scope rejections", () => {
  it("rejects image_url content parts", () => {
    expect(() =>
      openaiRequestToNormalized({
        model: "x",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe" },
              { type: "image_url", image_url: { url: "data:image/png;base64,X" } }
            ]
          }
        ]
      })
    ).toThrow(ShimRequestError);
  });

  it("rejects n > 1", () => {
    expect(() =>
      openaiRequestToNormalized({
        model: "x",
        n: 2,
        messages: [{ role: "user", content: "hi" }]
      })
    ).toThrow(ShimRequestError);
  });

  it("rejects response_format (json_object / json_schema)", () => {
    expect(() =>
      openaiRequestToNormalized({
        model: "x",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: "hi" }]
      })
    ).toThrow(ShimRequestError);
  });

  it("accepts n: 1 (single candidate)", () => {
    expect(() =>
      openaiRequestToNormalized({
        model: "x",
        n: 1,
        messages: [{ role: "user", content: "hi" }]
      })
    ).not.toThrow();
  });
});

describe("openaiRequestToNormalized — NormalizedRequest.tools is NEVER set", () => {
  it("does not populate NormalizedRequest.tools or toolChoice even with tools[] in the request", () => {
    const req = openaiRequestToNormalized({
      model: "x",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: { name: "calc", parameters: {} }
        }
      ],
      tool_choice: "auto"
    });
    expect(req.tools).toBeUndefined();
    expect(req.toolChoice).toBeUndefined();
  });
});
