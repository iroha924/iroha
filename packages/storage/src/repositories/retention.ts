/**
 * Retention pruning for the local, disposable index (FR-111).
 *
 * Everything here deletes rows, which the rest of this directory deliberately
 * does not (`operations.ts`: "Append-only — no update/delete functions by
 * design"). That policy exists so no code path can quietly drop history; this
 * file is the single, explicit exception, reached only when a human has set a
 * retention window.
 *
 * Three invariants shape every query below.
 *
 * 1. **Canonical is never touched.** `canonical_documents.entity_id` cascades
 *    from `entities`, so deleting a session entity that has an approved
 *    canonical document would drop the index row for Git-tracked team
 *    knowledge. Such sessions are excluded, not repaired afterwards.
 * 2. **Nothing awaiting a human is dropped.** A pending candidate's
 *    `source_session_id`/`source_checkpoint_id` are `ON DELETE SET NULL`, so
 *    pruning would not delete the candidate — it would silently strip its
 *    provenance. Both routes are excluded: `propose_knowledge` accepts any
 *    existing `sourceCheckpointId`, so a pending candidate can reference this
 *    session's checkpoint while its own `source_session_id` is null or points
 *    elsewhere.
 * 3. **A session that another session still points at is kept.**
 *    `agent_sessions.parent_session_id` is `ON DELETE SET NULL`, so pruning a
 *    parent leaves its children alive but permanently unparented. A session with
 *    any child is excluded; the child ages out first, and the parent becomes
 *    eligible on a later sweep.
 * 4. **Age is measured from actual activity, not `last_seen_at` alone.**
 *    `last_seen_at` advances only on `SESSION_STARTED` (the hook dispatcher
 *    touches it in `handleSessionStart`, not in `resolveSessionId`), so a
 *    session that has been running for longer than the window still carries a
 *    stale value. Trusting it would delete a live session's runs, turns, and
 *    tool events — including activity from moments earlier — on the first sync
 *    after it closes. The predicate therefore also requires that no run, turn,
 *    tool event, or checkpoint under the session is newer than the cutoff.
 */
