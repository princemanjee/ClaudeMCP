import { describe, expect, it } from "vitest";
import {
  authenticationError,
  internalServerError,
  invalidRequestError,
  notFoundError,
  permissionDeniedError,
  ShimRequestError
} from "../../../src/openaiShim/errors.js";

describe("OpenAI error envelopes", () => {
  it("invalidRequestError matches OpenAI's documented shape", () => {
    const env = invalidRequestError("missing model field");
    expect(env).toEqual({
      error: {
        message: "missing model field",
        type: "invalid_request_error",
        param: null,
        code: null
      }
    });
  });

  it("invalidRequestError accepts a param + code", () => {
    const env = invalidRequestError("expected string", {
      param: "messages[0].content",
      code: "bad_type"
    });
    expect(env.error.param).toBe("messages[0].content");
    expect(env.error.code).toBe("bad_type");
  });

  it("authenticationError matches OpenAI's documented shape", () => {
    const env = authenticationError("Invalid API key.");
    expect(env).toEqual({
      error: {
        message: "Invalid API key.",
        type: "authentication_error",
        param: null,
        code: "invalid_api_key"
      }
    });
  });

  it("notFoundError matches OpenAI's documented shape", () => {
    const env = notFoundError("The model `nope` does not exist.");
    expect(env).toEqual({
      error: {
        message: "The model `nope` does not exist.",
        type: "not_found_error",
        param: null,
        code: "model_not_found"
      }
    });
  });

  it("permissionDeniedError matches OpenAI's documented shape", () => {
    const env = permissionDeniedError("backend disabled");
    expect(env.error.type).toBe("permission_denied_error");
    expect(env.error.message).toBe("backend disabled");
  });

  it("internalServerError matches OpenAI's documented shape", () => {
    const env = internalServerError("backend crashed");
    expect(env).toEqual({
      error: {
        message: "backend crashed",
        type: "api_error",
        param: null,
        code: null
      }
    });
  });

  it("ShimRequestError carries status, message, and optional param/code", () => {
    const err = new ShimRequestError(400, "bad role", {
      param: "messages[0].role",
      code: "invalid_role"
    });
    expect(err.status).toBe(400);
    expect(err.message).toBe("bad role");
    expect(err.param).toBe("messages[0].role");
    expect(err.code).toBe("invalid_role");
    expect(err).toBeInstanceOf(Error);
  });

  it("ShimRequestError with no opts has undefined param/code", () => {
    const err = new ShimRequestError(400, "bad");
    expect(err.param).toBeUndefined();
    expect(err.code).toBeUndefined();
  });
});
