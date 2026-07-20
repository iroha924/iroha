/**
 * @iroha/platform — normalized hook event/output contracts.
 *
 * Adapters (`@iroha/adapter-claude`, `@iroha/adapter-codex`) may depend only on
 * `@iroha/platform` (compatibility.md §4, enforced by biome). This package
 * therefore re-exports the `@iroha/domain` primitives those adapters need — the
 * normalized event schema/type and the `Result`/`IrohaError` error model — so an
 * adapter never has to import `@iroha/domain` directly.
 */
export const packageName = "@iroha/platform";

export {
  type ErrorCode,
  err,
  IrohaError,
  isErr,
  isOk,
  type NormalizedEvent,
  normalizedEventSchema,
  ok,
  type Result,
} from "@iroha/domain";

export * from "./hook-output.js";
export * from "./normalization.js";
