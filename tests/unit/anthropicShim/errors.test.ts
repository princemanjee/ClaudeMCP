import { describe, expect, it } from "vitest";
import {
  authenticationError,
  internalServerError,
  invalidRequestError,
  notFoundError,
  ShimRequestError
} from "../../../src/anthropicShim/errors.js";

describe("Anthropic error envelopes", () => {
  it("invalidRequestError matches Anthropic's documented shape", () => {
    const env = invalidRequestError("missing model field");
    expect(env).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "missing model field"
      }
    });
  });

  it("authenticationError matches Anthropic's documented shape", () => {
    const env = authenticationError("invalid x-api-key");
    expect(env).toEqual({
      type: "error",
      error: {
        type: "authentication_error",
        message: "invalid x-api-key"
      }
    });
  });

  it("notFoundError matches Anthropic's documented shape", () => {
    const env = notFoundError("model not_a_real_model not found");
    expect(env).toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message: "model not_a_real_model not found"
      }
    });
  });

  it("internalServerError matches Anthropic's documented shape", () => {
    const env = internalServerError("backend crashed");
    expect(env).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "backend crashed"
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
