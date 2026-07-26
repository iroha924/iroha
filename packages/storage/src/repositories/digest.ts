import { err, type IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import type { Executor } from "../connection.js";
import { mapLibsqlError } from "../errors.js";
import { nullableString } from "../row-helpers.js";
import { KNOWLEDGE_ENTITY_TYPES, type KnowledgeEntityType } from "./dashboard.js";
import type { CheckpointOutcome } from "./sessions.js";

/** The four Checkpoint outcomes, so the breakdown always reports every one. */
const CHECKPOINT_OUTCOMES = ["completed", "partial", "blocked", "no_change"] as const;

/**
 * Caps on the item lists a Digest window returns. The editorial page shows a
 * handful of each; a period with hundreds would be a rendering problem, not a
 * more informative issue. The caller is told when a list was cut (`truncated`)
 * so the page can say so rather than silently implying it saw everything.
 */
const MAX_LIST_ITEMS = 20;

/** A half-open instant range `[start, end)`, both RFC 3339 UTC. */
export interface DigestWindow {
  start: string;
  end: string;
}

export interface DigestDenialByRule {
  /** `null` for a denial recorded before the Rule attribution existed (migrations/005). */
  ruleId: string | null;
  /** `null` when the Rule is unattributed, or its entity is no longer present. */
  ruleTitle: string | null;
  count: number;
}

export interface DigestDenialTarget {
  /** The repo-relative POSIX path that violated a Guardrail (`tool_events.target_summary`). */
  path: string;
  count: number;
}

export interface DigestKnowledgeRef {
  id: string;
  title: string;
  summary: string | null;
}

export interface DigestList<T> {
  items: T[];
  /** Whether `MAX_LIST_ITEMS` cut the list short. */
  truncated: boolean;
}

/**
 * Everything the Digest reports for one period, split by the two scopes of
 * `.claude/rules/digest-scopes.md`: `denials`/`checkpoints`/`sessions` are
 * **local** (this clone's disposable index state), while `approvedKnowledge`/
 * `guardrailsChanged`/`promotedReviewLearnings` are **team** — windowed by
 * `knowledge_items.approved_at`, which travels in the canonical frontmatter, so
 * every teammate's rebuild yields the same numbers for the same period.
 *
 * Carries no actor, author, or session-owner field anywhere. That is what makes
 * it safe to hand to an agent verbatim (`get_digest_data`): person-level
 * narration is impossible because the person data never arrives.
 */
export interface DigestWindowFacts {
  denials: {
    total: number;
    byRule: DigestDenialByRule[];
    targets: DigestList<DigestDenialTarget>;
  };
  checkpoints: {
    total: number;
    byOutcome: Record<CheckpointOutcome, number>;
  };
  /** Distinct Sessions that started a Run in the window. */
  sessions: number;
  approvedKnowledge: {
    total: number;
    byType: Record<KnowledgeEntityType, number>;
  };
  guardrailsChanged: DigestList<DigestKnowledgeRef>;
  promotedReviewLearnings: DigestList<DigestKnowledgeRef>;
}

function toList<T>(rows: T[]): DigestList<T> {
  return { items: rows.slice(0, MAX_LIST_ITEMS), truncated: rows.length > MAX_LIST_ITEMS };
}

function toKnowledgeRef(row: Record<string, unknown>): DigestKnowledgeRef {
  return {
    id: String(row.id),
    title: String(row.title),
    summary: nullableString(row.summary),
  };
}

/**
 * A denial's Rule attribution and its target path both live on `tool_events`,
 * whose only route to a repository is `turns` → `session_runs` →
 * `agent_sessions`. Kept as one fragment so the two denial aggregates below
 * cannot drift on which rows they consider "this repository's".
 */
const DENIALS_FROM = `FROM tool_events e
    JOIN turns t ON t.id = e.turn_id
    JOIN session_runs r ON r.id = t.run_id
    JOIN agent_sessions s ON s.id = r.session_id`;

const DENIALS_WHERE = `WHERE s.repository_id = ? AND e.status = 'denied'
     AND e.occurred_at >= ? AND e.occurred_at < ?`;

/**
 * Approved knowledge, windowed by the timestamp a human approved it. `entities`
 * carries the type and title; `knowledge_items` carries `approved_at` and
 * `enforcement`. Both filters are needed: `status = 'approved'` excludes a
 * tombstoned document whose `approved_at` is still set.
 */
const APPROVED_IN_WINDOW = `FROM knowledge_items k
    JOIN entities en ON en.id = k.id
   WHERE en.repository_id = ? AND en.status = 'approved'
     AND k.approved_at >= ? AND k.approved_at < ?`;

/**
 * Compute one period's Digest facts. Six independent aggregates, run
 * concurrently against a plain read executor (never a transaction — a period
 * read must not hold the write lock, which is the same reason the hook path
 * writes no diagnostics row).
 *
 * Every list is ordered deterministically, with an id tie-breaker after the
 * ranking column: two runs over unchanged data must produce the same issue,
 * because prose composed against one ordering is read against the next.
 */
export async function getDigestWindowFacts(
  db: Executor,
  repositoryId: TypedId<"repo">,
  window: DigestWindow,
): Promise<Result<DigestWindowFacts, IrohaError>> {
  const denialArgs = [repositoryId, window.start, window.end];
  const approvedArgs = [repositoryId, window.start, window.end];
  try {
    const [byRule, targets, checkpoints, sessions, approved, guardrails, learnings] =
      await Promise.all([
        db.execute({
          sql: `SELECT e.denied_by_rule_id AS rule_id, ken.title AS rule_title, COUNT(*) AS c
                  ${DENIALS_FROM}
                  LEFT JOIN entities ken ON ken.id = e.denied_by_rule_id
                 ${DENIALS_WHERE}
                GROUP BY e.denied_by_rule_id, ken.title
                ORDER BY c DESC, rule_id`,
          args: denialArgs,
        }),
        db.execute({
          sql: `SELECT e.target_summary AS path, COUNT(*) AS c
                  ${DENIALS_FROM} ${DENIALS_WHERE} AND e.target_summary IS NOT NULL
                GROUP BY e.target_summary
                ORDER BY c DESC, path
                LIMIT ?`,
          args: [...denialArgs, MAX_LIST_ITEMS + 1],
        }),
        db.execute({
          sql: `SELECT c.outcome, COUNT(*) AS c FROM checkpoints c
                  JOIN agent_sessions s ON s.id = c.session_id
                 WHERE s.repository_id = ? AND c.created_at >= ? AND c.created_at < ?
                GROUP BY c.outcome`,
          args: [repositoryId, window.start, window.end],
        }),
        db.execute({
          sql: `SELECT COUNT(DISTINCT r.session_id) AS c FROM session_runs r
                  JOIN agent_sessions s ON s.id = r.session_id
                 WHERE s.repository_id = ? AND r.started_at >= ? AND r.started_at < ?`,
          args: [repositoryId, window.start, window.end],
        }),
        db.execute({
          sql: `SELECT en.entity_type, COUNT(*) AS c
                  ${APPROVED_IN_WINDOW}
                    AND en.entity_type IN (${KNOWLEDGE_ENTITY_TYPES.map(() => "?").join(", ")})
                GROUP BY en.entity_type`,
          args: [...approvedArgs, ...KNOWLEDGE_ENTITY_TYPES],
        }),
        db.execute({
          sql: `SELECT en.id, en.title, en.summary
                  ${APPROVED_IN_WINDOW} AND k.enforcement = 'guardrail'
                ORDER BY k.approved_at DESC, en.id
                LIMIT ?`,
          args: [...approvedArgs, MAX_LIST_ITEMS + 1],
        }),
        db.execute({
          sql: `SELECT en.id, en.title, en.summary
                  ${APPROVED_IN_WINDOW} AND k.knowledge_type = 'review_learning'
                ORDER BY k.approved_at DESC, en.id
                LIMIT ?`,
          args: [...approvedArgs, MAX_LIST_ITEMS + 1],
        }),
      ]);

    const byOutcome = Object.fromEntries(CHECKPOINT_OUTCOMES.map((o) => [o, 0])) as Record<
      CheckpointOutcome,
      number
    >;
    let checkpointTotal = 0;
    for (const row of checkpoints.rows) {
      const outcome = String(row.outcome);
      const count = Number(row.c ?? 0);
      if (outcome in byOutcome) {
        byOutcome[outcome as CheckpointOutcome] = count;
        checkpointTotal += count;
      }
    }

    const byType = Object.fromEntries(KNOWLEDGE_ENTITY_TYPES.map((t) => [t, 0])) as Record<
      KnowledgeEntityType,
      number
    >;
    let approvedTotal = 0;
    for (const row of approved.rows) {
      const type = String(row.entity_type);
      const count = Number(row.c ?? 0);
      if (type in byType) {
        byType[type as KnowledgeEntityType] = count;
        approvedTotal += count;
      }
    }

    const denialsByRule = byRule.rows.map((row) => ({
      ruleId: nullableString(row.rule_id),
      ruleTitle: nullableString(row.rule_title),
      count: Number(row.c ?? 0),
    }));

    return ok({
      denials: {
        total: denialsByRule.reduce((sum, row) => sum + row.count, 0),
        byRule: denialsByRule,
        targets: toList(
          targets.rows.map((row) => ({ path: String(row.path), count: Number(row.c ?? 0) })),
        ),
      },
      checkpoints: { total: checkpointTotal, byOutcome },
      sessions: Number(sessions.rows[0]?.c ?? 0),
      approvedKnowledge: { total: approvedTotal, byType },
      guardrailsChanged: toList(guardrails.rows.map(toKnowledgeRef)),
      promotedReviewLearnings: toList(learnings.rows.map(toKnowledgeRef)),
    });
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to compute digest window facts"));
  }
}

export interface DigestIssueRow {
  periodUnit: string;
  periodKey: string;
  proseJson: string;
  composedAt: string;
}

export interface UpsertDigestIssueInput {
  repositoryId: TypedId<"repo">;
  periodUnit: string;
  periodKey: string;
  proseJson: string;
  composedAt: string;
}

/** The composed prose for one period, or `null` when the issue has none yet. */
export async function getDigestIssue(
  db: Executor,
  repositoryId: TypedId<"repo">,
  periodUnit: string,
  periodKey: string,
): Promise<Result<DigestIssueRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: `SELECT period_unit, period_key, prose_json, composed_at FROM digest_issues
             WHERE repository_id = ? AND period_unit = ? AND period_key = ?`,
      args: [repositoryId, periodUnit, periodKey],
    });
    const row = result.rows[0];
    if (row === undefined) {
      return ok(null);
    }
    return ok({
      periodUnit: String(row.period_unit),
      periodKey: String(row.period_key),
      proseJson: String(row.prose_json),
      composedAt: String(row.composed_at),
    });
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read digest issue"));
  }
}

