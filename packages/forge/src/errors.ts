import { IrohaError } from "@iroha/domain";

/**
 * Build the single error a forge provider degrades to. The message must carry
 * no request detail beyond a coarse reason (never a token, URL userinfo, or raw
 * provider error) — the credential lives only in the adapter's auth layer.
 * `retryable` is true for transient failures (network, HTTP 429/5xx, secondary
 * rate limit) and false for auth/shape/client errors.
 */
export function forgeUnavailable(message: string, options: { retryable: boolean }): IrohaError {
  return new IrohaError("FORGE_UNAVAILABLE", message, { retryable: options.retryable });
}
