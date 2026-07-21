import {
  type CheckpointState,
  err,
  IrohaError,
  ok,
  type Result,
  type SessionRunStatus,
  type TurnStatus,
  type TypedId,
  transitionSessionRunStatus,
  transitionTurnStatus,
  validateSessionRunEndedAtInvariant,
} from "@iroha/domain";
import type { Executor } from "../connection.js";
import { mapLibsqlError } from "../errors.js";
import { nullableNumber, nullableString } from "../row-helpers.js";

// --- agent_sessions ---------------------------------------------------

export type SessionPlatform = "claude_code" | "codex";
export type SessionSummaryStatus = "none" | "draft" | "approved";

export interface AgentSessionRow {
  id: TypedId<"ses">;
  repositoryId: TypedId<"repo">;
  platform: SessionPlatform;
  platformSessionId: string | null;
  parentSessionId: TypedId<"ses"> | null;
  actorId: TypedId<"act"> | null;
  modelLastSeen: string | null;
  startedAt: string;
  lastSeenAt: string;
  summaryStatus: SessionSummaryStatus;
}

export interface InsertAgentSessionInput {
  id: TypedId<"ses">;
  repositoryId: TypedId<"repo">;
  platform: SessionPlatform;
  platformSessionId?: string;
  parentSessionId?: TypedId<"ses">;
  actorId?: TypedId<"act">;
  modelLastSeen?: string;
  startedAt: string;
  lastSeenAt: string;
}

function rowToAgentSession(row: Record<string, unknown>): AgentSessionRow {
  return {
    id: row.id as TypedId<"ses">,
    repositoryId: row.repository_id as TypedId<"repo">,
    platform: row.platform as SessionPlatform,
    platformSessionId: nullableString(row.platform_session_id),
    parentSessionId:
      row.parent_session_id === null ? null : (row.parent_session_id as TypedId<"ses">),
    actorId: row.actor_id === null ? null : (row.actor_id as TypedId<"act">),
    modelLastSeen: nullableString(row.model_last_seen),
    startedAt: String(row.started_at),
    lastSeenAt: String(row.last_seen_at),
    summaryStatus: row.summary_status as SessionSummaryStatus,
  };
}

/** `summary_status` always starts `'none'` (its column default); not an insert input. */
export async function insertAgentSession(
  db: Executor,
  input: InsertAgentSessionInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO agent_sessions
        (id, repository_id, platform, platform_session_id, parent_session_id, actor_id, model_last_seen, started_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.id,
        input.repositoryId,
        input.platform,
        input.platformSessionId ?? null,
        input.parentSessionId ?? null,
        input.actorId ?? null,
        input.modelLastSeen ?? null,
        input.startedAt,
        input.lastSeenAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to insert agent session"));
  }
}

export async function getAgentSessionById(
  db: Executor,
  id: TypedId<"ses">,
): Promise<Result<AgentSessionRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM agent_sessions WHERE id = ?",
      args: [id],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToAgentSession(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read agent session"));
  }
}

/** Matches the `idx_agent_sessions_platform_identity` partial unique index. */
export async function getAgentSessionByPlatformIdentity(
  db: Executor,
  repositoryId: TypedId<"repo">,
  platform: SessionPlatform,
  platformSessionId: string,
): Promise<Result<AgentSessionRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM agent_sessions WHERE repository_id = ? AND platform = ? AND platform_session_id = ?",
      args: [repositoryId, platform, platformSessionId],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToAgentSession(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read agent session"));
  }
}

export async function touchAgentSessionLastSeen(
  db: Executor,
  id: TypedId<"ses">,
  lastSeenAt: string,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: "UPDATE agent_sessions SET last_seen_at = ? WHERE id = ?",
      args: [lastSeenAt, id],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to update agent session"));
  }
}

export async function updateAgentSessionSummaryStatus(
  db: Executor,
  id: TypedId<"ses">,
  summaryStatus: SessionSummaryStatus,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: "UPDATE agent_sessions SET summary_status = ? WHERE id = ?",
      args: [summaryStatus, id],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to update agent session"));
  }
}

