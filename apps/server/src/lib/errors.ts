export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toJSON(requestId?: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(requestId ? { request_id: requestId } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(400, code, message, details);

export const unauthorized = (message = "missing or invalid credentials") =>
  new ApiError(401, "unauthorized", message);

export const forbidden = (message = "forbidden") => new ApiError(403, "forbidden", message);

/**
 * 403 specifically for the v0.8 phone-binding hard invariant
 * (`startVerification` rejects any phone that doesn't have a
 * `verified` row in `phone_bindings` for the calling app). Carries
 * a distinct `code` so SDKs / consumers can branch on it.
 */
export const phoneNotBound = (
  message = "phone is not bound to this app; complete the phone-binding ceremony first",
) => new ApiError(403, "phone_not_bound", message);

export const notFound = (resource = "resource") =>
  new ApiError(404, "not_found", `${resource} not found`);

export const conflict = (code: string, message: string) => new ApiError(409, code, message);

export const rateLimited = (retryAfterSeconds: number) =>
  new ApiError(429, "rate_limited", "too many requests", { retry_after: retryAfterSeconds });

export const serviceUnavailable = (code: string, message: string) =>
  new ApiError(503, code, message);

export const internal = (message = "internal error") =>
  new ApiError(500, "internal_error", message);