/**
 * Replace the prose for one period. Recomposing an issue overwrites it rather
 * than accumulating versions: the numbers are recomputed on every read, so an
 * older narration of the same period is stale by construction, not history worth
 * keeping.
 */
export async function upsertDigestIssue(
  db: Executor,
  input: UpsertDigestIssueInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO digest_issues (repository_id, period_unit, period_key, prose_json, composed_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (repository_id, period_unit, period_key)
            DO UPDATE SET prose_json = excluded.prose_json, composed_at = excluded.composed_at`,
      args: [
        input.repositoryId,
        input.periodUnit,
        input.periodKey,
        input.proseJson,
        input.composedAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to store digest issue"));
  }
}

/**
 * Pending `review_learning` Candidates — the Digest's "you might be missing a
 * Rule" signal.
 *
 * This is deliberately a count of what `detectReviewLearnings` already found,
 * not a second pass over `review_comments`. That detector runs the recurrence
 * grouping on every Forge sync and files a Candidate for each recurrence it
 * judges durable; re-deriving the same recurrence here would be a parallel
 * implementation free to disagree with the queue the human actually reviews.
 * Reading the Candidates instead means the Digest reports exactly what iroha
 * detected.
 *
 * Local, not team: `review_comments` are synced per clone and depend on who ran
 * `iroha sync`, so this number is not identical across teammates.
 */
export async function countPendingReviewLearnings(
  db: Executor,
  repositoryId: TypedId<"repo">,
): Promise<Result<number, IrohaError>> {
  try {
    const result = await db.execute({
      sql: `SELECT COUNT(*) AS c FROM candidates
             WHERE repository_id = ? AND candidate_type = 'review_learning' AND status = 'pending'`,
      args: [repositoryId],
    });
    return ok(Number(result.rows[0]?.c ?? 0));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to count pending review learnings"));
  }
}
