import { err, type IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import type { Executor } from "../connection.js";
import { mapLibsqlError } from "../errors.js";
import { nullableString } from "../row-helpers.js";
import { KNOWLEDGE_ENTITY_TYPES, type KnowledgeEntityType } from "./dashboard.js";
import type { CheckpointOutcome } from "./sessions.js";

/** The four Checkpoint outcomes, so the breakdown always reports every one. */
const CHECKPOINT_OUTCOMES = ["completed", "partial", "blocked", "no_change"] as const;

/**
 * How many items of a list a Digest window returns. The editorial page shows a
 * handful of each; a period with hundreds would be a rendering problem, not a
 * more informative issue.
 *
 * The cap bounds the *items*, never the reported `total` — that comes from its own
 * uncapped `COUNT(*)`. Deriving a count from a truncated list is how
 * `team.guardrailsChanged.total` came to report 20 for a period with 25 approvals,
 * a wrong number the composing agent could cite as authoritative.
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
  /** At most `MAX_LIST_ITEMS`, for display. */
  items: T[];
  /** The uncapped count — what a fact about this list must report. */
  total: number;
  /** Whether the cap cut `items` short; always `total > items.length`. */
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
    /** Capped for display, with the true distinct-path count in `total`. */
    targets: DigestList<DigestDenialTarget>;
    /**
     * Every denied path, uncapped. Cluster aggregation reads this, not `targets`:
     * grouping a capped list under-reports each cluster while the (uncapped)
     * denial total stays right, so the page would show clusters summing to less
     * than the total with nothing to explain the gap.
     */
    allTargets: DigestDenialTarget[];
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

function toList<T>(rows: T[], total: number): DigestList<T> {
  const items = rows.slice(0, MAX_LIST_ITEMS);
  return { items, total, truncated: total > items.length };
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
 * Whether a failure is a database that predates one of this feature's migrations.
 * The hook, the MCP server, and the dashboard all open the database *without*
 * migrating — only `init`/`sync`/`doctor --repair` do (contracts/database.md §3) —
 * so between a package upgrade and the next sync the reads below run against the
 * older schema. `listApprovedRulesForRepository` handles the same window for
 * migration 004's `severity`; the Digest matters more, because it is the front
 * page: without this it turns a pending migration into a 500 with no hint.
 */
function isMissingDeniedRuleColumn(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /no such column/i.test(message) && /denied_by_rule_id/i.test(message);
}

function isMissingDigestIssuesTable(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /no such table/i.test(message) && /digest_issues/i.test(message);
}

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
 * Compute one period's Digest facts. Seven independent aggregates, run
 * concurrently against a plain read executor (never a transaction — a period
 * read must not hold the write lock, which is the same reason the hook path
 * writes no diagnostics row).
 *
 * The three list queries carry no `LIMIT`; `toList` caps what is *shown* and
 * reports the real count. Two reasons: a count taken from a capped list is
 * wrong (and gets cited as a fact), and the denial-path list feeds cluster
 * aggregation, which under-reports if it only ever sees the first 20 paths. All
 * three sets are naturally small — one period's denials and one period's
 * approvals — so fetching them whole costs less than a second counting query per
 * list would.
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
  /**
   * Before migration 005 there is no attribution to read, so every denial falls
   * into the one unattributed group — the same shape a denial recorded before the
   * column existed already produces, and honest: the counts are right and the
   * attribution is genuinely unknown.
   */
  const byRuleSql = (attribution: string) => `SELECT ${attribution} AS rule_id,
                  ken.title AS rule_title, COUNT(*) AS c
                  ${DENIALS_FROM}
                  LEFT JOIN entities ken ON ken.id = ${attribution}
                 ${DENIALS_WHERE}
                GROUP BY ${attribution}, ken.title
                ORDER BY c DESC, rule_id`;
  try {
    const [byRule, targets, checkpoints, sessions, approved, guardrails, learnings] =
      await Promise.all([
        db
          .execute({ sql: byRuleSql("e.denied_by_rule_id"), args: denialArgs })
          .catch((cause: unknown) => {
            if (isMissingDeniedRuleColumn(cause)) {
              return db.execute({ sql: byRuleSql("NULL"), args: denialArgs });
            }
            throw cause;
          }),
        db.execute({
          sql: `SELECT e.target_summary AS path, COUNT(*) AS c
                  ${DENIALS_FROM} ${DENIALS_WHERE} AND e.target_summary IS NOT NULL
                GROUP BY e.target_summary
                ORDER BY c DESC, path`,
          args: denialArgs,
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
                ORDER BY k.approved_at DESC, en.id`,
          args: approvedArgs,
        }),
        db.execute({
          sql: `SELECT en.id, en.title, en.summary
                  ${APPROVED_IN_WINDOW} AND k.knowledge_type = 'review_learning'
                ORDER BY k.approved_at DESC, en.id`,
          args: approvedArgs,
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

    const denialTargets = targets.rows.map((row) => ({
      path: String(row.path),
      count: Number(row.c ?? 0),
    }));
    const guardrailRefs = guardrails.rows.map(toKnowledgeRef);
    const learningRefs = learnings.rows.map(toKnowledgeRef);

    return ok({
      denials: {
        total: denialsByRule.reduce((sum, row) => sum + row.count, 0),
        byRule: denialsByRule,
        targets: toList(denialTargets, denialTargets.length),
        // Uncapped, so cluster aggregation sees every denied path.
        allTargets: denialTargets,
      },
      checkpoints: { total: checkpointTotal, byOutcome },
      sessions: Number(sessions.rows[0]?.c ?? 0),
      approvedKnowledge: { total: approvedTotal, byType },
      guardrailsChanged: toList(guardrailRefs, guardrailRefs.length),
      promotedReviewLearnings: toList(learningRefs, learningRefs.length),
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
  /** The narrated period's exclusive end — what retention ages the issue out on. */
  periodEnd: string;
  proseJson: string;
  composedAt: string;
}

/**
 * The composed prose for one period, or `null` when the issue has none yet.
 *
 * A database from before migration 006 has no table to read, which is reported as
 * `null` — indistinguishable from "not composed yet", which is exactly what it
 * means. See `isMissingDeniedRuleColumn` for why the pre-migration window exists.
 */
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
    if (isMissingDigestIssuesTable(cause)) {
      return ok(null);
    }
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
      sql: `INSERT INTO digest_issues (repository_id, period_unit, period_key, period_end, prose_json, composed_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (repository_id, period_unit, period_key)
            DO UPDATE SET period_end = excluded.period_end,
                          prose_json = excluded.prose_json,
                          composed_at = excluded.composed_at`,
      args: [
        input.repositoryId,
        input.periodUnit,
        input.periodKey,
        input.periodEnd,
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
 * Delete composed issues older than `cutoff`, returning how many went.
 *
 * Retention is a privacy control whose purpose is deliberate deletion, and an
 * issue outlives the data it narrates: once a sweep removes the sessions behind
 * "{{local.denials.total}} denials, all in packages/git", the surviving prose
 * renders "0 denials, all in packages/git" — an unreviewed claim about evidence
 * that is gone. Pruning the issue with the window it describes keeps the two in
 * step, and costs nothing: prose is regenerable with `/iroha:digest`.
 *
 * Aged on `period_end`, not `composed_at`. A composition written *today* for a
 * ten-week-old back issue has a recent `composed_at`, so it would survive a
 * 30-day window by weeks while its own period's data was already deleted — which
 * is exactly the state this prune exists to prevent.
 */
export async function pruneDigestIssues(
  db: Executor,
  repositoryId: TypedId<"repo">,
  cutoff: string,
): Promise<Result<number, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "DELETE FROM digest_issues WHERE repository_id = ? AND period_end < ?",
      args: [repositoryId, cutoff],
    });
    return ok(Number(result.rowsAffected ?? 0));
  } catch (cause) {
    if (isMissingDigestIssuesTable(cause)) {
      return ok(0);
    }
    return err(mapLibsqlError(cause, "Failed to prune digest issues"));
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
