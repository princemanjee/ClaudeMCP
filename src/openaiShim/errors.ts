export interface OpenAIErrorEnvelope {
  error: {
    message: string;
    type:
      | "invalid_request_error"
      | "authentication_error"
      | "not_found_error"
      | "permission_denied_error"
      | "api_error";
    param: string | null;
    code: string | null;
  };
}

export interface ErrorOpts {
  param?: string;
  code?: string;
}

export function invalidRequestError(
  message: string,
  opts: ErrorOpts = {}
): OpenAIErrorEnvelope {
  return {
    error: {
      message,
      type: "invalid_request_error",
      param: opts.param ?? null,
      code: opts.code ?? null
    }
  };
}

export function authenticationError(message: string): OpenAIErrorEnvelope {
  return {
    error: {
      message,
      type: "authentication_error",
      param: null,
      code: "invalid_api_key"
    }
  };
}

export function notFoundError(message: string): OpenAIErrorEnvelope {
  return {
    error: {
      message,
      type: "not_found_error",
      param: null,
      code: "model_not_found"
    }
  };
}

export function permissionDeniedError(message: string): OpenAIErrorEnvelope {
  return {
    error: {
      message,
      type: "permission_denied_error",
      param: null,
      code: null
    }
  };
}

export function internalServerError(message: string): OpenAIErrorEnvelope {
  return {
    error: {
      message,
      type: "api_error",
      param: null,
      code: null
    }
  };
}

/**
 * Thrown by the request translator (and any other pre-handler validation) to
 * signal a client-facing error with a specific HTTP status. The handler catches
 * these and converts to the matching OpenAI envelope.
 */
export class ShimRequestError extends Error {
  public readonly param: string | undefined;
  public readonly code: string | undefined;

  constructor(
    public readonly status: number,
    message: string,
    opts: ErrorOpts = {}
  ) {
    super(message);
    this.name = "ShimRequestError";
    this.param = opts.param;
    this.code = opts.code;
  }
}
