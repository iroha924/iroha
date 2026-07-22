import { err, type IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import type { Executor } from "../connection.js";
import { mapLibsqlError } from "../errors.js";
import { nullableString } from "../row-helpers.js";

// --- repositories -----------------------------------------------------

export interface RepositoryRow {
  id: TypedId<"repo">;
  vcs: "git";
  rootFingerprint: string;
  remoteUrlNormalized: string | null;
  defaultBranch: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InsertRepositoryInput {
  id: TypedId<"repo">;
  rootFingerprint: string;
  remoteUrlNormalized?: string;
  defaultBranch?: string;
  createdAt: string;
  updatedAt: string;
}

function rowToRepository(row: Record<string, unknown>): RepositoryRow {
  return {
    id: row.id as TypedId<"repo">,
    vcs: "git",
    rootFingerprint: String(row.root_fingerprint),
    remoteUrlNormalized: nullableString(row.remote_url_normalized),
    defaultBranch: nullableString(row.default_branch),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function insertRepository(
  db: Executor,
  input: InsertRepositoryInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO repositories (id, vcs, root_fingerprint, remote_url_normalized, default_branch, created_at, updated_at)
        VALUES (?, 'git', ?, ?, ?, ?, ?)`,
      args: [
        input.id,
        input.rootFingerprint,
        input.remoteUrlNormalized ?? null,
        input.defaultBranch ?? null,
        input.createdAt,
        input.updatedAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to insert repository"));
  }
}

export async function getRepositoryById(
  db: Executor,
  id: TypedId<"repo">,
): Promise<Result<RepositoryRow | null, IrohaError>> {
  try {
    const result = await db.execute({ sql: "SELECT * FROM repositories WHERE id = ?", args: [id] });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToRepository(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read repository"));
  }
}

export async function getRepositoryByRootFingerprint(
  db: Executor,
  rootFingerprint: string,
): Promise<Result<RepositoryRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM repositories WHERE root_fingerprint = ?",
      args: [rootFingerprint],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToRepository(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read repository"));
  }
}

export async function updateRepositoryRemote(
  db: Executor,
  id: TypedId<"repo">,
  input: { remoteUrlNormalized: string | null; defaultBranch: string | null; updatedAt: string },
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: "UPDATE repositories SET remote_url_normalized = ?, default_branch = ?, updated_at = ? WHERE id = ?",
      args: [input.remoteUrlNormalized, input.defaultBranch, input.updatedAt, id],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to update repository"));
  }
}

// --- actors -------------------------------------------------------------

export type ActorProvider = "git" | "github" | "gitlab" | "local";

export interface ActorRow {
  id: TypedId<"act">;
  provider: ActorProvider;
  externalId: string | null;
  displayName: string;
  emailHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InsertActorInput {
  id: TypedId<"act">;
  provider: ActorProvider;
  externalId?: string;
  displayName: string;
  emailHash?: string;
  createdAt: string;
  updatedAt: string;
}

function rowToActor(row: Record<string, unknown>): ActorRow {
  return {
    id: row.id as TypedId<"act">,
    provider: row.provider as ActorProvider,
    externalId: nullableString(row.external_id),
    displayName: String(row.display_name),
    emailHash: nullableString(row.email_hash),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function insertActor(
  db: Executor,
  input: InsertActorInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO actors (id, provider, external_id, display_name, email_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.id,
        input.provider,
        input.externalId ?? null,
        input.displayName,
        input.emailHash ?? null,
        input.createdAt,
        input.updatedAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to insert actor"));
  }
}

export async function getActorById(
  db: Executor,
  id: TypedId<"act">,
): Promise<Result<ActorRow | null, IrohaError>> {
  try {
    const result = await db.execute({ sql: "SELECT * FROM actors WHERE id = ?", args: [id] });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToActor(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read actor"));
  }
}

export async function getActorByProviderExternalId(
  db: Executor,
  provider: ActorProvider,
  externalId: string,
): Promise<Result<ActorRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM actors WHERE provider = ? AND external_id = ?",
      args: [provider, externalId],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToActor(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read actor"));
  }
}

// --- entities -------------------------------------------------------------

/** Matches migrations/001_initial.sql `entities.entity_type` CHECK list. */
export const ENTITY_TYPES = [
  "session",
  "checkpoint",
  "issue",
  "commit",
  "pull_request",
  "review",
  "file",
  "symbol",
  "decision",
  "rule",
  "concept",
  "insight",
  "incident",
  "pattern",
  "review_learning",
  "validation",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** Matches migrations/001_initial.sql `entities.source_kind` CHECK list. */
export const ENTITY_SOURCE_KINDS = [
  "canonical",
  "hook",
  "mcp",
  "git",
  "github",
  "gitlab",
  "import",
  "inferred",
  "human",
] as const;
export type EntitySourceKind = (typeof ENTITY_SOURCE_KINDS)[number];

export interface EntityRow {
  id: string;
  repositoryId: TypedId<"repo">;
  entityType: EntityType;
  title: string;
  summary: string | null;
  status: string;
  authority: number;
  sourceKind: EntitySourceKind;
  sourceRef: string | null;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InsertEntityInput {
  id: string;
  repositoryId: TypedId<"repo">;
  entityType: EntityType;
  title: string;
  summary?: string;
  status: string;
  authority: number;
  sourceKind: EntitySourceKind;
  sourceRef?: string;
  contentHash?: string;
  createdAt: string;
  updatedAt: string;
}

function rowToEntity(row: Record<string, unknown>): EntityRow {
  return {
    id: String(row.id),
    repositoryId: row.repository_id as TypedId<"repo">,
    entityType: row.entity_type as EntityType,
    title: String(row.title),
    summary: nullableString(row.summary),
    status: String(row.status),
    authority: Number(row.authority),
    sourceKind: row.source_kind as EntitySourceKind,
    sourceRef: nullableString(row.source_ref),
    contentHash: nullableString(row.content_hash),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function insertEntity(
  db: Executor,
  input: InsertEntityInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO entities
        (id, repository_id, entity_type, title, summary, status, authority, source_kind, source_ref, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        input.id,
        input.repositoryId,
        input.entityType,
        input.title,
        input.summary ?? null,
        input.status,
        input.authority,
        input.sourceKind,
        input.sourceRef ?? null,
        input.contentHash ?? null,
        input.createdAt,
        input.updatedAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to insert entity"));
  }
}

/**
 * Idempotent counterpart to `insertEntity`: canonical sync (WP-05) re-derives
 * the same entity id from a document's ULID on every run, so re-syncing an
 * unchanged or edited file must not fail on the primary-key conflict
 * `insertEntity` raises. `created_at` is deliberately excluded from the
 * `DO UPDATE SET` list — it must keep recording when the entity was first
 * seen, not the most recent sync time.
 */
export async function upsertEntity(
  db: Executor,
  input: InsertEntityInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO entities
        (id, repository_id, entity_type, title, summary, status, authority, source_kind, source_ref, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          entity_type = excluded.entity_type,
          title = excluded.title,
          summary = excluded.summary,
          status = excluded.status,
          authority = excluded.authority,
          source_kind = excluded.source_kind,
          source_ref = excluded.source_ref,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at`,
      args: [
        input.id,
        input.repositoryId,
        input.entityType,
        input.title,
        input.summary ?? null,
        input.status,
        input.authority,
        input.sourceKind,
        input.sourceRef ?? null,
        input.contentHash ?? null,
        input.createdAt,
        input.updatedAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to upsert entity"));
  }
}

export async function getEntityById(
  db: Executor,
  id: string,
): Promise<Result<EntityRow | null, IrohaError>> {
  try {
    const result = await db.execute({ sql: "SELECT * FROM entities WHERE id = ?", args: [id] });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToEntity(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read entity"));
  }
}

/**
 * Batched `getEntityById`: fetches many entities in one `IN (...)` query, keyed
 * by `id`. Returns an empty Map (with no query) for empty input — never emits
 * `IN ()`. Missing ids are simply absent from the Map, exactly like a `null`
 * from `getEntityById`. Callers pass bounded id sets (search ranking: ≤90
 * candidates / ≤50 top-result neighbours; dashboard graph read: ≤200 nodes),
 * all well under libSQL's ~32766-bound-variable limit (SQLite ≥3.32; verified
 * against @libsql/client 0.17.4 — not the older 999), so no chunking is needed.
 */
export async function getEntitiesByIds(
  db: Executor,
  ids: readonly string[],
): Promise<Result<Map<string, EntityRow>, IrohaError>> {
  const byId = new Map<string, EntityRow>();
  if (ids.length === 0) {
    return ok(byId);
  }
  try {
    const placeholders = ids.map(() => "?").join(", ");
    const result = await db.execute({
      sql: `SELECT * FROM entities WHERE id IN (${placeholders})`,
      args: [...ids],
    });
    for (const row of result.rows) {
      const entity = rowToEntity(row);
      byId.set(entity.id, entity);
    }
    return ok(byId);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read entities"));
  }
}

export async function updateEntityStatus(
  db: Executor,
  id: string,
  input: { status: string; updatedAt: string },
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: "UPDATE entities SET status = ?, updated_at = ? WHERE id = ?",
      args: [input.status, input.updatedAt, id],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to update entity status"));
  }
}

/**
 * `entities.authority` is recalculated during sync when canonical state
 * changes (implementation/database-schema.md §6), not edited alongside
 * arbitrary other columns — kept as its own narrow update for that reason.
 */
export async function updateEntityAuthority(
  db: Executor,
  id: string,
  input: { authority: number; updatedAt: string },
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: "UPDATE entities SET authority = ?, updated_at = ? WHERE id = ?",
      args: [input.authority, input.updatedAt, id],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to update entity authority"));
  }
}

export interface ListEntitiesFilter {
  entityType?: EntityType;
  status?: string;
  limit?: number;
}

/** Matches the `idx_entities_repository_type` index's column order. */
export async function listEntitiesByRepository(
  db: Executor,
  repositoryId: TypedId<"repo">,
  filter: ListEntitiesFilter = {},
): Promise<Result<EntityRow[], IrohaError>> {
  const conditions = ["repository_id = ?"];
  const args: Array<string | number> = [repositoryId];
  if (filter.entityType !== undefined) {
    conditions.push("entity_type = ?");
    args.push(filter.entityType);
  }
  if (filter.status !== undefined) {
    conditions.push("status = ?");
    args.push(filter.status);
  }
  const limitClause = filter.limit !== undefined ? " LIMIT ?" : "";
  if (filter.limit !== undefined) {
    args.push(filter.limit);
  }
  try {
    const result = await db.execute({
      sql: `SELECT * FROM entities WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC${limitClause}`,
      args,
    });
    return ok(result.rows.map(rowToEntity));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list entities"));
  }
}

/** The `entity_type` values that correspond to a canonical knowledge document. */
const KNOWLEDGE_ENTITY_TYPES = [
  "decision",
  "rule",
  "concept",
  "insight",
  "incident",
  "pattern",
  "review_learning",
] as const;

export interface ListKnowledgeEntitiesFilter {
  /** Entity statuses to include; defaults to `["approved"]`. */
  statuses?: string[];
  /** Page size; the caller passes `limit + 1` to detect a next page. */
  limit: number;
  /** Keyset cursor: return rows strictly older than this `(updated_at, id)` pair. */
  beforeUpdatedAt?: string;
  beforeId?: string;
}

/**
 * Keyset-paginated knowledge entity list for the dashboard Knowledge page
 * (`GET /api/v1/knowledge`) — the seven canonical knowledge `entity_type`s
 * only, so Sessions/Checkpoints/Git artifacts never appear here. Deterministic
 * `updated_at DESC, id DESC` order with a `(updated_at, id)` cursor.
 */
export async function listKnowledgeEntities(
  db: Executor,
  repositoryId: TypedId<"repo">,
  filter: ListKnowledgeEntitiesFilter,
): Promise<Result<EntityRow[], IrohaError>> {
  const statuses = filter.statuses ?? ["approved"];
  const typePlaceholders = KNOWLEDGE_ENTITY_TYPES.map(() => "?").join(", ");
  const statusPlaceholders = statuses.map(() => "?").join(", ");
  const conditions = [
    "repository_id = ?",
    `entity_type IN (${typePlaceholders})`,
    `status IN (${statusPlaceholders})`,
  ];
  const args: Array<string | number> = [repositoryId, ...KNOWLEDGE_ENTITY_TYPES, ...statuses];
  if (filter.beforeUpdatedAt !== undefined && filter.beforeId !== undefined) {
    conditions.push("(updated_at, id) < (?, ?)");
    args.push(filter.beforeUpdatedAt, filter.beforeId);
  }
  args.push(filter.limit);
  try {
    const result = await db.execute({
      sql: `SELECT * FROM entities WHERE ${conditions.join(" AND ")}
        ORDER BY updated_at DESC, id DESC LIMIT ?`,
      args,
    });
    return ok(result.rows.map(rowToEntity));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list knowledge entities"));
  }
}

// --- canonical_documents --------------------------------------------------

export interface CanonicalDocumentRow {
  entityId: string;
  canonicalPath: string;
  schemaVersion: 1;
  revision: number;
  frontmatterJson: string;
  body: string;
  fileHash: string;
  approvedByActorId: TypedId<"act"> | null;
  approvedAt: string;
  importedAt: string;
}

export interface UpsertCanonicalDocumentInput {
  entityId: string;
  canonicalPath: string;
  revision: number;
  frontmatterJson: string;
  body: string;
  fileHash: string;
  approvedByActorId?: TypedId<"act">;
  approvedAt: string;
  importedAt: string;
}

function rowToCanonicalDocument(row: Record<string, unknown>): CanonicalDocumentRow {
  return {
    entityId: String(row.entity_id),
    canonicalPath: String(row.canonical_path),
    schemaVersion: 1,
    revision: Number(row.revision),
    frontmatterJson: String(row.frontmatter_json),
    body: String(row.body),
    fileHash: String(row.file_hash),
    approvedByActorId:
      row.approved_by_actor_id === null ? null : (row.approved_by_actor_id as TypedId<"act">),
    approvedAt: String(row.approved_at),
    importedAt: String(row.imported_at),
  };
}

/**
 * One canonical document per entity (`entity_id` is the primary key) —
 * approving a revision of an already-published document (design.md §10)
 * replaces this row rather than inserting a second one.
 */
export async function upsertCanonicalDocument(
  db: Executor,
  input: UpsertCanonicalDocumentInput,
): Promise<Result<void, IrohaError>> {
  try {
    await db.execute({
      sql: `INSERT INTO canonical_documents
        (entity_id, canonical_path, schema_version, revision, frontmatter_json, body, file_hash, approved_by_actor_id, approved_at, imported_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (entity_id) DO UPDATE SET
          canonical_path = excluded.canonical_path,
          revision = excluded.revision,
          frontmatter_json = excluded.frontmatter_json,
          body = excluded.body,
          file_hash = excluded.file_hash,
          approved_by_actor_id = excluded.approved_by_actor_id,
          approved_at = excluded.approved_at,
          imported_at = excluded.imported_at`,
      args: [
        input.entityId,
        input.canonicalPath,
        input.revision,
        input.frontmatterJson,
        input.body,
        input.fileHash,
        input.approvedByActorId ?? null,
        input.approvedAt,
        input.importedAt,
      ],
    });
    return ok(undefined);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to upsert canonical document"));
  }
}

export async function getCanonicalDocumentByEntityId(
  db: Executor,
  entityId: string,
): Promise<Result<CanonicalDocumentRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM canonical_documents WHERE entity_id = ?",
      args: [entityId],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToCanonicalDocument(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read canonical document"));
  }
}

/**
 * Batched `getCanonicalDocumentByEntityId`: fetches many canonical documents in
 * one `IN (...)` query, keyed by `entity_id`. Empty input → empty Map, no query
 * (never `IN ()`). An entity with no canonical document is simply absent from
 * the Map (same as a `null` from the single-row read). Bounded id sets only
 * (see `getEntitiesByIds`), so no chunking.
 */
export async function getCanonicalDocumentsByEntityIds(
  db: Executor,
  entityIds: readonly string[],
): Promise<Result<Map<string, CanonicalDocumentRow>, IrohaError>> {
  const byEntityId = new Map<string, CanonicalDocumentRow>();
  if (entityIds.length === 0) {
    return ok(byEntityId);
  }
  try {
    const placeholders = entityIds.map(() => "?").join(", ");
    const result = await db.execute({
      sql: `SELECT * FROM canonical_documents WHERE entity_id IN (${placeholders})`,
      args: [...entityIds],
    });
    for (const row of result.rows) {
      const doc = rowToCanonicalDocument(row);
      byEntityId.set(doc.entityId, doc);
    }
    return ok(byEntityId);
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read canonical documents"));
  }
}

export async function getCanonicalDocumentByPath(
  db: Executor,
  canonicalPath: string,
): Promise<Result<CanonicalDocumentRow | null, IrohaError>> {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM canonical_documents WHERE canonical_path = ?",
      args: [canonicalPath],
    });
    const row = result.rows[0];
    return ok(row === undefined ? null : rowToCanonicalDocument(row));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read canonical document"));
  }
}

/**
 * `canonical_documents` has no `repository_id` column of its own (only
 * `entities` does), so listing "every canonical document this repository
 * currently has" requires the join. Sync (WP-05) uses this to build the
 * `path -> hash` baseline `@iroha/canonical`'s `diffCanonicalFiles` compares
 * a fresh directory scan against.
 */
export async function listCanonicalDocumentsByRepository(
  db: Executor,
  repositoryId: TypedId<"repo">,
): Promise<Result<CanonicalDocumentRow[], IrohaError>> {
  try {
    const result = await db.execute({
      sql: `SELECT cd.* FROM canonical_documents cd
        JOIN entities e ON e.id = cd.entity_id
        WHERE e.repository_id = ?`,
      args: [repositoryId],
    });
    return ok(result.rows.map(rowToCanonicalDocument));
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to list canonical documents"));
  }
}
