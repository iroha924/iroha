/**
 * Re-exports the `@iroha/domain`/`@iroha/config`/`@iroha/storage` primitives the
 * `@iroha/mcp` and `@iroha/api` transport packages need. `compatibility.md` §4
 * lets each depend only on `@iroha/core` (biome-enforced), so those thin layers
 * receive their shared value/type vocabulary through this one facade — the same
 * pattern `@iroha/platform` uses to feed the adapters (decision-log ID-028(a)).
 * All cross-package re-exports live here so a duplicate `export *` elsewhere
 * cannot make a name ambiguous and silently drop it from `@iroha/core`.
 */

export type { RepositoryConfig } from "@iroha/config";
export { repositoryConfigSchema } from "@iroha/config";
export type {
  CandidateStatus,
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
export type { CandidateType, EntityType, RelationDirection, RelationType } from "@iroha/storage";
export { ENTITY_TYPES, RELATION_TYPES } from "@iroha/storage";
