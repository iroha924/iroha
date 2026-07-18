/**
 * Matches the ErrorCode union in implementation/mcp-contract.md §4.
 */
export const ERROR_CODES = [
  "NOT_INITIALIZED",
  "REPOSITORY_NOT_FOUND",
  "INVALID_INPUT",
  "INVALID_SESSION_TOKEN",
  "SESSION_EXPIRED",
  "SCHEMA_MISMATCH",
  "DB_BUSY",
  "DB_UNAVAILABLE",
  "EMBEDDING_UNAVAILABLE",
  "FORGE_UNAVAILABLE",
  "NOT_FOUND",
  "CONFLICT",
  "LIMIT_EXCEEDED",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

export interface IrohaErrorOptions {
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class IrohaError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: IrohaErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "IrohaError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}
