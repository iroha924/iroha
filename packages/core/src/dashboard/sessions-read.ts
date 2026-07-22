import type { Clock, IrohaError, RandomSource, Result, TypedId } from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, ok, parseTypedId } from "@iroha/domain";
import {
  type CheckpointOutcome,
  getAgentSessionById,
  getCheckpointById,
  getSessionRunById,
  listCheckpointsBySession,
  listRunsBySession,
  listSessions,
  listToolEventsByTurns,
  listTurnsByRun,
  type SessionPlatform,
  type SessionSummaryStatus,
} from "@iroha/storage";
import { decodeCursor, encodeCursor, resolvePageSize } from "./cursor.js";
import { withDashboardRepository } from "./with-repository.js";

export interface SessionListItem {
  id: string;
  platform: SessionPlatform;
  startedAt: string;
  lastSeenAt: string;
  summaryStatus: SessionSummaryStatus;
  runCount: number;
  latestRunStatus: string | null;
  latestBranch: string | null;
}

export interface SessionListPage {
  items: SessionListItem[];
  nextCursor: string | null;
}

export interface ListDashboardSessionsInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  limit?: number;
  cursor?: string;
  platform?: SessionPlatform;
  summaryStatus?: SessionSummaryStatus;
  from?: string;
  to?: string;
}

/** Paginated Session list (`GET /api/v1/sessions`). */
export async function listDashboardSessions(
  input: ListDashboardSessionsInput,
): Promise<Result<SessionListPage, IrohaError>> {
  const pageSize = resolvePageSize(input.limit);
  let beforeLastSeenAt: string | undefined;
  let beforeId: TypedId<"ses"> | undefined;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor);
    const parsed = decoded === null ? null : parseTypedId("ses", decoded.id);
    if (decoded === null || parsed === null || !parsed.ok) {
      return err(new IrohaErrorClass("INVALID_INPUT", "Malformed pagination cursor"));
    }
    beforeLastSeenAt = decoded.key;
    beforeId = parsed.value;
  }

  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const rows = await listSessions(ctx.db, ctx.repo.repositoryId, {
        limit: pageSize + 1,
        ...(beforeLastSeenAt !== undefined && beforeId !== undefined
          ? { beforeLastSeenAt, beforeId }
          : {}),
        ...(input.platform !== undefined ? { platform: input.platform } : {}),
        ...(input.summaryStatus !== undefined ? { summaryStatus: input.summaryStatus } : {}),
        ...(input.from !== undefined ? { from: input.from } : {}),
        ...(input.to !== undefined ? { to: input.to } : {}),
      });
      if (!rows.ok) {
        return rows;
      }
      const page = rows.value.slice(0, pageSize);
      const last = page.at(-1);
      const nextCursor =
        rows.value.length > pageSize && last !== undefined
          ? encodeCursor({ key: last.lastSeenAt, id: last.id })
          : null;
      const items: SessionListItem[] = page.map((row) => ({
        id: row.id,
        platform: row.platform,
        startedAt: row.startedAt,
        lastSeenAt: row.lastSeenAt,
        summaryStatus: row.summaryStatus,
        runCount: row.runCount,
        latestRunStatus: row.latestRunStatus,
        latestBranch: row.latestBranch,
      }));
      return ok({ items, nextCursor });
    },
  );
}

export interface RunSummary {
  id: string;
  startSource: string;
  gitBranch: string | null;
  headShaStart: string | null;
  headShaEnd: string | null;
  startedAt: string;
  endedAt: string | null;
  status: string;
}

export interface CheckpointSummary {
  id: string;
  turnId: string | null;
  outcome: CheckpointOutcome;
  objective: string;
  createdAt: string;
}

export interface SessionDetailData {
  id: string;
  platform: SessionPlatform;
  startedAt: string;
  lastSeenAt: string;
  summaryStatus: SessionSummaryStatus;
  runs: RunSummary[];
  checkpoints: CheckpointSummary[];
}

export interface GetSessionDetailInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  sessionId: string;
}

/** Session detail with Runs and Checkpoints (`GET /api/v1/sessions/:id`); never raw conversation. */
export async function getSessionDetail(
  input: GetSessionDetailInput,
): Promise<Result<SessionDetailData, IrohaError>> {
  const parsedId = parseTypedId("ses", input.sessionId);
  if (!parsedId.ok) {
    return parsedId;
  }
  const sessionId = parsedId.value;

  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const sessionResult = await getAgentSessionById(ctx.db, sessionId);
      if (!sessionResult.ok) {
        return sessionResult;
      }
      const session = sessionResult.value;
      if (session === null) {
        return err(new IrohaErrorClass("NOT_FOUND", "Session not found"));
      }
      const runsResult = await listRunsBySession(ctx.db, sessionId);
      if (!runsResult.ok) {
        return runsResult;
      }
      const checkpointsResult = await listCheckpointsBySession(ctx.db, sessionId);
      if (!checkpointsResult.ok) {
        return checkpointsResult;
      }
      return ok({
        id: session.id,
        platform: session.platform,
        startedAt: session.startedAt,
        lastSeenAt: session.lastSeenAt,
        summaryStatus: session.summaryStatus,
        runs: runsResult.value.map((run) => ({
          id: run.id,
          startSource: run.startSource,
          gitBranch: run.gitBranch,
          headShaStart: run.headShaStart,
          headShaEnd: run.headShaEnd,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          status: run.status,
        })),
        checkpoints: checkpointsResult.value.map((cp) => ({
          id: cp.id,
          turnId: cp.turnId,
          outcome: cp.outcome,
          objective: cp.objective,
          createdAt: cp.createdAt,
        })),
      });
    },
  );
}