import { err, type IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import type { Database, Executor } from "../connection.js";
import { mapLibsqlError } from "../errors.js";
import { withTransaction } from "../transaction.js";

/**
 * Eligibility predicate, shared by the candidate listing, the recheck inside each
 * delete transaction, and the doctor count — so all three can never disagree.
 *
 * Takes `(repository_id, cutoff)` followed by six more `cutoff` binds; SQLite has
 * no named parameters through this driver, so the value is repeated per clause.
 */
const ELIGIBLE_PREDICATE = `
    s.repository_id = ?
    AND s.last_seen_at < ?
    AND NOT EXISTS (
      SELECT 1 FROM session_runs r
      WHERE r.session_id = s.id
        AND (r.status = 'active' OR r.started_at >= ? OR COALESCE(r.ended_at, '') >= ?)
    )
    AND NOT EXISTS (
      SELECT 1 FROM turns t
      JOIN session_runs r ON r.id = t.run_id
      WHERE r.session_id = s.id
        AND (t.started_at >= ? OR COALESCE(t.stopped_at, '') >= ?)
    )
    AND NOT EXISTS (
      SELECT 1 FROM tool_events e
      JOIN turns t ON t.id = e.turn_id
      JOIN session_runs r ON r.id = t.run_id
      WHERE r.session_id = s.id AND e.occurred_at >= ?
    )
    AND NOT EXISTS (
      SELECT 1 FROM checkpoints c
      WHERE c.session_id = s.id AND c.created_at >= ?
    )
    AND NOT EXISTS (SELECT 1 FROM canonical_documents cd WHERE cd.entity_id = s.id)
    AND NOT EXISTS (
      SELECT 1 FROM checkpoints c
      JOIN canonical_documents cd ON cd.entity_id = c.id
      WHERE c.session_id = s.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM candidates cand
      WHERE cand.source_session_id = s.id AND cand.status = 'pending'
    )
    AND NOT EXISTS (
      SELECT 1 FROM candidates cand
      JOIN checkpoints c ON c.id = cand.source_checkpoint_id
      WHERE c.session_id = s.id AND cand.status = 'pending'
    )
    AND NOT EXISTS (
      SELECT 1 FROM agent_sessions child
      WHERE child.parent_session_id = s.id
    )`;

/** `(repository_id, cutoff)` plus the six repeated `cutoff` binds. */
function eligibilityArgs(repositoryId: TypedId<"repo">, cutoff: string): string[] {
  return [repositoryId, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff];
}

/**
 * Sessions currently eligible for pruning, oldest first. Read-only and outside
 * any transaction: the result is a candidate list, and `pruneSession` re-checks
 * each one under the write lock before deleting it.
 */
export async function listPrunableSessions(
  db: Executor,
  repositoryId: TypedId<"repo">,
  cutoff: string,
): Promise<Result<string[], IrohaError>> {
  try {
    const result = await db.execute({
      sql: `SELECT s.id AS id FROM agent_sessions s
            WHERE ${ELIGIBLE_PREDICATE}
            ORDER BY s.last_seen_at`,
      args: eligibilityArgs(repositoryId, cutoff),
    });
    return ok(result.rows.map((row) => String(row.id)));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list prunable sessions"));
  }
}

export interface PrunedSession {
  /** Checkpoint entities deleted with the session. */
  checkpoints: number;
}

/**
 * The policy this sweep was authorized under, re-read inside each delete
 * transaction. Compared as opaque JSON: this layer does not interpret the
 * setting, it only refuses to delete once the stored value stops matching what
 * the caller planned against. `expectedValueJson` is `null` when the caller
 * planned against an absent row.
 */
export interface RetentionPolicyGuard {
  key: string;
  expectedValueJson: string | null;
}

/**
 * Deletes one aged session, re-checking its eligibility inside the same write
 * transaction. Returns `null` when the session no longer qualifies — a hook or
 * MCP tool may have written to it since it was listed.
 *
 * One transaction **per session**, not one for the whole sweep. `hooks.md` §10
 * records the measurement that forces this: a hook's write waits on libSQL's
 * 2500 ms `busy_timeout` while another process holds the write lock — 7932 ms
 * observed on a PreToolUse denial against a 0.5 s budget, after which the
 * platform kills the hook and an applicable Guardrail deny is lost. A sweep-wide
 * transaction would hold that lock across a whole backlog; per-session keeps it
 * to a few statements while still making selection and deletion atomic.
 *
 * Sessions are deleted through `entities`, not `agent_sessions`: the session row
 * is the *child* of its entity (`agent_sessions.id REFERENCES entities(id)`), so
 * deleting the session directly would leave the entity behind as an orphan.
 * Checkpoint entities are deleted first for the same reason — they would
 * otherwise be orphaned by the `checkpoints.session_id` cascade.
 */
export async function pruneSession(
  db: Database,
  repositoryId: TypedId<"repo">,
  cutoff: string,
  sessionId: string,
  policy: RetentionPolicyGuard,
): Promise<Result<PrunedSession | null, IrohaError>> {
  return withTransaction(db, "write", async (tx) => {
    try {
      // The guard is read in the same transaction as the eligibility check, so a
      // policy change committed on another connection cannot slip between the two
      // and let this session be deleted under a window the user has replaced.
      const guard = await tx.execute({
        sql: "SELECT value_json FROM local_settings WHERE repository_id = ? AND key = ?",
        args: [repositoryId, policy.key],
      });
      const storedJson = guard.rows[0]?.value_json;
      const current = storedJson === undefined || storedJson === null ? null : String(storedJson);
      if (current !== policy.expectedValueJson) {
        return ok(null);
      }

      const stillEligible = await tx.execute({
        sql: `SELECT 1 FROM agent_sessions s
              WHERE s.id = ? AND ${ELIGIBLE_PREDICATE}`,
        args: [sessionId, ...eligibilityArgs(repositoryId, cutoff)],
      });
      if (stillEligible.rows.length === 0) {
        return ok(null);
      }

      const deletedCheckpoints = await tx.execute({
        sql: `DELETE FROM entities WHERE id IN (
                SELECT c.id FROM checkpoints c WHERE c.session_id = ?
              )`,
        args: [sessionId],
      });
      await tx.execute({ sql: "DELETE FROM entities WHERE id = ?", args: [sessionId] });
      return ok({ checkpoints: Number(deletedCheckpoints.rowsAffected) });
    } catch (cause) {
      return err(mapLibsqlError(cause, "Failed to prune session"));
    }
  });
}

/**
 * Rows deleted per `pruneEventLog` statement. Bounded for the same reason the
 * session sweep is one transaction per session: a single unbounded `DELETE`
 * across an accumulated backlog holds the writer lock for as long as it takes,
 * which is exactly the condition `hooks.md` §10 measures at 7932 ms on a
 * PreToolUse denial — long enough for the platform to kill the hook and lose an
 * applicable Guardrail deny.
 */
const EVENT_LOG_DELETE_BATCH = 500;

/**
 * Deletes diagnostics rows older than `cutoff`, in bounded batches, returning the
 * total removed.
 *
 * Pruned by its own timestamp rather than with its session: `event_log`'s
 * `session_id` is `ON DELETE SET NULL`, so those rows survive a session delete
 * and would otherwise be the one table retention never bounds.
 *
 * Each batch is its own autocommit statement, so the writer lock is released
 * between them and a concurrent hook waits at most one batch.
 */
export async function pruneEventLog(
  db: Executor,
  repositoryId: TypedId<"repo">,
  cutoff: string,
): Promise<Result<number, IrohaError>> {
  let total = 0;
  try {
    for (;;) {
      // `DELETE ... LIMIT` needs a compile-time SQLite option that is not
      // guaranteed here, so the bound is applied by a subquery instead.
      const deleted = await db.execute({
        sql: `DELETE FROM event_log WHERE id IN (
                SELECT id FROM event_log
                WHERE repository_id = ? AND occurred_at < ?
                LIMIT ${EVENT_LOG_DELETE_BATCH}
              )`,
        args: [repositoryId, cutoff],
      });
      const removed = Number(deleted.rowsAffected);
      total += removed;
      if (removed < EVENT_LOG_DELETE_BATCH) {
        return ok(total);
      }
    }
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to prune event log"));
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
      const prunable = await listPrunableSessions(db, repositoryId, cutoff);
      if (!prunable.ok) {
        return prunable;
      }
      prunableSessions = prunable.value.length;
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
