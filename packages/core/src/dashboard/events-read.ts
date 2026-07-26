import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { ok } from "@iroha/domain";
import { type EventLogOutcome, listEventLogByRepository } from "@iroha/storage";
import { resolvePageSize } from "./cursor.js";
import { withDashboardRepository } from "./with-repository.js";

export interface DiagnosticsEvent {
  id: string;
  eventType: string;
  adapter: string | null;
  durationMs: number | null;
  outcome: EventLogOutcome;
  errorCode: string | null;
  occurredAt: string;
}

export interface DiagnosticsEventsData {
  events: DiagnosticsEvent[];
}

export interface ListDiagnosticsEventsInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  limit?: number;
}

/**
 * Recent local diagnostics rows (`GET /api/v1/events`), newest first — which
 * tool, endpoint, or sync ran, how long it took, and whether it succeeded,
 * warned, or failed.
 *
 * `event_log` holds no actor, path, or content column by construction
 * (hooks-contract.md §10), so this endpoint has nothing per-person to expose and
 * needs no filtering to stay within NFR-008. `session_id`/`turn_id` are not
 * projected: the page shows an operational timeline, not a session drill-down.
 *
 * `limit` goes through the shared `resolvePageSize`, so it obeys §4's "default
 * 30, maximum 100" like every other list endpoint — and inherits its `Math.trunc`,
 * without which a fractional value reaches SQL `LIMIT` and raises SQLITE_MISMATCH
 * (a 500) instead of being ignored the way §4's lenient-query rule requires.
 */
export async function listDiagnosticsEvents(
  input: ListDiagnosticsEventsInput,
): Promise<Result<DiagnosticsEventsData, IrohaError>> {
  const limit = resolvePageSize(input.limit);
  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const rows = await listEventLogByRepository(ctx.db, ctx.repo.repositoryId, limit);
      if (!rows.ok) {
        return rows;
      }
      return ok({
        events: rows.value.map((row) => ({
          id: row.id,
          eventType: row.eventType,
          adapter: row.adapter,
          durationMs: row.durationMs,
          outcome: row.outcome,
          errorCode: row.errorCode,
          occurredAt: row.occurredAt,
        })),
      });
    },
  );
}
