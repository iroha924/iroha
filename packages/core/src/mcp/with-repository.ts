import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { ensureRepositorySalt } from "@iroha/git";
import { closeDatabase, type Database, openDatabase } from "@iroha/storage";
import {
  isRecordableFailure,
  type McpToolName,
  outcomeForErrorCode,
  recordEvent,
} from "../event-log.js";
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
  /**
   * The MCP tool this request is serving, or `null` when a shared use case was
   * invoked from somewhere that is not the MCP boundary (the CLI, the dashboard
   * API). `null` records nothing — attributing a CLI search to `mcp.tool_call`
   * would make the diagnostics timeline claim an MCP call that never happened.
   */
  tool: McpToolName | null;
}

/**
 * Resolves the initialized repository for an MCP request, opens its libSQL
 * database lazily, runs `fn`, and always closes the connection (contracts/mcp.md
 * §2). Unlike the Hook path, which is fail-open, MCP surfaces typed errors: a
 * missing or uninitialized repository returns `NOT_INITIALIZED` rather than
 * silently succeeding, and the server never migrates implicitly.
 *
 * A **failed** call appends an `event_log` row; a successful one appends nothing.
 * `search`/`get_active_rules`/`get_relations` need no session token, so recording
 * every call would let a peer grow an append-only table with no retention
 * (FR-111 is unimplemented — see issue #127) simply by polling a cheap read.
 * Recording only failures also matches the API, so one list has one meaning.
 * This is the only seam holding both the tool name and an open connection — the
 * transport dispatcher knows the name but has no database — so a request that
 * fails before the database opens is necessarily unlogged.
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
    if (input.tool !== null && !result.ok && isRecordableFailure(result.error.code)) {
      await recordEvent(db, repo.repositoryId, input, {
        eventType: "mcp.tool_call",
        adapter: input.tool,
        outcome: outcomeForErrorCode(result.error.code),
        durationMs: Math.round(performance.now() - startedAt),
        errorCode: result.error.code,
      });
    }
    return result;
  } finally {
    await closeDatabase(db);
  }
}
