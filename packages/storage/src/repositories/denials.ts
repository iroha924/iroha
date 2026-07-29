import { err, type IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import type { Executor } from "../connection.js";
import { mapLibsqlError } from "../errors.js";
import { nullableString } from "../row-helpers.js";

/** A half-open instant range `[start, end)`, both RFC 3339 UTC. */
export interface DenialWindow {
  start: string;
  end: string;
}

export interface DenialByRule {
  /** `null` for a denial recorded before the Rule attribution existed (migrations/005). */
  ruleId: string | null;
  /** `null` when the Rule is unattributed, or its entity is no longer present. */
  ruleTitle: string | null;
  count: number;
}

export interface DenialTarget {
  /** The repo-relative POSIX path that violated a Guardrail (`tool_events.target_summary`). */
  path: string;
  count: number;
}

export interface DenialFacts {
  total: number;
  byRule: DenialByRule[];
  /**
   * Every denied path, uncapped. Cluster aggregation reads this: grouping a
   * capped list under-reports each cluster while the denial total stays right, so
   * the page would show clusters summing to less than the total with nothing to
   * explain the gap. One window's denials are naturally few.
   */
  targets: DenialTarget[];
}

/**
 * A denial's Rule attribution and its target path both live on `tool_events`,
 * whose only route to a repository is `turns` → `session_runs` →
 * `agent_sessions`. Kept as one fragment so the two aggregates below cannot drift
 * on which rows they consider "this repository's".
 */
const DENIALS_FROM = `FROM tool_events e
    JOIN turns t ON t.id = e.turn_id
    JOIN session_runs r ON r.id = t.run_id
    JOIN agent_sessions s ON s.id = r.session_id`;

const DENIALS_WHERE = `WHERE s.repository_id = ? AND e.status = 'denied'
     AND e.occurred_at >= ? AND e.occurred_at < ?`;

/**
 * Whether a failure is a database that predates migration 005. The hook, the MCP
 * server, and the dashboard all open the database *without* migrating — only
 * `init`/`sync`/`doctor --repair` do (contracts/database.md §3) — so between a
 * package upgrade and the next sync these reads run against the older schema.
 * Without this the front page turns a pending migration into a 500 with no hint.
 */
function isMissingDeniedRuleColumn(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /no such column/i.test(message) && /denied_by_rule_id/i.test(message);
}

/**
 * Guardrail denials in one window, attributed to the Rule that produced each and
 * to the path it was raised on — the two aggregates the Overview page reports.
 *
 * Run against a plain read executor, never a transaction: a page read must not
 * hold the write lock, the same reason the hook path writes no diagnostics row
 * (`hooks.md` §10 measured a hook write waiting 7932 ms against a 0.5 s budget,
 * after which the platform kills the hook and the Guardrail deny is lost).
 *
 * The cost of that is real and accepted: the two aggregates are separate reads,
 * so a denial committed between them lands in one and not the other, and a
 * single response can briefly show clusters summing past the rule totals. It
 * corrects itself on the next five-second poll. Trading a lost Guardrail deny —
 * a decision that never runs — for a self-healing display skew on a page nobody
 * reads to the digit is not a trade this repository will make. Do not "fix" this
 * by wrapping the two in a read transaction.
 *
 * Both lists are ordered deterministically with an id tie-breaker after the
 * ranking column, so two runs over unchanged data render the same page.
 */
export async function getDenialFacts(
  db: Executor,
  repositoryId: TypedId<"repo">,
  window: DenialWindow,
): Promise<Result<DenialFacts, IrohaError>> {
  const args = [repositoryId, window.start, window.end];
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
    const [byRule, targets] = await Promise.all([
      db.execute({ sql: byRuleSql("e.denied_by_rule_id"), args }).catch((cause: unknown) => {
        if (isMissingDeniedRuleColumn(cause)) {
          return db.execute({ sql: byRuleSql("NULL"), args });
        }
        throw cause;
      }),
      db.execute({
        sql: `SELECT e.target_summary AS path, COUNT(*) AS c
                  ${DENIALS_FROM} ${DENIALS_WHERE} AND e.target_summary IS NOT NULL
                GROUP BY e.target_summary
                ORDER BY c DESC, path`,
        args,
      }),
    ]);

    const rules = byRule.rows.map((row) => ({
      ruleId: nullableString(row.rule_id),
      ruleTitle: nullableString(row.rule_title),
      count: Number(row.c ?? 0),
    }));
    return ok({
      total: rules.reduce((sum, row) => sum + row.count, 0),
      byRule: rules,
      targets: targets.rows.map((row) => ({
        path: String(row.path),
        count: Number(row.c ?? 0),
      })),
    });
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read denial facts"));
  }
}

/**
 * Pending `review_learning` Candidates — "you might be missing a Rule". Both
 * producers count: recurrences Forge detected, and lessons an agent proposed from
 * a Checkpoint.
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
