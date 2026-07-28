import type { IrohaError, Result } from "@iroha/domain";
import { ok } from "@iroha/domain";
import { readRepositoryPeople } from "@iroha/git";
import { resolveInitializedRepository } from "../resolve-repository.js";

export interface RepositoryPeopleData {
  /** Names an approval can be attributed to, alphabetical. */
  names: string[];
  /** The local Git identity, for prefilling the reviewer field. */
  self: string | null;
}

export interface ListRepositoryPeopleInput {
  cwd: string;
}

/**
 * People this repository can credit an approval to (`GET /api/v1/people`).
 *
 * Unlike its sibling dashboard reads this opens no database: the names come
 * from Git history, and the `actors` table cannot answer the question — it is
 * written only by the Forge sync and has no `repository_id` to scope by. The
 * repository is still resolved first, so this refuses the same way every other
 * dashboard endpoint does, and so the Git calls run at the working-tree root
 * rather than wherever the server happens to have been launched.
 */
export async function listRepositoryPeople(
  input: ListRepositoryPeopleInput,
): Promise<Result<RepositoryPeopleData, IrohaError>> {
  const repoResult = await resolveInitializedRepository(input.cwd);
  if (!repoResult.ok) {
    return repoResult;
  }
  const people = await readRepositoryPeople(repoResult.value.gitLocation.root);
  if (!people.ok) {
    return people;
  }
  return ok({ names: people.value.names, self: people.value.self });
}
