export interface AnthropicErrorEnvelope {
  type: "error";
  error: {
    type:
      | "invalid_request_error"
      | "authentication_error"
      | "not_found_error"
      | "api_error"
      | "overloaded_error";
    message: string;
  };
}

export function invalidRequestError(message: string): AnthropicErrorEnvelope {
  return {
    type: "error",
    error: { type: "invalid_request_error", message }
  };
}

export function authenticationError(message: string): AnthropicErrorEnvelope {
  return {
    type: "error",
    error: { type: "authentication_error", message }
  };
}

export function notFoundError(message: string): AnthropicErrorEnvelope {
  return {
    type: "error",
    error: { type: "not_found_error", message }
  };
}

export function internalServerError(message: string): AnthropicErrorEnvelope {
  return {
    type: "error",
    error: { type: "api_error", message }
  };
}

/**
 * Thrown by the request translator (and any other pre-handler validation) to
 * signal a client-facing error with a specific HTTP status. The handler catches
 * these and converts to the matching Anthropic envelope.
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
