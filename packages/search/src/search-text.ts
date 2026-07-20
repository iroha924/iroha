import { type IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import type { Executor } from "@iroha/storage";
import {
  buildMatchQuery,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MIN_FTS_QUERY_LENGTH,
  queryByLike,
  queryFtsRanked,
  type RankedRow,
  RRF_K,
  TRIGRAM_WEIGHT,
  UNICODE_WEIGHT,
} from "./fts-candidates.js";

export interface SearchTextHit {
  entityId: string;
  searchDocumentId: TypedId<"sdoc">;
  title: string;
  authority: number;
  score: number;
}

export interface SearchTextOptions {
  /** database-schema.md §10: "MCP search response default: 10 results; maximum 50." */
  limit?: number;
}

function toHit(row: RankedRow, score: number): SearchTextHit {
  return {
    entityId: row.entityId,
    searchDocumentId: row.searchDocumentId,
    title: row.title,
    authority: row.authority,
    score,
  };
}

/**
 * FTS-only slice of database-schema.md §9's Reciprocal Rank Fusion (unicode +
 * trigram terms). The vector term and the authority/scope/graph boosts live in
 * `searchHybrid` (this shares the candidate/RRF primitives via
 * `fts-candidates.ts`, so the two never diverge). This offline lexical path
 * powers `iroha search` and the fully-degraded fallback: no embedding provider
 * or network call is involved.
 */
export async function searchText(
  db: Executor,
  query: string,
  options: SearchTextOptions = {},
): Promise<Result<SearchTextHit[], IrohaError>> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return ok([]);
  }
  const limit = Math.max(0, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));

  if ([...trimmed].length < MIN_FTS_QUERY_LENGTH) {
    const likeResult = await queryByLike(db, trimmed);
    if (!likeResult.ok) {
      return likeResult;
    }
    return ok(likeResult.value.slice(0, limit).map((row) => toHit(row, row.authority / 100)));
  }

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

  const rows = new Map<string, RankedRow>();
  const unicodeRanks = new Map<string, number>();
  const trigramRanks = new Map<string, number>();
  unicodeResult.value.forEach((row, index) => {
    rows.set(row.entityId, row);
    unicodeRanks.set(row.entityId, index + 1);
  });
  trigramResult.value.forEach((row, index) => {
    rows.set(row.entityId, row);
    trigramRanks.set(row.entityId, index + 1);
  });

  const hits: SearchTextHit[] = [...rows.values()].map((row) => {
    const unicodeRank = unicodeRanks.get(row.entityId);
    const trigramRank = trigramRanks.get(row.entityId);
    const score =
      (unicodeRank === undefined ? 0 : UNICODE_WEIGHT / (RRF_K + unicodeRank)) +
      (trigramRank === undefined ? 0 : TRIGRAM_WEIGHT / (RRF_K + trigramRank));
    return toHit(row, score);
  });

  hits.sort((a, b) => b.score - a.score);
  return ok(hits.slice(0, limit));
}
