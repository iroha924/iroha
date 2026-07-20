import type { ErrorCode, IrohaError, RandomSource } from "@iroha/core";

export interface McpWarning {
  code: string;
  message: string;
}

export interface McpSuccess<T> {
  schemaVersion: 1;
  ok: true;
  data: T;
  warnings: McpWarning[];
  traceId: string;
}

export interface McpFailure {
  schemaVersion: 1;
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  traceId: string;
}

export type McpEnvelope<T> = McpSuccess<T> | McpFailure;

/** Opaque per-request correlation id. Randomness flows through the injected port. */
export function newTraceId(random: RandomSource): string {
  return `trc_${Buffer.from(random.bytes(16)).toString("hex")}`;
}

export function successEnvelope<T>(
  data: T,
  traceId: string,
  warnings: McpWarning[] = [],
): McpSuccess<T> {
  return { schemaVersion: 1, ok: true, data, warnings, traceId };
}

/**
 * Maps a domain error onto the wire failure envelope. Only the typed `code`,
 * the redaction-safe `message`, and `retryable` are exposed — never the error's
 * `cause`, stack, SQL, or `details` (mcp-contract.md §4). The session token and
 * any absolute path are already kept out of `IrohaError.message` by
 * construction (typescript-conventions.md / the secure-subprocess rules).
 */
export function failureEnvelope(error: IrohaError, traceId: string): McpFailure {
  return {
    schemaVersion: 1,
    ok: false,
    error: { code: error.code, message: error.message, retryable: error.retryable },
    traceId,
  };
}
