import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { closeDatabase, type Database, openDatabase } from "@iroha/storage";
import { type ResolvedRepository, resolveInitializedRepository } from "../resolve-repository.js";
import { withRepositoryWriteLock } from "../write-mutex.js";

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
 * (contracts/dashboard-api.md §3), not the MCP `ist_` session token.
 *
 * A fresh connection per request keeps the model simple and leak-free (a
 * crashed request cannot strand a shared handle); for a single local reviewer
 * the per-request open cost is well within the dashboard latency budget
 * (the dashboard's 500ms initial-response budget).
 */
async function openRunClose<T>(
  repo: ResolvedRepository,
  input: WithDashboardRepositoryInput,
  fn: (ctx: DashboardRepositoryContext) => Promise<Result<T, IrohaError>>,
): Promise<Result<T, IrohaError>> {
  const opened = await openDatabase(repo.dbPath);
  if (!opened.ok) {
    return opened;
  }
  const db = opened.value;
  try {
    return await fn({ db, repo, cwd: input.cwd, clock: input.clock, random: input.random });
  } finally {
    await closeDatabase(db);
  }
}

export async function withDashboardRepository<T>(
  input: WithDashboardRepositoryInput,
  fn: (ctx: DashboardRepositoryContext) => Promise<Result<T, IrohaError>>,
): Promise<Result<T, IrohaError>> {
  const repoResult = await resolveInitializedRepository(input.cwd);
  if (!repoResult.ok) {
    return repoResult;
  }
  return openRunClose(repoResult.value, input, fn);
}

/**
 * `withDashboardRepository` for a write use case, serialized by the per-repository
 * write lock (write-mutex.ts): the dashboard serves concurrent HTTP requests, so
 * the optimistic-token candidate mutations (`approve`/`reject`/`supersede`/`edit`)
 * run one at a time instead of each blocking on libSQL's native busy wait. The
 * lock is taken **before** the per-request connection is opened, so a queued
 * waiter holds only a promise, not a native libSQL handle. Writes that are already
 * one atomic step (the settings file's temp+rename, a local-setting upsert) or
 * self-serialize (`sync`) use `withDashboardRepository` directly.
 */
export async function withDashboardWrite<T>(
  input: WithDashboardRepositoryInput,
  fn: (ctx: DashboardRepositoryContext) => Promise<Result<T, IrohaError>>,
): Promise<Result<T, IrohaError>> {
  const repoResult = await resolveInitializedRepository(input.cwd);
  if (!repoResult.ok) {
    return repoResult;
  }
  return withRepositoryWriteLock(repoResult.value.repositoryId, () =>
    openRunClose(repoResult.value, input, fn),
  );
}
