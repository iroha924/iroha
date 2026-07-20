import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { ensureRepositorySalt } from "@iroha/git";
import { closeDatabase, type Database, openDatabase } from "@iroha/storage";
import { type ResolvedRepository, resolveInitializedRepository } from "../resolve-repository.js";

export interface McpRepositoryContext {
  db: Database;
  repo: ResolvedRepository;
  salt: Uint8Array;
  cwd: string;
  clock: Clock;
  random: RandomSource;
}

export interface WithMcpRepositoryInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
}

/**
 * Resolves the initialized repository for an MCP request, opens its libSQL
 * database lazily, runs `fn`, and always closes the connection (mcp-contract.md
 * §2). Unlike the Hook path, which is fail-open, MCP surfaces typed errors: a
 * missing or uninitialized repository returns `NOT_INITIALIZED` rather than
 * silently succeeding, and the server never migrates implicitly.
 */
export async function withMcpRepository<T>(
  input: WithMcpRepositoryInput,
  fn: (ctx: McpRepositoryContext) => Promise<Result<T, IrohaError>>,
): Promise<Result<T, IrohaError>> {
  const repoResult = await resolveInitializedRepository(input.cwd);
  if (!repoResult.ok) {
    return repoResult;
  }
  const repo = repoResult.value;

  const saltResult = await ensureRepositorySalt(repo.irohaStateDir, input.random);
  if (!saltResult.ok) {
    return saltResult;
  }

  const opened = await openDatabase(repo.dbPath);
  if (!opened.ok) {
    return opened;
  }
  const db = opened.value;
  try {
    return await fn({
      db,
      repo,
      salt: saltResult.value,
      cwd: input.cwd,
      clock: input.clock,
      random: input.random,
    });
  } finally {
    await closeDatabase(db);
  }
}
