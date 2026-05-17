export interface GeminiErrorEnvelope {
  error: {
    code: number;
    message: string;
    status:
      | "INVALID_ARGUMENT"
      | "UNAUTHENTICATED"
      | "PERMISSION_DENIED"
      | "NOT_FOUND"
      | "FAILED_PRECONDITION"
      | "INTERNAL"
      | "UNAVAILABLE";
  };
}

export function invalidArgumentError(message: string): GeminiErrorEnvelope {
  return { error: { code: 400, message, status: "INVALID_ARGUMENT" } };
}

export function unauthenticatedError(message: string): GeminiErrorEnvelope {
  return { error: { code: 401, message, status: "UNAUTHENTICATED" } };
}

export function notFoundError(message: string): GeminiErrorEnvelope {
  return { error: { code: 404, message, status: "NOT_FOUND" } };
}

export function internalError(message: string): GeminiErrorEnvelope {
  return { error: { code: 500, message, status: "INTERNAL" } };
}

/**
 * Re-export of the same error class the Anthropic shim uses. Centralized here
 * so the Gemini handlers don't need to cross-import from `src/anthropicShim/`;
 * keeps shim modules orthogonal per the spec's parallel-shim discipline.
 *
 * The class is duplicated rather than re-exported to keep the shim modules
 * fully independent — if the Anthropic shim later changes its `ShimRequestError`
 * signature, the Gemini shim must NOT silently inherit the change. Duplication
 * forces a deliberate edit in both places.
 */
export class ShimRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ShimRequestError";
  }
}
