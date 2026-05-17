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
    expect(parseModelMethodPath("weird:model:generateContent")).toEqual({
      model: "weird:model",
      method: "generateContent"
    });
  });
});
