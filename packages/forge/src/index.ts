/**
 * @iroha/forge — provider-agnostic forge port. Defines the `ForgeProvider`
 * interface, the normalized domain types the Work Graph consumes, and the
 * `forgeUnavailable` degrade helper. Re-exports the `@iroha/domain` error
 * primitives so `@iroha/forge-github` (which may depend only on `@iroha/forge`,
 * compatibility.md §4) can build `Result` values without importing domain.
 */

export type { Result } from "@iroha/domain";
export { err, IrohaError, isErr, isOk, ok } from "@iroha/domain";
export * from "./errors.js";
export * from "./provider.js";
export * from "./types.js";
