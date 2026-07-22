import { err, IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import type { Executor } from "../connection.js";
import { mapLibsqlError } from "../errors.js";
import { nullableNumber, nullableString } from "../row-helpers.js";

// --- relations ---------------------------------------------------

export const RELATION_TYPES = [
  "ADDRESSES",
  "IMPLEMENTED_IN",
  "PRODUCED",
  "AUTHORED_BY",
  "REVIEWED_IN",
  "DERIVED_FROM",
  "APPLIES_TO",
  "AFFECTS",
  "VALIDATED_BY",
  "BLOCKED_BY",
  "SUPERSEDES",
  "CONTRADICTS",
  "DUPLICATES",
  "RELATED_TO",
  "PARENT_OF",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export type RelationSourceKind = "canonical" | "api" | "git" | "inferred" | "human" | "hook";

export interface RelationRow {
  id: TypedId<"rel">;
  repositoryId: TypedId<"repo">;
  fromEntityId: string;
  relationType: RelationType;
  toEntityId: string;
  sourceKind: RelationSourceKind;
  sourceRef: string | null;
  confidence: number | null;
  createdAt: string;
}

export interface InsertRelationInput {
  id: TypedId<"rel">;
  repositoryId: TypedId<"repo">;
  fromEntityId: string;
  relationType: RelationType;
  toEntityId: string;
  sourceKind: RelationSourceKind;
  sourceRef?: string;
  confidence?: number;
  createdAt: string;
}

function rowToRelation(row: Record<string, unknown>): RelationRow {
  return {
    id: row.id as TypedId<"rel">,
    repositoryId: row.repository_id as TypedId<"repo">,
    fromEntityId: String(row.from_entity_id),
    relationType: row.relation_type as RelationType,
    toEntityId: String(row.to_entity_id),
    sourceKind: row.source_kind as RelationSourceKind,
    sourceRef: nullableString(row.source_ref),
    confidence: nullableNumber(row.confidence),
    createdAt: String(row.created_at),
  };
}

/**
 * `ON CONFLICT ... DO NOTHING` on the same unique 4-tuple the DB already
 * enforces — relations are frequently re-derived by sync (e.g. "commit
 * ADDRESSES issue" recomputed on every run), so re-detecting the same edge
 * is treated as a no-op rather than a `CONFLICT` error.
 */
export async function insertRelation(
  db: Executor,
  input: InsertRelationInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO relations
        (id, repository_id, from_entity_id, relation_type, to_entity_id, source_kind, source_ref, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (from_entity_id, relation_type, to_entity_id, source_kind) DO NOTHING`,
      args: [
        input.id,
        input.repositoryId,
        input.fromEntityId,
        input.relationType,
        input.toEntityId,
        input.sourceKind,
        input.sourceRef ?? null,
        input.confidence ?? null,
        input.createdAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to insert relation"));
  }
}

/**
 * Deletes every `source_kind = 'canonical'` relation originating at `fromEntityId`.
 * Used to reconcile a re-synced canonical document's outgoing edges (relation import
 * is otherwise insert-only, so an edge removed from a document's `relations[]` would
 * survive until a full rebuild). Scoped to `source_kind = 'canonical'`, so `api`/
 * `git`/`inferred`/`human`/`hook` edges — and every other document's canonical edges,
 * and any *incoming* edge — are left untouched. Caller must run the delete + re-insert
 * in one transaction so a crash cannot leave the document without its edges.
 */
export async function deleteCanonicalRelationsFromEntity(
  db: Executor,
  fromEntityId: string,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: "DELETE FROM relations WHERE from_entity_id = ? AND source_kind = 'canonical'",
      args: [fromEntityId],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to delete canonical relations"));
  }
}

/**
 * Looks up a relation by its unique `(from_entity_id, relation_type,
 * to_entity_id, source_kind)` tuple — the same key `insertRelation`'s
 * `ON CONFLICT DO NOTHING` targets. A caller that inserted such a tuple can use
 * this to recover the actually-stored row id whether the insert created it or a
 * prior row already held it.
 */
export async function getRelationByTuple(
  db: Executor,
  fromEntityId: string,
  relationType: RelationType,
  toEntityId: string,
  sourceKind: RelationSourceKind,
): Promise<Result<RelationRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: `SELECT * FROM relations
        WHERE from_entity_id = ? AND relation_type = ? AND to_entity_id = ? AND source_kind = ?`,
      args: [fromEntityId, relationType, toEntityId, sourceKind],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToRelation(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read relation"));
  }
}

export type RelationDirection = "outgoing" | "incoming" | "both";

export interface GetNeighborsOptions {
  relationTypes?: RelationType[];
  direction?: RelationDirection;
  limit?: number;
}

/**
 * Matches implementation/database-schema.md §11: `getNeighbors(entityId, relationTypes?, direction?, limit?)`.
 * Ordered by `id` — dashboard-api.md §4 requires deterministic sorting with
 * an ID tie-breaker, and without any `ORDER BY`, SQLite is free to return
 * rows in whatever order the query plan happens to produce; when `limit`
 * cuts the result short (directly here, or via `getSubgraph`'s `maxEdges`),
 * an unordered read can silently omit different edges across otherwise
 * identical calls.
 */
export async function getNeighbors(
  db: Executor,
  entityId: string,
  options: GetNeighborsOptions = {},
): Promise<Result<RelationRow[], IrohaError>> {
  const direction = options.direction ?? "both";
  const conditions: string[] = [];
  const args: Array<string | number> = [];
  if (direction === "outgoing") {
    conditions.push("from_entity_id = ?");
    args.push(entityId);
  } else if (direction === "incoming") {
    conditions.push("to_entity_id = ?");
    args.push(entityId);
  } else {
    conditions.push("(from_entity_id = ? OR to_entity_id = ?)");
    args.push(entityId, entityId);
  }
  if (options.relationTypes !== undefined && options.relationTypes.length > 0) {
    conditions.push(`relation_type IN (${options.relationTypes.map(() => "?").join(", ")})`);
    args.push(...options.relationTypes);
  }
  const limitClause = options.limit !== undefined ? " LIMIT ?" : "";
  if (options.limit !== undefined) {
    args.push(options.limit);
  }
  try {
    const result = await db.execute({
      sql: `SELECT * FROM relations WHERE ${conditions.join(" AND ")} ORDER BY id${limitClause}`,
      args,
    });
    return ok(result.rows.map(rowToRelation));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read neighbors"));
  }
}

/**
 * Batched `getNeighbors` for a whole BFS frontier: one query returning every
 * relation incident to ANY of `entityIds` (`from_entity_id IN (...) OR
 * to_entity_id IN (...)`, `ORDER BY id`), so `getPath`/`getSubgraph` expand a
 * level in a single round-trip instead of one query per frontier node. There is
 * deliberately no per-node `limit` (the BFS callers never pass one, and a SQL
 * `LIMIT` here would be global rather than per node). Empty input → empty
 * result with no query (never `IN ()`). Frontier sets are bounded (getSubgraph
 * caps at `maxEdges` visited nodes), well under SQLite's 999-variable limit.
 */
export async function getNeighborsForNodes(
  db: Executor,
  entityIds: readonly string[],
  options: { direction?: RelationDirection; relationTypes?: RelationType[] } = {},
): Promise<Result<RelationRow[], IrohaError>> {
  if (entityIds.length === 0) {
    return ok([]);
  }
  const direction = options.direction ?? "both";
  const idPlaceholders = entityIds.map(() => "?").join(", ");
  const conditions: string[] = [];
  const args: Array<string | number> = [];
  if (direction === "outgoing") {
    conditions.push(`from_entity_id IN (${idPlaceholders})`);
    args.push(...entityIds);
  } else if (direction === "incoming") {
    conditions.push(`to_entity_id IN (${idPlaceholders})`);
    args.push(...entityIds);
  } else {
    conditions.push(
      `(from_entity_id IN (${idPlaceholders}) OR to_entity_id IN (${idPlaceholders}))`,
    );
    args.push(...entityIds, ...entityIds);
  }
  if (options.relationTypes !== undefined && options.relationTypes.length > 0) {
    conditions.push(`relation_type IN (${options.relationTypes.map(() => "?").join(", ")})`);
    args.push(...options.relationTypes);
  }
  try {
    const result = await db.execute({
      sql: `SELECT * FROM relations WHERE ${conditions.join(" AND ")} ORDER BY id`,
      args,
    });
    return ok(result.rows.map(rowToRelation));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read neighbors"));
  }
}

/**
 * Regroups the flat, id-ordered list from `getNeighborsForNodes` back into
 * per-frontier-node incident lists — reproducing exactly what a per-node
 * `getNeighbors(node, { direction: "both" })` returns for each node (same rows,
 * same `ORDER BY id`). A relation with BOTH endpoints in the frontier lands in
 * both nodes' lists; a self-loop lands once (the endpoint Set dedupes) — matching
 * the per-node semantics `getPath`/`getSubgraph` depend on.
 */
function groupIncidentRelations(
  nodeIds: readonly string[],
  relations: readonly RelationRow[],
): Map<string, RelationRow[]> {
  const inFrontier = new Set(nodeIds);
  const byNode = new Map<string, RelationRow[]>();
  for (const relation of relations) {
    const endpoints = new Set<string>();
    if (inFrontier.has(relation.fromEntityId)) {
      endpoints.add(relation.fromEntityId);
    }
    if (inFrontier.has(relation.toEntityId)) {
      endpoints.add(relation.toEntityId);
    }
    for (const endpoint of endpoints) {
      let list = byNode.get(endpoint);
      if (list === undefined) {
        list = [];
        byNode.set(endpoint, list);
      }
      list.push(relation);
    }
  }
  return byNode;
}

/**
 * Matches implementation/database-schema.md §11: `getPath(fromId, toId, maxDepth = 4)`.
 * Implemented as breadth-first search in application code, one `getNeighbors`
 * call per frontier node, rather than a single recursive SQL CTE: SQLite's
 * recursive CTEs do not guarantee BFS expansion order without a hand-built
 * "visited path as string" workaround, and a local libSQL round-trip is
 * cheap enough that a straightforward, easily-verified BFS is the simpler
 * and more trustworthy choice here (KISS over a single clever query).
 * Returns `null` when no path exists within `maxDepth` hops.
 */
export async function getPath(
  db: Executor,
  fromId: string,
  toId: string,
  maxDepth = 4,
): Promise<Result<RelationRow[] | null, IrohaError>> {
  if (fromId === toId) {
    return ok([]);
  }
  const visited = new Set<string>([fromId]);
  let frontier: Array<{ entityId: string; path: RelationRow[] }> = [{ entityId: fromId, path: [] }];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const frontierIds = frontier.map((node) => node.entityId);
    const levelResult = await getNeighborsForNodes(db, frontierIds, { direction: "both" });
    if (!levelResult.ok) {
      return levelResult;
    }
    const incident = groupIncidentRelations(frontierIds, levelResult.value);
    const nextFrontier: Array<{ entityId: string; path: RelationRow[] }> = [];
    // Identical traversal to the pre-batch per-node version: frontier nodes in
    // order, each node's incident relations in `id` order (via `incident`).
    for (const node of frontier) {
      for (const relation of incident.get(node.entityId) ?? []) {
        const neighborId =
          relation.fromEntityId === node.entityId ? relation.toEntityId : relation.fromEntityId;
        if (visited.has(neighborId)) {
          continue;
        }
        const path = [...node.path, relation];
        if (neighborId === toId) {
          return ok(path);
        }
        visited.add(neighborId);
        nextFrontier.push({ entityId: neighborId, path });
      }
    }
    frontier = nextFrontier;
  }
  return ok(null);
}

/**
 * Matches implementation/database-schema.md §11:
 * `getSubgraph(rootIds, maxDepth = 2, maxEdges = 200)`. Also implemented as
 * BFS (see `getPath`'s comment). The visited-entity set stops re-expanding
 * an already-visited node, but that alone does not stop a `DUPLICATES`
 * relation *back* to one from being collected — confirmed by reproduction
 * that without an explicit check, a `DUPLICATES` cycle (e.g. A visited via
 * some path, then reached again from B via a `DUPLICATES` edge) still
 * appears in the returned edge list. §11 excludes specifically `DUPLICATES`
 * cycles already visited, not every relation type, so other relation types
 * between already-visited nodes are still collected (e.g. a `RELATED_TO`
 * edge discovered from two different directions is legitimate exploration
 * data, not a cycle to hide).
 *
 * A direct `DUPLICATES` edge between two of the caller's own `rootIds` is
 * not a cycle either, even though every root is pre-marked visited below
 * (to stop re-expansion) — confirmed by reproduction that without this
 * carve-out, calling with multiple explicit roots connected by
 * `DUPLICATES` silently drops that edge, hiding a relationship the caller
 * asked about directly rather than one merely discovered via traversal.
 */
export async function getSubgraph(
  db: Executor,
  rootIds: string[],
  maxDepth = 2,
  maxEdges = 200,
): Promise<Result<RelationRow[], IrohaError>> {
  const rootIdSet = new Set(rootIds);
  const visitedEntities = new Set<string>(rootIds);
  const collectedRelations = new Map<string, RelationRow>();
  let frontier = [...rootIds];

  for (
    let depth = 0;
    depth < maxDepth && frontier.length > 0 && collectedRelations.size < maxEdges;
    depth++
  ) {
    const levelResult = await getNeighborsForNodes(db, frontier, { direction: "both" });
    if (!levelResult.ok) {
      return levelResult;
    }
    const incident = groupIncidentRelations(frontier, levelResult.value);
    const nextFrontier: string[] = [];
    // Identical traversal to the pre-batch per-node version: frontier nodes in
    // order, each node's incident relations in `id` order, the same `maxEdges`
    // break/continue, DUPLICATES-cycle carve-out, and visited bookkeeping.
    for (const entityId of frontier) {
      if (collectedRelations.size >= maxEdges) {
        break;
      }
      for (const relation of incident.get(entityId) ?? []) {
        if (collectedRelations.size >= maxEdges || collectedRelations.has(relation.id)) {
          continue;
        }
        const neighborId =
          relation.fromEntityId === entityId ? relation.toEntityId : relation.fromEntityId;
        const isRootToRootEdge = rootIdSet.has(entityId) && rootIdSet.has(neighborId);
        if (
          relation.relationType === "DUPLICATES" &&
          visitedEntities.has(neighborId) &&
          !isRootToRootEdge
        ) {
          continue;
        }
        collectedRelations.set(relation.id, relation);
        if (!visitedEntities.has(neighborId)) {
          visitedEntities.add(neighborId);
          nextFrontier.push(neighborId);
        }
      }
    }
    frontier = nextFrontier;
  }
  return ok([...collectedRelations.values()].slice(0, maxEdges));
}

// --- search_documents ---------------------------------------------------

export interface SearchDocumentRow {
  id: TypedId<"sdoc">;
  entityId: string;
  documentKind: string;
  title: string;
  body: string;
  codeTerms: string;
  languageHint: string | null;
  authority: number;
  contentHash: string;
  indexedAt: string;
}

export interface UpsertSearchDocumentInput {
  id: TypedId<"sdoc">;
  entityId: string;
  documentKind: string;
  title: string;
  body: string;
  codeTerms?: string;
  languageHint?: string;
  authority: number;
  contentHash: string;
  indexedAt: string;
}

function rowToSearchDocument(row: Record<string, unknown>): SearchDocumentRow {
  return {
    id: row.id as TypedId<"sdoc">,
    entityId: String(row.entity_id),
    documentKind: String(row.document_kind),
    title: String(row.title),
    body: String(row.body),
    codeTerms: String(row.code_terms),
    languageHint: nullableString(row.language_hint),
    authority: Number(row.authority),
    contentHash: String(row.content_hash),
    indexedAt: String(row.indexed_at),
  };
}

/**
 * Keyed on `entity_id` (its `UNIQUE` column) — re-indexing an entity
 * replaces its one document, which the migration's `search_documents_au`
 * trigger keeps in sync with both FTS indexes automatically.
 */
export async function upsertSearchDocument(
  db: Executor,
  input: UpsertSearchDocumentInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO search_documents
        (id, entity_id, document_kind, title, body, code_terms, language_hint, authority, content_hash, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (entity_id) DO UPDATE SET
          document_kind = excluded.document_kind,
          title = excluded.title,
          body = excluded.body,
          code_terms = excluded.code_terms,
          language_hint = excluded.language_hint,
          authority = excluded.authority,
          content_hash = excluded.content_hash,
          indexed_at = excluded.indexed_at`,
      args: [
        input.id,
        input.entityId,
        input.documentKind,
        input.title,
        input.body,
        input.codeTerms ?? "",
        input.languageHint ?? null,
        input.authority,
        input.contentHash,
        input.indexedAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to upsert search document"));
  }
}

export async function getSearchDocumentByEntityId(
  db: Executor,
  entityId: string,
): Promise<Result<SearchDocumentRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM search_documents WHERE entity_id = ?",
      args: [entityId],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToSearchDocument(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read search document"));
  }
}

/** The embedding worker resolves a queued `embedding_jobs` row's text/`content_hash` by its `sdoc` id. */
export async function getSearchDocumentById(
  db: Executor,
  id: TypedId<"sdoc">,
): Promise<Result<SearchDocumentRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM search_documents WHERE id = ?",
      args: [id],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToSearchDocument(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read search document"));
  }
}

export interface SearchDocumentHash {
  searchDocumentId: TypedId<"sdoc">;
  contentHash: string;
}

/** `rebuildDatabase` iterates these to carry matching embeddings across a rebuild by content hash. */
export async function listSearchDocumentHashes(
  db: Executor,
): Promise<Result<SearchDocumentHash[], IrohaError>> {
  try {
    const result = await db.execute("SELECT id, content_hash FROM search_documents");
    return ok(
      result.rows.map((row) => ({
        searchDocumentId: row.id as TypedId<"sdoc">,
        contentHash: String(row.content_hash),
      })),
    );
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list search document hashes"));
  }
}

// --- embeddings_1024 ---------------------------------------------------

const EMBEDDING_PROVIDER = "voyage";
const EMBEDDING_MODEL = "voyage-4-large";
const EMBEDDING_DIMENSION = 1024;

export interface EmbeddingMetadataRow {
  searchDocumentId: TypedId<"sdoc">;
  provider: "voyage";
  model: "voyage-4-large";
  dimension: 1024;
  contentHash: string;
  createdAt: string;
}

export interface UpsertEmbeddingInput {
  searchDocumentId: TypedId<"sdoc">;
  contentHash: string;
  /** Exactly 1024 components (implementation/database-schema.md §8: `F32_BLOB(1024)`). */
  embedding: readonly number[];
  createdAt: string;
}

function rowToEmbeddingMetadata(row: Record<string, unknown>): EmbeddingMetadataRow {
  return {
    searchDocumentId: row.search_document_id as TypedId<"sdoc">,
    provider: "voyage",
    model: "voyage-4-large",
    dimension: 1024,
    contentHash: String(row.content_hash),
    createdAt: String(row.created_at),
  };
}

/** Keyed on `search_document_id` (its `UNIQUE` column): one embedding per document per v1 (§8). */
export async function upsertEmbedding(
  db: Executor,
  input: UpsertEmbeddingInput,
): Promise<Result<void, IrohaError>> {
  if (input.embedding.length !== EMBEDDING_DIMENSION) {
    return err(
      new IrohaError(
        "INVALID_INPUT",
        `Embedding must have exactly ${EMBEDDING_DIMENSION} components`,
        {
          details: { length: input.embedding.length },
        },
      ),
    );
  }
  const vectorJson = JSON.stringify(input.embedding);
  try {
    await db.execute({
      sql: `INSERT INTO embeddings_1024
        (search_document_id, provider, model, dimension, content_hash, embedding, created_at)
        VALUES (?, ?, ?, ?, ?, vector32(?), ?)
        ON CONFLICT (search_document_id) DO UPDATE SET
          content_hash = excluded.content_hash,
          embedding = excluded.embedding,
          created_at = excluded.created_at`,
      args: [
        input.searchDocumentId,
        EMBEDDING_PROVIDER,
        EMBEDDING_MODEL,
        EMBEDDING_DIMENSION,
        input.contentHash,
        vectorJson,
        input.createdAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to upsert embedding"));
  }
}

export async function getEmbeddingMetadataBySearchDocumentId(
  db: Executor,
  searchDocumentId: TypedId<"sdoc">,
): Promise<Result<EmbeddingMetadataRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT search_document_id, content_hash, created_at FROM embeddings_1024 WHERE search_document_id = ?",
      args: [searchDocumentId],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToEmbeddingMetadata(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read embedding"));
  }
}

/**
 * Reads a stored vector back as a plain `number[]` via libSQL's
 * `vector_extract` (confirmed by reproduction to return a JSON array string,
 * e.g. `"[0.1,0.2]"`). `rebuildDatabase` uses this to carry an
 * already-computed embedding across a rebuild by content hash — the vector
 * for identical content is identical, so any row sharing the hash serves —
 * instead of re-calling the embedding provider (database-schema.md §12
 * steps 8-9). Returns null when no stored embedding shares the hash.
 */
export async function getEmbeddingVectorByContentHash(
  db: Executor,
  contentHash: string,
): Promise<Result<number[] | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT vector_extract(embedding) AS vector FROM embeddings_1024 WHERE content_hash = ? LIMIT 1",
      args: [contentHash],
    });
    const row = result.rows[0];
    if (row === undefined) {
      return ok(null);
    }
    const decoded: unknown = JSON.parse(String(row.vector));
    if (!Array.isArray(decoded) || !decoded.every((n): n is number => typeof n === "number")) {
      return err(new IrohaError("INTERNAL_ERROR", "Stored embedding vector could not be decoded"));
    }
    return ok(decoded);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read embedding vector"));
  }
}

