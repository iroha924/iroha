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
