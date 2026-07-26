import { type Clock, makeTypedId, type RandomSource, type TypedId } from "@iroha/domain";
import {
  closeDatabase,
  type Database,
  type EventLogOutcome,
  insertEventLog,
  openDatabase,
} from "@iroha/storage";
import { resolveInitializedRepository } from "./resolve-repository.js";

/**
 * Every kind of event that may reach `event_log`. Enumerated rather than typed
 * as `string` so the whitelist is a compile error to escape, not a convention:
 * a caller cannot invent a kind that smuggles content into the column.
 */
export type EventLogEventType = "mcp.tool_call" | "api.request" | "sync.canonical" | "sync.forge";

/**
 * The MCP tools (contracts/mcp.md §3), as they appear in `event_log.adapter`.
 * Enumerated for the same reason as `EventLogEventType`: the column then holds
 * only names fixed in this repository, never a caller-supplied string.
 */
export type McpToolName =
  | "create_checkpoint"
  | "get_active_rules"
  | "get_context"
  | "get_digest_data"
  | "get_relations"
  | "get_session_state"
  | "link_entities"
  | "propose_knowledge"
  | "save_digest_prose"
  | "search";

export interface RecordEventInput {
  eventType: EventLogEventType;
  outcome: EventLogOutcome;
  /**
   * Which source produced the event, as an identifier fixed at the call site:
   * the tool name for MCP, the route pattern for an API request, the provider
   * for a forge sync. It widens `adapter` beyond the platform sense
   * contracts/hooks.md §10 gives it, which is what lets one column answer "which
   * tool/endpoint" without a schema change. Never pass a value derived from a
   * prompt, a tool input, a path, or any other request content.
   */
  adapter?: string;
  durationMs?: number;
  /** A stable error code — never a message. */
  errorCode?: string;
}

export interface EventLogDeps {
  clock: Clock;
  random: RandomSource;
}

/**
 * Error codes that mean iroha itself malfunctioned, as opposed to the caller
 * asking for something it could not have. Mirrors the 5xx set of the API's
 * `httpStatusForCode`, which cannot simply be shared: that maps a code to an
 * HTTP status, where 400/404/409 are meaningfully distinct, while this is a
 * two-way severity split for the diagnostics badge.
 */
const MALFUNCTION_CODES: ReadonlySet<string> = new Set([
  "DB_BUSY",
  "DB_UNAVAILABLE",
  "EMBEDDING_UNAVAILABLE",
  "FORGE_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

/**
 * Error codes an unauthenticated caller can produce at will. They are excluded
 * from `event_log` because the table is append-only with no retention (FR-111,
 * issue #127): recording them would let anything that can reach the MCP stdio
 * boundary grow the file by replaying a bad token. Losing them costs little —
 * an expired token is an access-control event, not a malfunction, and the agent
 * is told directly in the tool's error envelope.
 */
const UNAUTHENTICATED_CODES: ReadonlySet<string> = new Set([
  "INVALID_SESSION_TOKEN",
  "SESSION_EXPIRED",
]);

/** Whether a failure with this code is worth a diagnostics row at all. */
export function isRecordableFailure(code: string): boolean {
  return !UNAUTHENTICATED_CODES.has(code);
}

/**
 * Severity for a failed operation. Keeps the red `failure` badge for something
 * actually broken, so an expired token or an unknown id reads as `warning` —
 * the same split the API makes on 4xx vs 5xx, so the two producers agree in one
 * list. `retryable` cannot serve here: it defaults to `false`, which `INTERNAL_ERROR`
 * carries too.
 */
export function outcomeForErrorCode(code: string): EventLogOutcome {
  return MALFUNCTION_CODES.has(code) ? "failure" : "warning";
}

/**
 * Append one local diagnostics row (`event_log`), the queryable record of which
 * tool, endpoint, or sync ran, how long it took, and whether it succeeded,
 * warned, or failed.
 *
 * Privacy is structural, not procedural: `RecordEventInput` admits only the
 * pre-approved fields of contracts/hooks.md §10, so prompts, tool input/output,
 * transcripts, and credentials have no parameter to travel through. That is the
 * inverse of a redact-after-logging denylist, which cannot strip what it does
 * not know about (`secure-subprocess-and-credentials.md`).
 *
 * Returns `void` and discards `insertEventLog`'s error: diagnostics must never
 * break the paths that call it, and a write error is itself unloggable — there
 * is nowhere left to record it.
 */
export async function recordEvent(
  db: Database,
  repositoryId: TypedId<"repo">,
  deps: EventLogDeps,
  input: RecordEventInput,
): Promise<void> {
  await insertEventLog(db, {
    id: makeTypedId("log", deps.clock, deps.random),
    repositoryId,
    eventType: input.eventType,
    outcome: input.outcome,
    occurredAt: deps.clock.now().toISOString(),
    ...(input.adapter === undefined ? {} : { adapter: input.adapter }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
  });
}

export interface RecordEventForRepositoryInput extends RecordEventInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
}

/**
 * `recordEvent` for a caller that holds no connection: it resolves the
 * repository and opens one of its own. The HTTP transport needs this — the route
 * pattern is known only in middleware, outside the use case that owns the
 * connection — and pays a second resolution per request for it, which a local
 * single-reviewer dashboard can afford. Outside an initialized repository, or
 * when the database will not open, nothing is recorded and the caller is never
 * told.
 */
export async function recordEventForRepository(
  input: RecordEventForRepositoryInput,
): Promise<void> {
  const { cwd, clock, random, ...event } = input;
  const repo = await resolveInitializedRepository(cwd);
  if (!repo.ok) {
    return;
  }
  const opened = await openDatabase(repo.value.dbPath);
  if (!opened.ok) {
    return;
  }
  try {
    await recordEvent(opened.value, repo.value.repositoryId, { clock, random }, event);
  } finally {
    await closeDatabase(opened.value);
  }
}
