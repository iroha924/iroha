import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { ensureRepositorySalt } from "@iroha/git";
import { closeDatabase, type Database, openDatabase } from "@iroha/storage";
import { type McpToolName, recordEvent } from "../event-log.js";
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
  /** The tool this request is serving, recorded on its `event_log` row. */
  tool: McpToolName;
}

/**
 * Resolves the initialized repository for an MCP request, opens its libSQL
 * database lazily, runs `fn`, and always closes the connection (mcp-contract.md
 * §2). Unlike the Hook path, which is fail-open, MCP surfaces typed errors: a
 * missing or uninitialized repository returns `NOT_INITIALIZED` rather than
 * silently succeeding, and the server never migrates implicitly.
 *
 * Each call also appends an `event_log` row. This is the only seam that holds
 * both the tool name and an open connection — the transport dispatcher knows the
 * name but has no database, and recording there would cost a second repository
 * resolution and connection per tool call. A request that fails before the
 * database opens is necessarily unlogged.
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
  const startedAt = performance.now();
  try {
    const result = await fn({
      db,
      repo,
      salt: saltResult.value,
      cwd: input.cwd,
      clock: input.clock,
      random: input.random,
    });
    await recordEvent(db, repo.repositoryId, input, {
      eventType: "mcp.tool_call",
      adapter: input.tool,
      outcome: result.ok ? "success" : "failure",
      durationMs: Math.round(performance.now() - startedAt),
      ...(result.ok ? {} : { errorCode: result.error.code }),
    });
    return result;
  } finally {
    await closeDatabase(db);
  }
}
