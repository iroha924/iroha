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
export type EventLogEventType =
  | "hook.session_started"
  | "hook.prompt_submitted"
  | "hook.tool_started"
  | "hook.tool_completed"
  | "hook.turn_stopped"
  | "hook.session_ended"
  | "guardrail.denied"
  | "mcp.tool_call"
  | "api.request"
  | "sync.canonical"
  | "sync.forge";

/**
 * The MCP tools (mcp-contract.md §3), as they appear in `event_log.adapter`.
 * Enumerated for the same reason as `EventLogEventType`: the column then holds
 * only names fixed in this repository, never a caller-supplied string.
 */
export type McpToolName =
  | "create_checkpoint"
  | "get_active_rules"
  | "get_context"
  | "get_relations"
  | "get_session_state"
  | "link_entities"
  | "propose_knowledge"
  | "search";

export interface RecordEventInput {
  eventType: EventLogEventType;
  outcome: EventLogOutcome;
  /**
   * Which source produced the event, as an identifier fixed at the call site:
   * the platform for a Hook (`claude_code`/`codex`), the tool name for MCP, the
   * route pattern for an API request. It widens `adapter` beyond the platform
   * sense hooks-contract.md §10 gives it, which is what lets one column answer
   * "which tool/endpoint" without a schema change. Never pass a value derived
   * from a prompt, a tool input, a path, or any other request content.
   */
  adapter?: string;
  durationMs?: number;
  /** A stable error code or an iroha-issued id (a denying rule's id) — never a message. */
  errorCode?: string;
  sessionId?: TypedId<"ses">;
  turnId?: TypedId<"trn">;
}

export interface EventLogDeps {
  clock: Clock;
  random: RandomSource;
}

/**
 * Append one local diagnostics row (`event_log`), the queryable record of which
 * hook/tool/endpoint ran, how long it took, and whether it succeeded, denied, or
 * failed.
 *
 * Privacy is structural, not procedural: `RecordEventInput` admits only the
 * pre-approved fields of hooks-contract.md §10, so prompts, tool input/output,
 * transcripts, and credentials have no parameter to travel through. That is the
 * inverse of a redact-after-logging denylist, which cannot strip what it does
 * not know about (`secure-subprocess-and-credentials.md`).
 *
 * Returns `void` and swallows every failure: diagnostics must never break or
 * slow the fail-open paths that call it. A write error is itself unloggable —
 * there is nowhere left to record it — so it is dropped rather than surfaced.
 */
export async function recordEvent(
  db: Database,
  repositoryId: TypedId<"repo">,
  deps: EventLogDeps,
  input: RecordEventInput,
): Promise<void> {
  try {
    await insertEventLog(db, {
      id: makeTypedId("log", deps.clock, deps.random),
      repositoryId,
      eventType: input.eventType,
      outcome: input.outcome,
      occurredAt: deps.clock.now().toISOString(),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.adapter === undefined ? {} : { adapter: input.adapter }),
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    });
  } catch {
    // Fail-open: an unwritable diagnostics row never propagates to the caller.
  }
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
 * single-reviewer dashboard can afford. Fail-open throughout: outside an
 * initialized repository, or when the database will not open, nothing is
 * recorded and the caller is never told.
 */
export async function recordEventForRepository(
  input: RecordEventForRepositoryInput,
): Promise<void> {
  const { cwd, clock, random, ...event } = input;
  try {
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
  } catch {
    // Fail-open, as above.
  }
}
