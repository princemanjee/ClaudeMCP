import { describe, expect, it } from "vitest";
import {
  internalError,
  invalidArgumentError,
  notFoundError,
  ShimRequestError,
  unauthenticatedError
} from "../../../src/geminiShim/errors.js";

describe("Gemini error envelopes", () => {
  it("invalidArgumentError matches Google's documented shape", () => {
    const env = invalidArgumentError("missing contents");
    expect(env).toEqual({
      error: {
        code: 400,
        message: "missing contents",
        status: "INVALID_ARGUMENT"
      }
    });
  });

  it("unauthenticatedError matches Google's documented shape", () => {
    const env = unauthenticatedError("invalid api key");
    expect(env).toEqual({
      error: {
        code: 401,
        message: "invalid api key",
        status: "UNAUTHENTICATED"
      }
    });
  });

  it("notFoundError matches Google's documented shape", () => {
    const env = notFoundError("model not found: foo");
    expect(env).toEqual({
      error: {
        code: 404,
        message: "model not found: foo",
        status: "NOT_FOUND"
      }
    });
  });

  it("internalError matches Google's documented shape", () => {
    const env = internalError("backend crashed");
    expect(env).toEqual({
      error: {
        code: 500,
        message: "backend crashed",
        status: "INTERNAL"
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
