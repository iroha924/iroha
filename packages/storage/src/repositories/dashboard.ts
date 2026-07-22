import { err, type IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import type { Executor } from "../connection.js";
import { mapLibsqlError } from "../errors.js";
import { nullableString } from "../row-helpers.js";

/** Scalar aggregates for the dashboard Overview page (`GET /api/v1/overview`). */
export interface OverviewCounts {
  pendingCandidates: number;
  oldestPendingCreatedAt: string | null;
  approvedKnowledge: number;
  sessions: number;
}

/**
 * Computes the Overview page counts in three small aggregate queries (no per-row
 * fetch). "Approved knowledge" counts only the seven canonical knowledge
 * `entity_type`s at `status = 'approved'`, matching `listKnowledgeEntities`.
 */
export async function getOverviewCounts(
  db: Executor,
  repositoryId: TypedId<"repo">,
): Promise<Result<OverviewCounts, IrohaError>> {
  try {
    // Three independent aggregates over different tables — run concurrently
    // rather than as three sequential round-trips. This is a plain read
    // executor (not a transaction), so concurrent `execute` is safe.
    const [pending, knowledge, sessions] = await Promise.all([
      db.execute({
        sql: "SELECT COUNT(*) AS c, MIN(created_at) AS oldest FROM candidates WHERE repository_id = ? AND status = 'pending'",
        args: [repositoryId],
      }),
      db.execute({
        sql: `SELECT COUNT(*) AS c FROM entities
        WHERE repository_id = ? AND status = 'approved'
          AND entity_type IN ('decision', 'rule', 'concept', 'insight', 'incident', 'pattern', 'review_learning')`,
        args: [repositoryId],
      }),
      db.execute({
        sql: "SELECT COUNT(*) AS c FROM agent_sessions WHERE repository_id = ?",
        args: [repositoryId],
      }),
    ]);
    return ok({
      pendingCandidates: Number(pending.rows[0]?.c ?? 0),
      oldestPendingCreatedAt: nullableString(pending.rows[0]?.oldest),
      approvedKnowledge: Number(knowledge.rows[0]?.c ?? 0),
      sessions: Number(sessions.rows[0]?.c ?? 0),
    });
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to compute overview counts"));
  }
}
