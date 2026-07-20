import { err, type IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import { type Executor, mapLibsqlError } from "@iroha/storage";

/** database-schema.md §9: "top 30 Unicode FTS rows" / "top 30 trigram FTS rows" (also the vector top-30). */
export const CANDIDATE_LIMIT = 30;
export const RRF_K = 60;
/** database-schema.md §9's Reciprocal Rank Fusion weights per candidate source. */
export const UNICODE_WEIGHT = 1.0;
export const TRIGRAM_WEIGHT = 0.9;
export const VECTOR_WEIGHT = 1.1;
/** database-schema.md §8: "queries shorter than three Unicode characters fall back to escaped LIKE". */
export const MIN_FTS_QUERY_LENGTH = 3;
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

export type FtsTable = "search_fts_unicode" | "search_fts_trigram";

export interface RankedRow {
  entityId: string;
  searchDocumentId: TypedId<"sdoc">;
  title: string;
  authority: number;
  /** `entities.updated_at` — the recency tie-breaker input (database-schema.md §9). */
  updatedAt: string;
}

function rowToRanked(row: Record<string, unknown>): RankedRow {
  return {
    entityId: String(row.entity_id),
    searchDocumentId: row.search_document_id as TypedId<"sdoc">,
    title: String(row.title),
    authority: Number(row.authority),
    updatedAt: String(row.updated_at),
  };
}

/**
 * An identifier/path-style token signals an exact-token query (keep AND
 * precision); a query with none is treated as natural language (use OR recall).
 * Markers: a path/namespace separator, camelCase, or snake_case.
 */
function hasExactTokenMarker(tokens: readonly string[]): boolean {
  return tokens.some(
    (token) => /[/\\.:#]/.test(token) || /[a-z][A-Z]/.test(token) || token.includes("_"),
  );
}

/**
 * FTS5's `MATCH` right-hand side is its own query language (`AND`/`OR`/
 * `NOT`, `-` exclusion, `column:` filters, `NEAR`) — confirmed by
 * reproduction that an unquoted query containing a hyphen (e.g.
 * `"nonexistent-term-xyz"`) fails with "no such column: term" rather than
 * running as a literal search. Wrapping each whitespace-separated word in
 * `"..."` (doubling embedded `"` per FTS5's string-literal escaping) turns
 * every word into an opaque phrase token, so caller-supplied text can never
 * be reinterpreted as a query operator — the only operator in the output is
 * the `AND`/`OR` this function chooses between the quoted phrases.
 *
 * Operator routing (see the hybrid-search research recorded in decision-log):
 * FTS5's implicit multi-word AND requires *every* word to appear, which drops
 * to zero recall for long natural-language and cross-lingual queries. So a
 * multi-word natural-language query is joined with `OR` (any word, BM25-ranked,
 * precision recovered by the RRF authority/scope/graph boosts), while an
 * exact-token query (identifiers, paths) keeps `AND` for precision. A
 * single-token query is identical either way. Cross-lingual recall still comes
 * only from the vector arm; OR just recovers same-language partial matches.
 */
export function buildMatchQuery(query: string): string {
  const tokens = query.split(/\s+/u).filter((word) => word.length > 0);
  const phrases = tokens.map((word) => `"${word.replace(/"/g, '""')}"`);
  if (phrases.length <= 1) {
    return phrases.join(" ");
  }
  return phrases.join(hasExactTokenMarker(tokens) ? " AND " : " OR ");
}

export async function queryFtsRanked(
  db: Executor,
  table: FtsTable,
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
      sql: `SELECT sd.entity_id AS entity_id, sd.id AS search_document_id, sd.title AS title, sd.authority AS authority, e.updated_at AS updated_at
        FROM ${table}
        JOIN search_documents sd ON sd.rowid = ${table}.rowid
        JOIN entities e ON e.id = sd.entity_id
        WHERE ${table} MATCH ? AND e.status != 'tombstoned'
        ORDER BY rank
        LIMIT ?`,
      args: [query, CANDIDATE_LIMIT],
    });
    return ok(result.rows.map(rowToRanked));
  } catch (cause) {
    return err(mapLibsqlError(cause, `Failed to query ${table}`));
  }
}

/**
 * Loads full ranked-row data for a set of entity ids (batched). `searchByVector`
 * returns only ids, and a vector hit may name an entity no FTS term matched; the
 * hybrid ranker hydrates those here. Tombstoned entities are excluded for the
 * same reason `queryFtsRanked` excludes them — `searchByVector` does not join
 * `entities`, so a deleted entity's stale vector could otherwise surface.
 */
export async function hydrateRankedRows(
  db: Executor,
  entityIds: readonly string[],
): Promise<Result<RankedRow[], IrohaError>> {
  if (entityIds.length === 0) {
    return ok([]);
  }
  const placeholders = entityIds.map(() => "?").join(", ");
  try {
    const result = await db.execute({
      sql: `SELECT sd.entity_id AS entity_id, sd.id AS search_document_id, sd.title AS title, sd.authority AS authority, e.updated_at AS updated_at
        FROM search_documents sd
        JOIN entities e ON e.id = sd.entity_id
        WHERE sd.entity_id IN (${placeholders}) AND e.status != 'tombstoned'`,
      args: [...entityIds],
    });
    return ok(result.rows.map(rowToRanked));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to hydrate search candidates"));
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
export async function queryByLike(
  db: Executor,
  query: string,
): Promise<Result<RankedRow[], IrohaError>> {
  const pattern = `%${escapeLikePattern(query)}%`;
  try {
    const result = await db.execute({
      sql: `SELECT sd.entity_id AS entity_id, sd.id AS search_document_id, sd.title AS title, sd.authority AS authority, e.updated_at AS updated_at
        FROM search_documents sd
        JOIN entities e ON e.id = sd.entity_id
        WHERE (sd.title LIKE ? ESCAPE '\\' OR sd.body LIKE ? ESCAPE '\\') AND e.status != 'tombstoned'
        ORDER BY sd.authority DESC, sd.indexed_at DESC
        LIMIT ?`,
      args: [pattern, pattern, CANDIDATE_LIMIT],
    });
    return ok(result.rows.map(rowToRanked));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to search by substring"));
  }
}