// --- session_runs ---------------------------------------------------

export type SessionRunStartSource = "startup" | "resume" | "clear";
export type SessionRunEndReason =
  | "normal"
  | "clear"
  | "logout"
  | "prompt_input_exit"
  | "other"
  | "interrupted"
  | "abandoned";

export interface SessionRunRow {
  id: TypedId<"run">;
  sessionId: TypedId<"ses">;
  startSource: SessionRunStartSource;
  cwdFingerprint: string;
  gitBranch: string | null;
  headShaStart: string | null;
  headShaEnd: string | null;
  startedAt: string;
  endedAt: string | null;
  endReason: SessionRunEndReason | null;
  status: SessionRunStatus;
}

export interface InsertSessionRunInput {
  id: TypedId<"run">;
  sessionId: TypedId<"ses">;
  startSource: SessionRunStartSource;
  cwdFingerprint: string;
  gitBranch?: string;
  headShaStart?: string;
  startedAt: string;
}

function rowToSessionRun(row: Record<string, unknown>): SessionRunRow {
  return {
    id: row.id as TypedId<"run">,
    sessionId: row.session_id as TypedId<"ses">,
    startSource: row.start_source as SessionRunStartSource,
    cwdFingerprint: String(row.cwd_fingerprint),
    gitBranch: nullableString(row.git_branch),
    headShaStart: nullableString(row.head_sha_start),
    headShaEnd: nullableString(row.head_sha_end),
    startedAt: String(row.started_at),
    endedAt: nullableString(row.ended_at),
    endReason: row.end_reason === null ? null : (row.end_reason as SessionRunEndReason),
    status: row.status as SessionRunStatus,
  };
}

