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

export type RelationDirection = "outgoing" | "incoming" | "both";

export interface GetNeighborsOptions {
  relationTypes?: RelationType[];
  direction?: RelationDirection;
  limit?: number;
}

/** Matches implementation/database-schema.md §11: `getNeighbors(entityId, relationTypes?, direction?, limit?)`. */
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
      sql: `SELECT * FROM relations WHERE ${conditions.join(" AND ")}${limitClause}`,
      args,
    });
    return ok(result.rows.map(rowToRelation));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read neighbors"));
  }
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
    const nextFrontier: Array<{ entityId: string; path: RelationRow[] }> = [];
    for (const node of frontier) {
      const neighborsResult = await getNeighbors(db, node.entityId, { direction: "both" });
      if (!neighborsResult.ok) {
        return neighborsResult;
      }
      for (const relation of neighborsResult.value) {
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
 * BFS (see `getPath`'s comment); the visited-entity set inherently prevents
 * revisiting any node — including through `DUPLICATES` edges — which is
 * what §11's "excludes DUPLICATES cycles already visited" requires.
 */
export async function getSubgraph(
  db: Executor,
  rootIds: string[],
  maxDepth = 2,
  maxEdges = 200,
): Promise<Result<RelationRow[], IrohaError>> {
  const visitedEntities = new Set<string>(rootIds);
  const collectedRelations = new Map<string, RelationRow>();
  let frontier = [...rootIds];

  for (
    let depth = 0;
    depth < maxDepth && frontier.length > 0 && collectedRelations.size < maxEdges;
    depth++
  ) {
    const nextFrontier: string[] = [];
    for (const entityId of frontier) {
      if (collectedRelations.size >= maxEdges) {
        break;
      }
      const neighborsResult = await getNeighbors(db, entityId, { direction: "both" });
      if (!neighborsResult.ok) {
        return neighborsResult;
      }
      for (const relation of neighborsResult.value) {
        if (collectedRelations.size >= maxEdges || collectedRelations.has(relation.id)) {
          continue;
        }
        collectedRelations.set(relation.id, relation);
        const neighborId =
          relation.fromEntityId === entityId ? relation.toEntityId : relation.fromEntityId;
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

// --- embeddings_1024 ---------------------------------------------------

const EMBEDDING_PROVIDER = "voyage";
const EMBEDDING_MODEL = "voyage-4";
const EMBEDDING_DIMENSION = 1024;

export interface EmbeddingMetadataRow {
  searchDocumentId: TypedId<"sdoc">;
  provider: "voyage";
  model: "voyage-4";
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
    model: "voyage-4",
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
    const result = await db.execute({
      sql: `SELECT s.id AS search_document_id, s.entity_id AS entity_id
        FROM vector_top_k('embeddings_1024_vector_idx', vector32(?), ?) AS vtk
        JOIN embeddings_1024 e ON e.row_id = vtk.id
        JOIN search_documents s ON s.id = e.search_document_id`,
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

/** Keyed on `(search_document_id, provider, model)`; already-queued/processed work is left untouched. */
export async function enqueueEmbeddingJob(
  db: Executor,
  input: EnqueueEmbeddingJobInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO embedding_jobs (id, search_document_id, provider, model, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT (search_document_id, provider, model) DO NOTHING`,
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
