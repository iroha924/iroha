import { err, type IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import type { Executor } from "../connection.js";
import { mapLibsqlError } from "../errors.js";
import { nullableString } from "../row-helpers.js";

/**
 * The seven canonical knowledge `entity_type`s at `status = 'approved'` (matching
 * `listKnowledgeEntities`). Kept as one list so the SQL filter and the by-type
 * breakdown below never drift apart.
 */
const KNOWLEDGE_ENTITY_TYPES = [
  "decision",
  "rule",
  "concept",
  "insight",
  "incident",
  "pattern",
  "review_learning",
] as const;

export type KnowledgeEntityType = (typeof KNOWLEDGE_ENTITY_TYPES)[number];

/** Scalar aggregates for the dashboard Overview page (`GET /api/v1/overview`). */
export interface OverviewCounts {
  pendingCandidates: number;
  oldestPendingCreatedAt: string | null;
  approvedKnowledge: number;
  /** Approved-knowledge composition by canonical type (every type present, 0 when empty). */
  approvedKnowledgeByType: Record<KnowledgeEntityType, number>;
  sessions: number;
}

/**
 * Computes the Overview page counts in three small aggregate queries (no per-row
 * fetch). "Approved knowledge" counts only the seven canonical knowledge
 * `entity_type`s at `status = 'approved'`; a single `GROUP BY` yields both the
 * total and the per-type breakdown that feeds the Overview composition chart.
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
        sql: `SELECT entity_type, COUNT(*) AS c FROM entities
        WHERE repository_id = ? AND status = 'approved'
          AND entity_type IN (${KNOWLEDGE_ENTITY_TYPES.map(() => "?").join(", ")})
        GROUP BY entity_type`,
        args: [repositoryId, ...KNOWLEDGE_ENTITY_TYPES],
      }),
      db.execute({
        sql: "SELECT COUNT(*) AS c FROM agent_sessions WHERE repository_id = ?",
        args: [repositoryId],
      }),
    ]);

    const byType = Object.fromEntries(KNOWLEDGE_ENTITY_TYPES.map((t) => [t, 0])) as Record<
      KnowledgeEntityType,
      number
    >;
    let approvedKnowledge = 0;
    for (const row of knowledge.rows) {
      const type = String(row.entity_type);
      const count = Number(row.c ?? 0);
      if (type in byType) {
        byType[type as KnowledgeEntityType] = count;
        approvedKnowledge += count;
      }
    }

    return ok({
      pendingCandidates: Number(pending.rows[0]?.c ?? 0),
      oldestPendingCreatedAt: nullableString(pending.rows[0]?.oldest),
      approvedKnowledge,
      approvedKnowledgeByType: byType,
      sessions: Number(sessions.rows[0]?.c ?? 0),
    });
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to compute overview counts"));
  }
}