/** A Run always starts `active` with no `ended_at` (design.md §8: resume creates a new Run). */
export async function insertSessionRun(
  db: Executor,
  input: InsertSessionRunInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO session_runs
        (id, session_id, start_source, cwd_fingerprint, git_branch, head_sha_start, started_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      args: [
        input.id,
        input.sessionId,
        input.startSource,
        input.cwdFingerprint,
        input.gitBranch ?? null,
        input.headShaStart ?? null,
        input.startedAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to insert session run"));
  }
}

export async function getSessionRunById(
  db: Executor,
  id: TypedId<"run">,
): Promise<Result<SessionRunRow | null, IrohaError>> {
  try {
    const result = await db.execute({ sql: "SELECT * FROM session_runs WHERE id = ?", args: [id] });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToSessionRun(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read session run"));
  }
}

/** Used at `SessionStart` to detect a stale Run left `active` by an unclean previous exit. */
export async function getActiveSessionRunForSession(
  db: Executor,
  sessionId: TypedId<"ses">,
): Promise<Result<SessionRunRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM session_runs WHERE session_id = ? AND status = 'active'",
      args: [sessionId],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToSessionRun(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read active session run"));
  }
}

export interface CloseSessionRunInput {
  from: SessionRunStatus;
  to: SessionRunStatus;
  endedAt: string;
  endReason: SessionRunEndReason;
  headShaEnd?: string;
}

/**
 * Validates the transition against the domain state machine (states/
 * session-run.ts) before writing, so an illegal transition fails with a
 * clear `INVALID_INPUT` instead of the DB's own `CHECK` constraint error.
 * The `UPDATE` also re-checks `status = input.from` and reports `CONFLICT`
 * on `rowsAffected === 0` — confirmed by reproduction that without this
 * guard, two concurrent callers racing from the same `from` status (e.g.
 * one closing a Run `completed`, another `interrupted`) both succeed with
 * no error, and the second write silently discards the first.
 */
export async function closeSessionRun(
  db: Executor,
  id: TypedId<"run">,
  input: CloseSessionRunInput,
): Promise<Result<void, IrohaError>> {
  const transition = transitionSessionRunStatus(input.from, input.to);
  if (!transition.ok) {
    return transition;
  }
  const invariant = validateSessionRunEndedAtInvariant(input.to, new Date(input.endedAt));
  if (!invariant.ok) {
    return invariant;
  }
  try {
    const result = await db.execute({
      sql: "UPDATE session_runs SET status = ?, ended_at = ?, end_reason = ?, head_sha_end = ? WHERE id = ? AND status = ?",
      args: [input.to, input.endedAt, input.endReason, input.headShaEnd ?? null, id, input.from],
    });
    if (result.rowsAffected === 0) {
      return err(
        new IrohaError("CONFLICT", "Session run was modified concurrently or no longer exists", {
          details: { id },
        }),
      );
    }
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to close session run"));
  }
}

// --- turns ---------------------------------------------------

export interface TurnRow {
  id: TypedId<"trn">;
  runId: TypedId<"run">;
  externalTurnId: string | null;
  externalPromptId: string | null;
  promptDigest: string | null;
  intentSummary: string | null;
  startedAt: string;
  stoppedAt: string | null;
  status: TurnStatus;
  checkpointState: CheckpointState;
}

export interface InsertTurnInput {
  id: TypedId<"trn">;
  runId: TypedId<"run">;
  externalTurnId?: string;
  externalPromptId?: string;
  promptDigest?: string;
  intentSummary?: string;
  startedAt: string;
}

function rowToTurn(row: Record<string, unknown>): TurnRow {
  return {
    id: row.id as TypedId<"trn">,
    runId: row.run_id as TypedId<"run">,
    externalTurnId: nullableString(row.external_turn_id),
    externalPromptId: nullableString(row.external_prompt_id),
    promptDigest: nullableString(row.prompt_digest),
    intentSummary: nullableString(row.intent_summary),
    startedAt: String(row.started_at),
    stoppedAt: nullableString(row.stopped_at),
    status: row.status as TurnStatus,
    checkpointState: row.checkpoint_state as CheckpointState,
  };
}

/** A Turn always starts `active` with `checkpoint_state = 'not_required'` (both column defaults/fixed). */
export async function insertTurn(
  db: Executor,
  input: InsertTurnInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO turns
        (id, run_id, external_turn_id, external_prompt_id, prompt_digest, intent_summary, started_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      args: [
        input.id,
        input.runId,
        input.externalTurnId ?? null,
        input.externalPromptId ?? null,
        input.promptDigest ?? null,
        input.intentSummary ?? null,
        input.startedAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to insert turn"));
  }
}

export async function getTurnById(
  db: Executor,
  id: TypedId<"trn">,
): Promise<Result<TurnRow | null, IrohaError>> {
  try {
    const result = await db.execute({ sql: "SELECT * FROM turns WHERE id = ?", args: [id] });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToTurn(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read turn"));
  }
}

/** Matches the `idx_turns_external` partial unique index. */
export async function getTurnByExternalId(
  db: Executor,
  runId: TypedId<"run">,
  externalTurnId: string,
): Promise<Result<TurnRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM turns WHERE run_id = ? AND external_turn_id = ?",
      args: [runId, externalTurnId],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToTurn(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read turn"));
  }
}

/**
 * The most recently started Turn of a Run — the "current" Turn a tool event or
 * Stop hook refers to, since a Run's Turns are created one per user prompt in
 * chronological order. Returns `null` for a Run with no Turns yet.
 */
export async function getLatestTurnForRun(
  db: Executor,
  runId: TypedId<"run">,
): Promise<Result<TurnRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM turns WHERE run_id = ? ORDER BY started_at DESC, id DESC LIMIT 1",
      args: [runId],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToTurn(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read latest turn"));
  }
}

export interface CloseTurnInput {
  from: TurnStatus;
  to: TurnStatus;
  stoppedAt: string;
}

/**
 * The `UPDATE` re-checks `status = input.from` and reports `CONFLICT` on
 * `rowsAffected === 0` — same reasoning as `closeSessionRun`'s guard.
 */
export async function closeTurn(
  db: Executor,
  id: TypedId<"trn">,
  input: CloseTurnInput,
): Promise<Result<void, IrohaError>> {
  const transition = transitionTurnStatus(input.from, input.to);
  if (!transition.ok) {
    return transition;
  }
  try {
    const result = await db.execute({
      sql: "UPDATE turns SET status = ?, stopped_at = ? WHERE id = ? AND status = ?",
      args: [input.to, input.stoppedAt, id, input.from],
    });
    if (result.rowsAffected === 0) {
      return err(
        new IrohaError("CONFLICT", "Turn was modified concurrently or no longer exists", {
          details: { id },
        }),
      );
    }
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to close turn"));
  }
}

/** hooks-contract.md §6.6 owns the `checkpoint_state` transition rules, not this package. */
export async function updateTurnCheckpointState(
  db: Executor,
  id: TypedId<"trn">,
  checkpointState: CheckpointState,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: "UPDATE turns SET checkpoint_state = ? WHERE id = ?",
      args: [checkpointState, id],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to update turn checkpoint state"));
  }
}