export interface ToolEventSummary {
  id: string;
  toolName: string;
  phase: string;
  targetKind: string | null;
  targetSummary: string | null;
  status: string;
  occurredAt: string;
}

export interface TurnDetail {
  id: string;
  intentSummary: string | null;
  startedAt: string;
  status: string;
  checkpointState: string;
  toolEvents: ToolEventSummary[];
}

export interface RunDetailData {
  run: RunSummary;
  turns: TurnDetail[];
}

export interface GetRunDetailInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  runId: string;
}

/** Run detail with Turns and Tool summaries (`GET /api/v1/sessions/:id/runs/:runId`); digests only, never raw payloads. */
export async function getRunDetail(
  input: GetRunDetailInput,
): Promise<Result<RunDetailData, IrohaError>> {
  const parsedId = parseTypedId("run", input.runId);
  if (!parsedId.ok) {
    return parsedId;
  }
  const runId = parsedId.value;

  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const runResult = await getSessionRunById(ctx.db, runId);
      if (!runResult.ok) {
        return runResult;
      }
      const run = runResult.value;
      if (run === null) {
        return err(new IrohaErrorClass("NOT_FOUND", "Run not found"));
      }
      const turnsResult = await listTurnsByRun(ctx.db, runId);
      if (!turnsResult.ok) {
        return turnsResult;
      }
      // One batched query for every turn's tool events (was one per turn),
      // grouped by turn_id; each turn keeps its ORDER BY occurred_at.
      const eventsByTurn = await listToolEventsByTurns(
        ctx.db,
        turnsResult.value.map((turn) => turn.id),
      );
      if (!eventsByTurn.ok) {
        return eventsByTurn;
      }
      const turns: TurnDetail[] = [];
      for (const turn of turnsResult.value) {
        turns.push({
          id: turn.id,
          intentSummary: turn.intentSummary,
          startedAt: turn.startedAt,
          status: turn.status,
          checkpointState: turn.checkpointState,
          toolEvents: (eventsByTurn.value.get(turn.id) ?? []).map((event) => ({
            id: event.id,
            toolName: event.toolName,
            phase: event.phase,
            targetKind: event.targetKind,
            targetSummary: event.targetSummary,
            status: event.status,
            occurredAt: event.occurredAt,
          })),
        });
      }
      return ok({
        run: {
          id: run.id,
          startSource: run.startSource,
          gitBranch: run.gitBranch,
          headShaStart: run.headShaStart,
          headShaEnd: run.headShaEnd,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          status: run.status,
        },
        turns,
      });
    },
  );
}

export interface CheckpointDetailData {
  id: string;
  sessionId: string;
  turnId: string | null;
  outcome: CheckpointOutcome;
  objective: string;
  summary: string;
  implementation: unknown;
  validation: unknown;
  unresolved: unknown;
  references: unknown;
  labels: unknown;
  createdAt: string;
}

export interface GetCheckpointDetailInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  checkpointId: string;
}

/** Structured Checkpoint detail (`GET /api/v1/checkpoints/:id`); JSON columns are parsed for the client. */
export async function getCheckpointDetail(
  input: GetCheckpointDetailInput,
): Promise<Result<CheckpointDetailData, IrohaError>> {
  const parsedId = parseTypedId("chk", input.checkpointId);
  if (!parsedId.ok) {
    return parsedId;
  }
  const checkpointId = parsedId.value;

  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const result = await getCheckpointById(ctx.db, checkpointId);
      if (!result.ok) {
        return result;
      }
      const cp = result.value;
      if (cp === null) {
        return err(new IrohaErrorClass("NOT_FOUND", "Checkpoint not found"));
      }
      return ok({
        id: cp.id,
        sessionId: cp.sessionId,
        turnId: cp.turnId,
        outcome: cp.outcome,
        objective: cp.objective,
        summary: cp.summary,
        implementation: JSON.parse(cp.implementationJson),
        validation: JSON.parse(cp.validationJson),
        unresolved: JSON.parse(cp.unresolvedJson),
        references: JSON.parse(cp.referencesJson),
        labels: JSON.parse(cp.labelsJson),
        createdAt: cp.createdAt,
      });
    },
  );
}
