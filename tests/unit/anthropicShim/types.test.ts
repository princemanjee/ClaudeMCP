import { describe, expect, it } from "vitest";
import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicDocumentBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicToolDef,
  AnthropicToolChoice,
  AnthropicResponseContentBlock
} from "../../../src/anthropicShim/types.js";

describe("AnthropicContentBlock union — Plan 04 typed variants", () => {
  it("admits a typed image block with base64 source", () => {
    const block: AnthropicImageBlock = {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "iVBORw0KGgo="
      }
    };
    const widened: AnthropicContentBlock = block;
    expect(widened.type).toBe("image");
  });

  it("admits a typed document block with base64 source", () => {
    const block: AnthropicDocumentBlock = {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "JVBERi0="
      }
    };
    const widened: AnthropicContentBlock = block;
    expect(widened.type).toBe("document");
  });

  it("admits a typed tool_use block with id, name, input", () => {
    const block: AnthropicToolUseBlock = {
      type: "tool_use",
      id: "toolu_01ABC",
      name: "calculator",
      input: { x: 1, y: 2 }
    };
    const widened: AnthropicContentBlock = block;
    expect(widened.type === "tool_use" ? widened.id : "").toBe("toolu_01ABC");
  });

  it("admits a typed tool_result block with string content shorthand", () => {
    const block: AnthropicToolResultBlock = {
      type: "tool_result",
      tool_use_id: "toolu_01ABC",
      content: "3"
    };
    const widened: AnthropicContentBlock = block;
    expect(widened.type === "tool_result" ? widened.tool_use_id : "").toBe("toolu_01ABC");
  });

  it("admits a typed tool_result block with content-block array", () => {
    const block: AnthropicToolResultBlock = {
      type: "tool_result",
      tool_use_id: "toolu_01ABC",
      content: [{ type: "text", text: "the answer is 3" }]
    };
    expect(Array.isArray(block.content)).toBe(true);
  });

  it("constructs AnthropicToolDef with description + input_schema", () => {
    const def: AnthropicToolDef = {
      name: "calculator",
      description: "Adds two numbers",
      input_schema: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"]
      }
    };
    expect(def.name).toBe("calculator");
  });

  it("constructs every AnthropicToolChoice variant", () => {
    const auto: AnthropicToolChoice = { type: "auto" };
    const any: AnthropicToolChoice = { type: "any" };
    const none: AnthropicToolChoice = { type: "none" };
    const named: AnthropicToolChoice = { type: "tool", name: "calculator" };
    expect([auto, any, none, named]).toHaveLength(4);
  });

  it("AnthropicResponseContentBlock includes tool_use", () => {
    const responseBlock: AnthropicResponseContentBlock = {
      type: "tool_use",
      id: "toolu_01",
      name: "calc",
      input: { x: 1 }
    };
    expect(responseBlock.type).toBe("tool_use");
  });
});
