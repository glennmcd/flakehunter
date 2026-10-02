import type { ApiErrorCode } from "@flakehunter/shared-types";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  payload_too_large: 413,
  invalid_report: 422,
  rate_limited: 429,
  internal_error: 500,
};

type ErrorDetails = { path: string; message: string }[];

export class ApiError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
    this.statusCode = STATUS_BY_CODE[code];
  }
}

export function errorBody(code: ApiErrorCode, message: string, requestId: string, details?: ErrorDetails) {
  return { error: { code, message, ...(details ? { details } : {}) }, requestId };
}
