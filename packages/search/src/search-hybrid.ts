import { type IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import { type Executor, searchByVector } from "@iroha/storage";
import {
  buildMatchQuery,
  CANDIDATE_LIMIT,
  DEFAULT_LIMIT,
  hydrateRankedRows,
  MAX_LIMIT,
  MIN_FTS_QUERY_LENGTH,
  queryByLike,
  queryFtsRanked,
  type RankedRow,
  RRF_K,
  TRIGRAM_WEIGHT,
  UNICODE_WEIGHT,
  VECTOR_WEIGHT,
} from "./fts-candidates.js";

export type SearchMode = "hybrid" | "lexical" | "vector" | "graph";
export type MatchSource = "unicode" | "trigram" | "vector";

/** database-schema.md §9's post-RRF boost multipliers. */
const AUTHORITY_FULL_MULTIPLIER = 1.25; // authority === 100 (approved canonical)
const AUTHORITY_HIGH_MULTIPLIER = 1.1; // authority 80–99 (verified Git/Forge)
/** Recency is a bounded tie-breaker only: ≤5% contribution, 180-day half-life. */
const RECENCY_MAX_BONUS = 0.05;
const RECENCY_HALF_LIFE_DAYS = 180;
const MS_PER_DAY = 86_400_000;

export interface SearchHybridOptions {
  query: string;
  /** Present only when embedding is configured and the query embedding succeeded. */
  queryVector?: readonly number[] | undefined;
  mode?: SearchMode | undefined;
  limit?: number | undefined;
  /** ISO-8601 timestamp for the recency tie-breaker (deterministic in tests). */
  now: string;
}

export interface SearchHybridHit {
  entityId: string;
  searchDocumentId: TypedId<"sdoc">;
  title: string;
  authority: number;
  score: number;
  /** Which candidate sources matched — drives `whyRelevant` enrichment (Slice 3). */
  matchedBy: MatchSource[];
}

function authorityMultiplier(authority: number): number {
  if (authority >= 100) {
    return AUTHORITY_FULL_MULTIPLIER;
  }
  if (authority >= 80) {
    return AUTHORITY_HIGH_MULTIPLIER;
  }
  return 1;
}

/**
 * Bounded recency nudge (database-schema.md §9): at most +5%, halving every 180
 * days, so it breaks near-ties without letting a fresh low-authority document
 * outrank a directly-applicable approved one. A future/equal `updatedAt` (or a
 * clock skew) yields the full 5%; an unparseable timestamp contributes nothing.
 */
function recencyFactor(updatedAt: string, now: string): number {
  const ageMs = Date.parse(now) - Date.parse(updatedAt);
  if (!Number.isFinite(ageMs)) {
    return 1;
  }
  const ageDays = Math.max(0, ageMs) / MS_PER_DAY;
  return 1 + RECENCY_MAX_BONUS * 2 ** (-ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * database-schema.md §9's hybrid retrieval: fuses unicode-FTS, trigram-FTS, and
 * (when a query vector is available) vector candidates with Reciprocal Rank
 * Fusion, then applies the authority multiplier and the recency tie-breaker.
 * `searchText` shares the same FTS/RRF primitives, so the lexical path and this
 * one never diverge; the vector term is simply added to the same sum ("missing
 * ranks contribute zero"). The scope/graph boosts and `mode="graph"` traversal
 * are layered on in Slice 3.
 */
export async function searchHybrid(
  db: Executor,
  options: SearchHybridOptions,
): Promise<Result<SearchHybridHit[], IrohaError>> {
  const trimmed = options.query.trim();
  const limit = Math.max(0, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const mode = options.mode ?? "hybrid";
  const useFts = mode !== "vector";
  const useVector = mode !== "lexical" && options.queryVector !== undefined;

  if (trimmed.length === 0 && !useVector) {
    return ok([]);
  }

  const rows = new Map<string, RankedRow>();
  const unicodeRanks = new Map<string, number>();
  const trigramRanks = new Map<string, number>();
  const vectorRanks = new Map<string, number>();

  if (useFts && trimmed.length > 0) {
    if ([...trimmed].length < MIN_FTS_QUERY_LENGTH) {
      // Short-query LIKE fallback: treat its authority/recency-ordered rows as
      // the unicode candidate set so the same RRF + boost pipeline applies.
      const likeResult = await queryByLike(db, trimmed);
      if (!likeResult.ok) {
        return likeResult;
      }
      likeResult.value.forEach((row, index) => {
        rows.set(row.entityId, row);
        unicodeRanks.set(row.entityId, index + 1);
      });
    } else {
      const matchQuery = buildMatchQuery(trimmed);
      const [unicodeResult, trigramResult] = await Promise.all([
        queryFtsRanked(db, "search_fts_unicode", matchQuery),
        queryFtsRanked(db, "search_fts_trigram", matchQuery),
      ]);
      if (!unicodeResult.ok) {
        return unicodeResult;
      }
      if (!trigramResult.ok) {
        return trigramResult;
      }
      unicodeResult.value.forEach((row, index) => {
        rows.set(row.entityId, row);
        unicodeRanks.set(row.entityId, index + 1);
      });
      trigramResult.value.forEach((row, index) => {
        rows.set(row.entityId, row);
        trigramRanks.set(row.entityId, index + 1);
      });
    }
  }

  if (useVector && options.queryVector !== undefined) {
    const vectorResult = await searchByVector(db, options.queryVector, CANDIDATE_LIMIT);
    if (!vectorResult.ok) {
      return vectorResult;
    }
    const missing: string[] = [];
    vectorResult.value.forEach((hit, index) => {
      vectorRanks.set(hit.entityId, index + 1);
      if (!rows.has(hit.entityId)) {
        missing.push(hit.entityId);
      }
    });
    const hydrated = await hydrateRankedRows(db, missing);
    if (!hydrated.ok) {
      return hydrated;
    }
    for (const row of hydrated.value) {
      rows.set(row.entityId, row);
    }
  }

  const hits: SearchHybridHit[] = [];
  for (const row of rows.values()) {
    const unicodeRank = unicodeRanks.get(row.entityId);
    const trigramRank = trigramRanks.get(row.entityId);
    const vectorRank = vectorRanks.get(row.entityId);
    // A hydrated vector row whose entity was later filtered (tombstoned) never
    // enters `rows`; but a vector rank can still reference an entity we chose
    // not to hydrate. Skip anything with no usable row-and-rank pairing.
    const matchedBy: MatchSource[] = [];
    if (unicodeRank !== undefined) {
      matchedBy.push("unicode");
    }
    if (trigramRank !== undefined) {
      matchedBy.push("trigram");
    }
    if (vectorRank !== undefined) {
      matchedBy.push("vector");
    }
    if (matchedBy.length === 0) {
      continue;
    }
    const rrf =
      (unicodeRank === undefined ? 0 : UNICODE_WEIGHT / (RRF_K + unicodeRank)) +
      (trigramRank === undefined ? 0 : TRIGRAM_WEIGHT / (RRF_K + trigramRank)) +
      (vectorRank === undefined ? 0 : VECTOR_WEIGHT / (RRF_K + vectorRank));
    const score =
      rrf * authorityMultiplier(row.authority) * recencyFactor(row.updatedAt, options.now);
    hits.push({
      entityId: row.entityId,
      searchDocumentId: row.searchDocumentId,
      title: row.title,
      authority: row.authority,
      score,
      matchedBy,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return ok(hits.slice(0, limit));
}
