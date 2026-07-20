import type { TypedId } from "@iroha/domain";
import { searchHybrid } from "@iroha/search";
import type { Database } from "@iroha/storage";
import { graphExpandedCandidates, type RankCandidate, rankCandidates } from "../mcp/ranking.js";
import { type FixtureQuery, QUERIES, type QueryClass } from "./fixture.js";
import { type AggregateMetrics, aggregate } from "./metrics.js";

/** All fixture docs share one timestamp, so recency is uniform and never distorts ordering. */
const EVAL_NOW = "2026-06-01T00:00:00.000Z";
const RESULT_LIMIT = 10;
const MINIMUM_AUTHORITY = 60;

export interface EvalReport {
  queryCount: number;
  overall: AggregateMetrics;
  perClass: Record<QueryClass, AggregateMetrics>;
  /** Recall@10 over the (query, applicable-rule) pairs — the Guardrail-rule gate. */
  ruleRecallAt10: number;
}

const QUERY_CLASSES: QueryClass[] = ["ja-nl", "en-nl", "code", "relationship"];

async function rankedIdsFor(
  db: Database,
  repositoryId: TypedId<"repo">,
  query: FixtureQuery,
  queryVector: number[] | undefined,
): Promise<string[]> {
  // Relationship intent uses graph mode: lexical seeds expanded along the
  // relation graph (mirrors mcpSearch mode="graph"). Everything else uses the
  // hybrid path with the recorded query vector.
  const useGraph = query.class === "relationship";
  const searchMode = useGraph || queryVector === undefined ? "lexical" : "hybrid";
  const hits = await searchHybrid(db, {
    query: query.text,
    queryVector,
    mode: searchMode,
    now: EVAL_NOW,
  });
  if (!hits.ok) {
    throw new Error(`searchHybrid failed for ${query.id}: ${hits.error.message}`);
  }
  let candidates: RankCandidate[] = hits.value.map((hit) => ({
    entityId: hit.entityId,
    baseScore: hit.score,
    matchedBy: hit.matchedBy,
  }));
  if (useGraph) {
    const expanded = await graphExpandedCandidates(db, candidates);
    if (!expanded.ok) {
      throw new Error(`graph expansion failed for ${query.id}: ${expanded.error.message}`);
    }
    candidates = expanded.value;
  }
  const ranked = await rankCandidates(db, repositoryId, candidates, {
    scope: {
      paths: query.scope?.paths ?? [],
      symbols: query.scope?.symbols ?? [],
      issueRefs: query.scope?.issueRefs ?? [],
    },
    filters: { minimumAuthority: MINIMUM_AUTHORITY },
    limit: RESULT_LIMIT,
    includeBody: false,
  });
  if (!ranked.ok) {
    throw new Error(`rankCandidates failed for ${query.id}: ${ranked.error.message}`);
  }
  return ranked.value.map((result) => result.entity.id);
}

/**
 * Runs every fixture query through the real hybrid pipeline (with recorded query
 * vectors) and returns the aggregate ranking metrics plus the Guardrail-rule
 * recall (database-schema.md §14). Fully offline and deterministic.
 */
export async function runEval(
  db: Database,
  repositoryId: TypedId<"repo">,
  queryVectors: Record<string, number[]>,
): Promise<EvalReport> {
  const perQuery: Array<{ cls: QueryClass; ranked: string[]; relevant: Set<string> }> = [];
  const ruleHits: number[] = [];

  for (const query of QUERIES) {
    const ranked = await rankedIdsFor(db, repositoryId, query, queryVectors[query.id]);
    perQuery.push({ cls: query.class, ranked, relevant: new Set(query.relevant) });
    if (query.applicableRuleIds !== undefined) {
      const top = ranked.slice(0, RESULT_LIMIT);
      for (const ruleId of query.applicableRuleIds) {
        ruleHits.push(top.includes(ruleId) ? 1 : 0);
      }
    }
  }

  const overall = aggregate(perQuery.map((p) => ({ ranked: p.ranked, relevant: p.relevant })));
  const perClass = {} as Record<QueryClass, AggregateMetrics>;
  for (const cls of QUERY_CLASSES) {
    perClass[cls] = aggregate(
      perQuery
        .filter((p) => p.cls === cls)
        .map((p) => ({ ranked: p.ranked, relevant: p.relevant })),
    );
  }
  const ruleRecallAt10 =
    ruleHits.length === 0 ? 1 : ruleHits.reduce((sum, hit) => sum + hit, 0) / ruleHits.length;

  return { queryCount: QUERIES.length, overall, perClass, ruleRecallAt10 };
}