// --- tool_events ---------------------------------------------------

export type ToolEventPhase = "pre" | "post" | "failure" | "denied";
export type ToolEventTargetKind = "file" | "path" | "command" | "mcp" | "other";
export type ToolEventStatus = "started" | "succeeded" | "failed" | "denied";

export interface ToolEventRow {
  id: TypedId<"evt">;
  turnId: TypedId<"trn">;
  externalToolUseId: string | null;
  toolName: string;
  phase: ToolEventPhase;
  targetKind: ToolEventTargetKind | null;
  targetSummary: string | null;
  inputDigest: string | null;
  responseDigest: string | null;
  status: ToolEventStatus;
  durationMs: number | null;
  occurredAt: string;
}

export interface InsertToolEventInput {
  id: TypedId<"evt">;
  turnId: TypedId<"trn">;
  externalToolUseId?: string;
  toolName: string;
  phase: ToolEventPhase;
  targetKind?: ToolEventTargetKind;
  targetSummary?: string;
  inputDigest?: string;
  responseDigest?: string;
  status: ToolEventStatus;
  durationMs?: number;
  occurredAt: string;
}

function rowToToolEvent(row: Record<string, unknown>): ToolEventRow {
  return {
    id: row.id as TypedId<"evt">,
    turnId: row.turn_id as TypedId<"trn">,
    externalToolUseId: nullableString(row.external_tool_use_id),
    toolName: String(row.tool_name),
    phase: row.phase as ToolEventPhase,
    targetKind: row.target_kind === null ? null : (row.target_kind as ToolEventTargetKind),
    targetSummary: nullableString(row.target_summary),
    inputDigest: nullableString(row.input_digest),
    responseDigest: nullableString(row.response_digest),
    status: row.status as ToolEventStatus,
    durationMs: nullableNumber(row.duration_ms),
    occurredAt: String(row.occurred_at),
  };
}

export async function insertToolEvent(
  db: Executor,
  input: InsertToolEventInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO tool_events
        (id, turn_id, external_tool_use_id, tool_name, phase, target_kind, target_summary, input_digest, response_digest, status, duration_ms, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.id,
        input.turnId,
        input.externalToolUseId ?? null,
        input.toolName,
        input.phase,
        input.targetKind ?? null,
        input.targetSummary ?? null,
        input.inputDigest ?? null,
        input.responseDigest ?? null,
        input.status,
        input.durationMs ?? null,
        input.occurredAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to insert tool event"));
  }
}

/** Matches the `idx_tool_events_turn_time` index. */
export async function listToolEventsByTurn(
  db: Executor,
  turnId: TypedId<"trn">,
): Promise<Result<ToolEventRow[], IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM tool_events WHERE turn_id = ? ORDER BY occurred_at",
      args: [turnId],
    });
    return ok(result.rows.map(rowToToolEvent));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list tool events"));
  }
}

