import type { RandomSource } from "@iroha/core";

/**
 * The subset of `IrohaError` the API surfaces. `message` is always a fixed,
 * path/SQL/secret-free string (storage `mapLibsqlError` keeps raw causes in
 * `.cause`, never `.message`); `details`/`cause`/`stack` are deliberately never
 * echoed to the client (dashboard-api.md §4).
 */
export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  meta: { requestId: string };
}

export interface FailureEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    fieldErrors: Record<string, string>;
  };
  meta: { requestId: string };
}

/** dashboard-api.md §4: "all user-visible errors have stable codes"; maps each to an HTTP status. */
const HTTP_STATUS_BY_CODE: Record<string, number> = {
  NOT_INITIALIZED: 409,
  REPOSITORY_NOT_FOUND: 404,
  INVALID_INPUT: 400,
  INVALID_SESSION_TOKEN: 401,
  SESSION_EXPIRED: 401,
  SCHEMA_MISMATCH: 409,
  DB_BUSY: 503,
  DB_UNAVAILABLE: 503,
  EMBEDDING_UNAVAILABLE: 503,
  FORGE_UNAVAILABLE: 503,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LIMIT_EXCEEDED: 400,
  INTERNAL_ERROR: 500,
};

export function httpStatusForCode(code: string): number {
  return HTTP_STATUS_BY_CODE[code] ?? 500;
}

export function newRequestId(random: RandomSource): string {
  return `req_${Buffer.from(random.bytes(12)).toString("base64url")}`;
}

export function successBody<T>(requestId: string, data: T): SuccessEnvelope<T> {
  return { ok: true, data, meta: { requestId } };
}

export function failureBody(
  requestId: string,
  error: ApiError,
  fieldErrors: Record<string, string> = {},
): FailureEnvelope {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      fieldErrors,
    },
    meta: { requestId },
  };
}
