/**
 * Retention pruning for the local, disposable index (FR-111).
 *
 * Everything here deletes rows, which the rest of this directory deliberately
 * does not (`operations.ts`: "Append-only — no update/delete functions by
 * design"). That policy exists so no code path can quietly drop history; this
 * file is the single, explicit exception, reached only when a human has set a
 * retention window.
 *
 * Two invariants shape every query below:
 *
 * 1. **Canonical is never touched.** `canonical_documents.entity_id` cascades
 *    from `entities`, so deleting a session entity that has an approved
 *    canonical document would drop the index row for Git-tracked team
 *    knowledge. Such sessions are excluded, not repaired afterwards.
 * 2. **Nothing awaiting a human is dropped.** A pending candidate's
 *    `source_session_id`/`source_checkpoint_id` are `ON DELETE SET NULL`, so
 *    pruning would not delete the candidate — it would silently strip its
 *    provenance. Sessions with a pending candidate are excluded too.
 */
import { err, type IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import type { Executor } from "../connection.js";
import { mapLibsqlError } from "../errors.js";

/**
 * Sessions eligible for pruning: last seen before `cutoff`, carrying no
 * approved canonical document (their own or one of their checkpoints') and no
 * candidate still awaiting review.
 */
const PRUNABLE_SESSIONS_SQL = `
  SELECT s.id AS id
  FROM agent_sessions s
  WHERE s.repository_id = ?
    AND s.last_seen_at < ?
    AND NOT EXISTS (SELECT 1 FROM canonical_documents cd WHERE cd.entity_id = s.id)
    AND NOT EXISTS (
      SELECT 1 FROM checkpoints c
      JOIN canonical_documents cd ON cd.entity_id = c.id
      WHERE c.session_id = s.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM candidates cand
      WHERE cand.source_session_id = s.id AND cand.status = 'pending'
    )`;

export interface PruneCounts {
  /** Sessions deleted, each cascading to its runs, turns, and tool events. */
  sessions: number;
  /** Checkpoint entities deleted alongside those sessions. */
  checkpoints: number;
  /** `event_log` rows deleted by timestamp, independently of any session. */
  eventLogRows: number;
}

/**
 * Deletes aged local session activity and diagnostics rows older than `cutoff`
 * (an ISO-8601 timestamp), returning what was removed.
 *
 * Sessions are deleted through `entities`, not `agent_sessions`: the session row
 * is the *child* of its entity (`agent_sessions.id REFERENCES entities(id)`), so
 * deleting the session directly would leave the entity behind as an orphan.
 * Checkpoint entities are deleted first for the same reason — they would
 * otherwise be orphaned by the `checkpoints.session_id` cascade.
 *
 * `event_log` is pruned by its own timestamp rather than with its session: its
 * `session_id` is `ON DELETE SET NULL`, so those rows survive a session delete
 * and would otherwise be the one table retention never bounds.
 */
export async function pruneLocalEventData(
  db: Executor,
  repositoryId: TypedId<"repo">,
  cutoff: string,
): Promise<Result<PruneCounts, IrohaError>> {
  try {
    const prunable = await db.execute({ sql: PRUNABLE_SESSIONS_SQL, args: [repositoryId, cutoff] });
    const sessionIds = prunable.rows.map((row) => String(row.id));

    let checkpoints = 0;
    for (const sessionId of sessionIds) {
      // Delete each session's checkpoint entities, then the session entity. Done
      // per session (not as one IN-list) so a large backlog stays a bounded
      // number of parameters per statement.
      const deletedCheckpoints = await db.execute({
        sql: `DELETE FROM entities WHERE id IN (
                SELECT c.id FROM checkpoints c WHERE c.session_id = ?
              )`,
        args: [sessionId],
      });
      checkpoints += Number(deletedCheckpoints.rowsAffected);
      await db.execute({ sql: "DELETE FROM entities WHERE id = ?", args: [sessionId] });
    }

    const deletedEvents = await db.execute({
      sql: "DELETE FROM event_log WHERE repository_id = ? AND occurred_at < ?",
      args: [repositoryId, cutoff],
    });

    return ok({
      sessions: sessionIds.length,
      checkpoints,
      eventLogRows: Number(deletedEvents.rowsAffected),
    });
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to prune local event data"));
  }
}

export interface LocalEventCounts {
  sessions: number;
  runs: number;
  turns: number;
  toolEvents: number;
  eventLogRows: number;
  /** Sessions that would be deleted right now at the configured window. */
  prunableSessions: number;
}

/**
 * Row counts for the local event tables, so `iroha doctor` can show that a
 * retention setting has an observable effect (and that an unset one does not).
 * `cutoff` is `null` when retention is disabled — `prunableSessions` is then 0
 * without running the eligibility query.
 */
export async function countLocalEventData(
  db: Executor,
  repositoryId: TypedId<"repo">,
  cutoff: string | null,
): Promise<Result<LocalEventCounts, IrohaError>> {
  try {
    const totals = await db.execute({
      sql: `SELECT
              (SELECT COUNT(*) FROM agent_sessions WHERE repository_id = ?) AS sessions,
              (SELECT COUNT(*) FROM session_runs r
                 JOIN agent_sessions s ON s.id = r.session_id
                 WHERE s.repository_id = ?) AS runs,
              (SELECT COUNT(*) FROM turns t
                 JOIN session_runs r ON r.id = t.run_id
                 JOIN agent_sessions s ON s.id = r.session_id
                 WHERE s.repository_id = ?) AS turns,
              (SELECT COUNT(*) FROM tool_events e
                 JOIN turns t ON t.id = e.turn_id
                 JOIN session_runs r ON r.id = t.run_id
                 JOIN agent_sessions s ON s.id = r.session_id
                 WHERE s.repository_id = ?) AS tool_events,
              (SELECT COUNT(*) FROM event_log WHERE repository_id = ?) AS event_log_rows`,
      args: [repositoryId, repositoryId, repositoryId, repositoryId, repositoryId],
    });
    const row = totals.rows[0];
    if (row === undefined) {
      return err(mapLibsqlError(new Error("no row"), "Failed to count local event data"));
    }

    let prunableSessions = 0;
    if (cutoff !== null) {
      const prunable = await db.execute({
        sql: `SELECT COUNT(*) AS n FROM (${PRUNABLE_SESSIONS_SQL})`,
        args: [repositoryId, cutoff],
      });
      prunableSessions = Number(prunable.rows[0]?.n ?? 0);
    }

    return ok({
      sessions: Number(row.sessions),
      runs: Number(row.runs),
      turns: Number(row.turns),
      toolEvents: Number(row.tool_events),
      eventLogRows: Number(row.event_log_rows),
      prunableSessions,
    });
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to count local event data"));
  }
}