// --- checkpoints ---------------------------------------------------

export type CheckpointOutcome = "completed" | "partial" | "blocked" | "no_change";

export interface CheckpointRow {
  id: TypedId<"chk">;
  sessionId: TypedId<"ses">;
  turnId: TypedId<"trn"> | null;
  outcome: CheckpointOutcome;
  objective: string;
  summary: string;
  implementationJson: string;
  validationJson: string;
  unresolvedJson: string;
  referencesJson: string;
  labelsJson: string;
  createdAt: string;
}

/**
 * Pre-serialized JSON columns, not a raw `CheckpointInput` (`@iroha/domain`'s
 * `checkpointInputSchema`) — translating the MCP `create_checkpoint` tool
 * input into these rows is the MCP layer's job (WP-07), not this package's.
 */
export interface InsertCheckpointInput {
  id: TypedId<"chk">;
  sessionId: TypedId<"ses">;
  turnId?: TypedId<"trn">;
  outcome: CheckpointOutcome;
  objective: string;
  summary: string;
  implementationJson: string;
  validationJson: string;
  unresolvedJson: string;
  referencesJson: string;
  labelsJson: string;
  createdAt: string;
}

function rowToCheckpoint(row: Record<string, unknown>): CheckpointRow {
  return {
    id: row.id as TypedId<"chk">,
    sessionId: row.session_id as TypedId<"ses">,
    turnId: row.turn_id === null ? null : (row.turn_id as TypedId<"trn">),
    outcome: row.outcome as CheckpointOutcome,
    objective: String(row.objective),
    summary: String(row.summary),
    implementationJson: String(row.implementation_json),
    validationJson: String(row.validation_json),
    unresolvedJson: String(row.unresolved_json),
    referencesJson: String(row.references_json),
    labelsJson: String(row.labels_json),
    createdAt: String(row.created_at),
  };
}

export async function insertCheckpoint(
  db: Executor,
  input: InsertCheckpointInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO checkpoints
        (id, session_id, turn_id, outcome, objective, summary, implementation_json, validation_json, unresolved_json, references_json, labels_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.id,
        input.sessionId,
        input.turnId ?? null,
        input.outcome,
        input.objective,
        input.summary,
        input.implementationJson,
        input.validationJson,
        input.unresolvedJson,
        input.referencesJson,
        input.labelsJson,
        input.createdAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to insert checkpoint"));
  }
}

