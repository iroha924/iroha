/**
 * Re-exports the `@iroha/domain` primitives the `@iroha/mcp` transport package
 * needs. `compatibility.md` §4 lets `@iroha/mcp` depend only on `@iroha/core`
 * (biome-enforced), so the thin stdio layer receives its shared value/type
 * vocabulary through this facade — the same pattern `@iroha/platform` uses to
 * feed the adapters (decision-log ID-028(a)).
 */

export type {
  CheckpointInput,
  Clock,
  ErrorCode,
  KnowledgeProposal,
  RandomSource,
  Result,
  TypedId,
} from "@iroha/domain";
export {
  CryptoRandomSource,
  checkpointInputSchema,
  IrohaError,
  proposalSchema,
  SystemClock,
} from "@iroha/domain";
export type { EntityType, RelationDirection, RelationType } from "@iroha/storage";
export { ENTITY_TYPES, RELATION_TYPES } from "@iroha/storage";