export interface VectorSearchHit {
  searchDocumentId: TypedId<"sdoc">;
  entityId: string;
}

/**
 * `vector_top_k` (confirmed by reproduction) returns only a rowid column —
 * this joins back to `embeddings_1024`/`search_documents` for the IDs a
 * caller actually needs. Full hybrid ranking (RRF, authority/graph boosts)
 * is WP-08's job; this is the storage-layer primitive it builds on.
 */
export async function searchByVector(
  db: Executor,
  queryVector: readonly number[],
  k: number,
): Promise<Result<VectorSearchHit[], IrohaError>> {
  if (queryVector.length !== EMBEDDING_DIMENSION) {
    return err(
      new IrohaError(
        "INVALID_INPUT",
        `Query vector must have exactly ${EMBEDDING_DIMENSION} components`,
        { details: { length: queryVector.length } },
      ),
    );
  }
  try {
    // `vtk` alias is required: confirmed by reproduction that an
    // unqualified `id` here is "ambiguous column name: id" once
    // `search_documents` (which has its own `id` column) is joined in —
    // every table in a FROM/JOIN clause shares one naming scope regardless
    // of join order, not just the tables introduced so far.
    //
    // `e.content_hash = s.content_hash` excludes a stale embedding whose
    // search document's content has since changed but has not yet been
    // re-embedded (embedding generation is queued/async — `embedding_jobs`
    // exists specifically because this lag is expected). Per CLAUDE.md
    // ("embedding failure must degrade to lexical search"), a stale vector
    // hit is dropped rather than ranking the entity on outdated content;
    // the caller may get fewer than `k` hits until the refresh completes.
    const result = await db.execute({
      sql: `SELECT s.id AS search_document_id, s.entity_id AS entity_id
        FROM vector_top_k('embeddings_1024_vector_idx', vector32(?), ?) AS vtk
        JOIN embeddings_1024 e ON e.row_id = vtk.id
        JOIN search_documents s ON s.id = e.search_document_id
        WHERE e.content_hash = s.content_hash`,
      args: [JSON.stringify(queryVector), k],
    });
    return ok(
      result.rows.map((row) => ({
        searchDocumentId: row.search_document_id as TypedId<"sdoc">,
        entityId: String(row.entity_id),
      })),
    );
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to search by vector"));
  }
}