export async function getCheckpointById(
  db: Executor,
  id: TypedId<"chk">,
): Promise<Result<CheckpointRow | null, IrohaError>> {
  try {
    const result = await db.execute({ sql: "SELECT * FROM checkpoints WHERE id = ?", args: [id] });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToCheckpoint(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read checkpoint"));
  }
}

/** Matches the `idx_checkpoints_session_time` index. */
export async function listCheckpointsBySession(
  db: Executor,
  sessionId: TypedId<"ses">,
  limit?: number,
): Promise<Result<CheckpointRow[], IrohaError>> {
  try {
    const result = await db.execute({
      sql:
        limit === undefined
          ? "SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC"
          : "SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
      args: limit === undefined ? [sessionId] : [sessionId, limit],
    });
    return ok(result.rows.map(rowToCheckpoint));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list checkpoints"));
  }
}

// --- dashboard list queries (WP-09) ---------------------------------------

/**
 * One row of the dashboard Session list (dashboard-api.md §6 "Session detail"
 * header fields), an `agent_sessions` row enriched with per-Session Run
 * aggregates so the list can show run count, the newest Run's status, and its
 * branch without an N+1 query.
 */
export interface SessionListItemRow extends AgentSessionRow {
  runCount: number;
  latestRunStatus: SessionRunStatus | null;
  latestBranch: string | null;
}

export interface ListSessionsFilter {
  /** Page size; the caller passes `limit + 1` to detect a next page. */
  limit: number;
  /** Keyset cursor: return rows strictly older than this `(last_seen_at, id)` pair. */
  beforeLastSeenAt?: string;
  beforeId?: TypedId<"ses">;
  platform?: SessionPlatform;
  summaryStatus?: SessionSummaryStatus;
  /** Inclusive `started_at` lower/upper bounds (RFC 3339 UTC). */
  from?: string;
  to?: string;
}

function rowToSessionListItem(row: Record<string, unknown>): SessionListItemRow {
  return {
    ...rowToAgentSession(row),
    runCount: Number(row.run_count),
    latestRunStatus:
      row.latest_run_status === null ? null : (row.latest_run_status as SessionRunStatus),
    latestBranch: nullableString(row.latest_branch),
  };
}

/**
 * Paginated Session list for the dashboard (`GET /api/v1/sessions`). Ordered
 * `last_seen_at DESC, id DESC` — the deterministic ID tie-breaker
 * dashboard-api.md §4 requires for stable cursor pagination — and filtered by
 * the keyset cursor plus optional platform/summary-status/date-range. The Run
 * aggregates are correlated subqueries rather than a GROUP BY so the outer
 * keyset predicate and LIMIT stay simple and index-friendly.
 */
export async function listSessions(
  db: Executor,
  repositoryId: TypedId<"repo">,
  filter: ListSessionsFilter,
): Promise<Result<SessionListItemRow[], IrohaError>> {
  const conditions = ["s.repository_id = ?"];
  const args: Array<string | number> = [repositoryId];
  if (filter.beforeLastSeenAt !== undefined && filter.beforeId !== undefined) {
    conditions.push("(s.last_seen_at, s.id) < (?, ?)");
    args.push(filter.beforeLastSeenAt, filter.beforeId);
  }
  if (filter.platform !== undefined) {
    conditions.push("s.platform = ?");
    args.push(filter.platform);
  }
  if (filter.summaryStatus !== undefined) {
    conditions.push("s.summary_status = ?");
    args.push(filter.summaryStatus);
  }
  if (filter.from !== undefined) {
    conditions.push("s.started_at >= ?");
    args.push(filter.from);
  }
  if (filter.to !== undefined) {
    conditions.push("s.started_at <= ?");
    args.push(filter.to);
  }
  args.push(filter.limit);
  try {
    const result = await db.execute({
      sql: `SELECT s.*,
          (SELECT COUNT(*) FROM session_runs r WHERE r.session_id = s.id) AS run_count,
          (SELECT r.status FROM session_runs r WHERE r.session_id = s.id
             ORDER BY r.started_at DESC, r.id DESC LIMIT 1) AS latest_run_status,
          (SELECT r.git_branch FROM session_runs r WHERE r.session_id = s.id
             ORDER BY r.started_at DESC, r.id DESC LIMIT 1) AS latest_branch
        FROM agent_sessions s
        WHERE ${conditions.join(" AND ")}
        ORDER BY s.last_seen_at DESC, s.id DESC
        LIMIT ?`,
      args,
    });
    return ok(result.rows.map(rowToSessionListItem));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list sessions"));
  }
}

/** All Runs of a Session in execution order (`GET /api/v1/sessions/:id`). */
export async function listRunsBySession(
  db: Executor,
  sessionId: TypedId<"ses">,
): Promise<Result<SessionRunRow[], IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM session_runs WHERE session_id = ? ORDER BY started_at, id",
      args: [sessionId],
    });
    return ok(result.rows.map(rowToSessionRun));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list session runs"));
  }
}

/** All Turns of a Run in prompt order (`GET /api/v1/sessions/:id/runs/:runId`). */
export async function listTurnsByRun(
  db: Executor,
  runId: TypedId<"run">,
): Promise<Result<TurnRow[], IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM turns WHERE run_id = ? ORDER BY started_at, id",
      args: [runId],
    });
    return ok(result.rows.map(rowToTurn));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list turns"));
  }
}
