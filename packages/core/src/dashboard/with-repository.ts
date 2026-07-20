import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { closeDatabase, type Database, openDatabase } from "@iroha/storage";
import { type ResolvedRepository, resolveInitializedRepository } from "../resolve-repository.js";

export interface DashboardRepositoryContext {
  db: Database;
  repo: ResolvedRepository;
  cwd: string;
  clock: Clock;
  random: RandomSource;
}

export interface WithDashboardRepositoryInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
}

/**
 * Resolves the initialized repository for a dashboard/local-API request, opens
 * its libSQL database, runs `fn`, and always closes the connection. Like
 * `withMcpRepository` it surfaces `NOT_INITIALIZED` for a missing `.iroha/` and
 * never migrates implicitly; unlike it, no HMAC salt is ensured because the
 * dashboard authenticates with its own launch-token/cookie exchange
 * (dashboard-api.md §3), not the MCP `ist_` session token.
 *
 * A fresh connection per request keeps the model simple and leak-free (a
 * crashed request cannot strand a shared handle); for a single local reviewer
 * the per-request open cost is well within the dashboard latency budget
 * (vertical-slice.md §7: initial API response <= 500ms).
 */
export async function withDashboardRepository<T>(
  input: WithDashboardRepositoryInput,
  fn: (ctx: DashboardRepositoryContext) => Promise<Result<T, IrohaError>>,
): Promise<Result<T, IrohaError>> {
  const repoResult = await resolveInitializedRepository(input.cwd);
  if (!repoResult.ok) {
    return repoResult;
  }
  const opened = await openDatabase(repoResult.value.dbPath);
  if (!opened.ok) {
    return opened;
  }
  const db = opened.value;
  try {
    return await fn({
      db,
      repo: repoResult.value,
      cwd: input.cwd,
      clock: input.clock,
      random: input.random,
    });
  } finally {
    await closeDatabase(db);
  }
}
