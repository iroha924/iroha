import { err, type IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import { type Executor, mapLibsqlError } from "@iroha/storage";

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

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** database-schema.md §9: "top 30 Unicode FTS rows" / "top 30 trigram FTS rows". */
const CANDIDATE_LIMIT = 30;
/** database-schema.md §9's RRF weights for the unicode/trigram terms (the vector term is WP-08's addition). */
const UNICODE_WEIGHT = 1.0;
const TRIGRAM_WEIGHT = 0.9;
const RRF_K = 60;
/** database-schema.md §8: "queries shorter than three Unicode characters fall back to escaped LIKE". */
const MIN_FTS_QUERY_LENGTH = 3;

/**
 * FTS5's `MATCH` right-hand side is its own query language (`AND`/`OR`/
 * `NOT`, `-` exclusion, `column:` filters, `NEAR`) — confirmed by
 * reproduction that an unquoted query containing a hyphen (e.g.
 * `"nonexistent-term-xyz"`) fails with "no such column: term" rather than
 * running as a literal search. Wrapping each whitespace-separated word in
 * `"..."` (doubling embedded `"` per FTS5's string-literal escaping) turns
 * every word into an opaque phrase token, so caller-supplied text can never
 * be reinterpreted as a query operator. Multiple quoted phrases are
 * implicitly ANDed by FTS5, matching this function's "all words must
 * appear" search semantics.
 */
function buildMatchQuery(query: string): string {
  return query
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .map((word) => `"${word.replace(/"/g, '""')}"`)
    .join(" ");
}

interface RankedRow {
  entityId: string;
  searchDocumentId: TypedId<"sdoc">;
  title: string;
  authority: number;
}

async function queryFtsRanked(
  db: Executor,
  table: "search_fts_unicode" | "search_fts_trigram",
  query: string,
): Promise<Result<RankedRow[], IrohaError>> {
  try {
    // FTS5's `MATCH` special-casing keys off the literal virtual-table name
    // appearing unqualified in `WHERE` — confirmed by reproduction that
    // aliasing the table (`FROM ${table} f ... WHERE f MATCH ?`) fails with
    // "no such column: f" instead of running the query. The table name is
    // interpolated from the closed `table` parameter's literal type, not
    // caller input, so this is not a SQL-injection surface.
    //
    // Joining to `entities` and excluding `tombstoned` rows is required, not
    // optional: `syncCanonicalToDatabase` marks a deleted canonical file's
    // entity `tombstoned` via `UPDATE entities SET status = ...` — it never
    // touches `search_documents`, so without this filter a deleted
    // document's stale content would keep surfacing here indefinitely.
    const result = await db.execute({
      sql: `SELECT sd.entity_id AS entity_id, sd.id AS search_document_id, sd.title AS title, sd.authority AS authority
        FROM ${table}
        JOIN search_documents sd ON sd.rowid = ${table}.rowid
        JOIN entities e ON e.id = sd.entity_id
        WHERE ${table} MATCH ? AND e.status != 'tombstoned'
        ORDER BY rank
        LIMIT ?`,
      args: [query, CANDIDATE_LIMIT],
    });
    return ok(
      result.rows.map((row) => ({
        entityId: String(row.entity_id),
        searchDocumentId: row.search_document_id as TypedId<"sdoc">,
        title: String(row.title),
        authority: Number(row.authority),
      })),
    );
  } catch (cause) {
    return err(mapLibsqlError(cause, `Failed to query ${table}`));
  }
}

function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * database-schema.md §8's bounded fallback for queries too short for FTS5
 * (fewer than 3 tokenizer-eligible characters) — an unindexed substring scan
 * over a `LIMIT`-bounded set rather than an unbounded table scan.
 */
async function queryByLike(db: Executor, query: string): Promise<Result<RankedRow[], IrohaError>> {
  const pattern = `%${escapeLikePattern(query)}%`;
  try {
    const result = await db.execute({
      sql: `SELECT sd.entity_id AS entity_id, sd.id AS search_document_id, sd.title AS title, sd.authority AS authority
        FROM search_documents sd
        JOIN entities e ON e.id = sd.entity_id
        WHERE (sd.title LIKE ? ESCAPE '\\' OR sd.body LIKE ? ESCAPE '\\') AND e.status != 'tombstoned'
        ORDER BY sd.authority DESC, sd.indexed_at DESC
        LIMIT ?`,
      args: [pattern, pattern, CANDIDATE_LIMIT],
    });
    return ok(
      result.rows.map((row) => ({
        entityId: String(row.entity_id),
        searchDocumentId: row.search_document_id as TypedId<"sdoc">,
        title: String(row.title),
        authority: Number(row.authority),
      })),
    );
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to search by substring"));
  }
}

/**
 * FTS-only slice of database-schema.md §9's Reciprocal Rank Fusion: the
 * vector candidate source and the authority/scope/graph multipliers are
 * WP-08's addition (Voyage embeddings, `@iroha/storage`'s `searchByVector`,
 * graph boosts). Per §9 "missing ranks contribute zero", omitting the
 * vector term entirely here is a faithful subset of the same formula, not a
 * divergent one — WP-08 adds a term to this same sum rather than replacing
 * it. Works fully offline: no embedding provider or network call involved.
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
    return ok(
      likeResult.value.slice(0, limit).map((row) => ({ ...row, score: row.authority / 100 })),
    );
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
    return { ...row, score };
  });

  hits.sort((a, b) => b.score - a.score);
  return ok(hits.slice(0, limit));
}
