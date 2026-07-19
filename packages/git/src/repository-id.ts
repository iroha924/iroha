import {
  type Clock,
  type IrohaError,
  makeTypedId,
  parseTypedId,
  type RandomSource,
  type Result,
  type TypedId,
} from "@iroha/domain";

export type RepositoryId = TypedId<"repo">;

/**
 * Generates a fresh, shared `repository_id` (a `repo_`-prefixed ULID). The
 * caller is responsible for persisting it — see `implementation/canonical-
 * schema.md` §9: it is generated once and committed to `.iroha/config.yaml`
 * so every team member and worktree agrees on the same value.
 */
export function generateRepositoryId(clock: Clock, random: RandomSource): RepositoryId {
  return makeTypedId("repo", clock, random);
}

export function parseRepositoryId(value: string): Result<RepositoryId, IrohaError> {
  return parseTypedId("repo", value);
}