// --- embedding_jobs ---------------------------------------------------

export type EmbeddingJobStatus = "pending" | "running" | "completed" | "failed" | "dead";

export interface EmbeddingJobRow {
  id: TypedId<"job">;
  searchDocumentId: TypedId<"sdoc">;
  provider: string;
  model: string;
  status: EmbeddingJobStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueEmbeddingJobInput {
  id: TypedId<"job">;
  searchDocumentId: TypedId<"sdoc">;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

function rowToEmbeddingJob(row: Record<string, unknown>): EmbeddingJobRow {
  return {
    id: row.id as TypedId<"job">,
    searchDocumentId: row.search_document_id as TypedId<"sdoc">,
    provider: String(row.provider),
    model: String(row.model),
    status: row.status as EmbeddingJobStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: nullableString(row.next_attempt_at),
    lastErrorCode: nullableString(row.last_error_code),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Keyed on `(search_document_id, provider, model)`. Already-queued or
 * in-progress work (`pending`/`running`) is left untouched — re-enqueuing
 * that would be redundant. Only a `completed` job is revived back to
 * `pending`: `embedding_jobs` has no `content_hash` column of its own, so
 * this table cannot tell a genuinely-finished embedding from one whose
 * `search_documents.content_hash` has since changed underneath it — the
 * caller (who does have that context, per implementation/database-schema.md
 * §12 step 9 "queue missing embeddings") signals "this needs work" simply
 * by calling this function again, and a `DO NOTHING` on a completed row
 * would otherwise leave `listDueEmbeddingJobs` never finding it, and the
 * vector never refreshing.
 *
 * `failed`/`dead` are deliberately left alone here — confirmed by review
 * that reviving them unconditionally on every enqueue call would discard
 * their backoff (`next_attempt_at`) and retry-budget (`attempts`) state,
 * causing an immediate hot retry against a provider that just failed or
 * was already given up on, rather than waiting for `listDueEmbeddingJobs`'s
 * own schedule (or an explicit dead-letter retry, which is out of this
 * function's scope).
 */
export async function enqueueEmbeddingJob(
  db: Executor,
  input: EnqueueEmbeddingJobInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO embedding_jobs (id, search_document_id, provider, model, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT (search_document_id, provider, model) DO UPDATE SET
          status = 'pending',
          attempts = 0,
          next_attempt_at = NULL,
          last_error_code = NULL,
          updated_at = excluded.updated_at
        WHERE embedding_jobs.status = 'completed'`,
      args: [
        input.id,
        input.searchDocumentId,
        input.provider,
        input.model,
        input.createdAt,
        input.updatedAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to enqueue embedding job"));
  }
}

/** Matches the `idx_embedding_jobs_work` partial index: due `pending`/`failed` work, oldest first. */
export async function listDueEmbeddingJobs(
  db: Executor,
  now: string,
  limit: number,
): Promise<Result<EmbeddingJobRow[], IrohaError>> {
  try {
    const result = await db.execute({
      sql: `SELECT * FROM embedding_jobs
        WHERE status IN ('pending', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY next_attempt_at
        LIMIT ?`,
      args: [now, limit],
    });
    return ok(result.rows.map(rowToEmbeddingJob));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list due embedding jobs"));
  }
}

export interface UpdateEmbeddingJobStatusInput {
  status: EmbeddingJobStatus;
  attempts?: number;
  nextAttemptAt?: string;
  lastErrorCode?: string;
  updatedAt: string;
}

export async function updateEmbeddingJobStatus(
  db: Executor,
  id: TypedId<"job">,
  input: UpdateEmbeddingJobStatusInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `UPDATE embedding_jobs
        SET status = ?, attempts = COALESCE(?, attempts), next_attempt_at = ?, last_error_code = ?, updated_at = ?
        WHERE id = ?`,
      args: [
        input.status,
        input.attempts ?? null,
        input.nextAttemptAt ?? null,
        input.lastErrorCode ?? null,
        input.updatedAt,
        id,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to update embedding job"));
  }
}
