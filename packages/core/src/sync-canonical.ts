import {
  diffCanonicalFiles,
  findTombstoneReferences,
  scanCanonicalDirectory,
} from "@iroha/canonical";
import {
  type CanonicalDocument,
  type Clock,
  type IrohaError,
  makeTypedId,
  ok,
  type RandomSource,
  type Result,
  type TypedId,
} from "@iroha/domain";
import {
  type Database,
  enqueueEmbeddingJob,
  getEntityById,
  getSearchDocumentByEntityId,
  insertDirtyMarker,
  insertRelation,
  listCanonicalDocumentsByRepository,
  updateEntityStatus,
  upsertCanonicalDocument,
  upsertEntity,
  upsertSearchDocument,
  upsertSyncCursor,
} from "@iroha/storage";

/** database-schema.md §6: "approved canonical" is the only tier this maps to — see decision-log.md ID-026. */
const CANONICAL_AUTHORITY = 100;
const SYNC_PROVIDER = "canonical";
/** OQ-005 fixes the embedding provider/model; `embedding_jobs` is keyed on `(sdoc, provider, model)`. */
const EMBEDDING_PROVIDER = "voyage";
const EMBEDDING_MODEL = "voyage-4-large";

function entityTypeForFrontmatterType(
  type: CanonicalDocument["frontmatter"]["type"],
): "session" | Exclude<CanonicalDocument["frontmatter"]["type"], "session_summary"> {
  return type === "session_summary" ? "session" : type;
}

export interface SyncCanonicalResult {
  added: number;
  changed: number;
  unchanged: number;
  deleted: number;
  scanErrors: number;
  unresolvedRelations: number;
}

async function upsertOneDocument(
  db: Database,
  repositoryId: TypedId<"repo">,
  path: string,
  hash: string,
  document: CanonicalDocument,
  clock: Clock,
  random: RandomSource,
): Promise<Result<void, IrohaError>> {
  const { frontmatter, body } = document;
  const now = clock.now().toISOString();

  const entityResult = await upsertEntity(db, {
    id: frontmatter.id,
    repositoryId,
    entityType: entityTypeForFrontmatterType(frontmatter.type),
    title: frontmatter.title,
    status: frontmatter.status,
    authority: CANONICAL_AUTHORITY,
    sourceKind: "canonical",
    sourceRef: path,
    contentHash: hash,
    createdAt: frontmatter.created_at,
    updatedAt: frontmatter.updated_at,
  });
  if (!entityResult.ok) {
    return entityResult;
  }

  const canonicalResult = await upsertCanonicalDocument(db, {
    entityId: frontmatter.id,
    canonicalPath: path,
    revision: frontmatter.revision,
    frontmatterJson: JSON.stringify(frontmatter),
    body,
    fileHash: hash,
    approvedAt: frontmatter.approved_at,
    importedAt: now,
  });
  if (!canonicalResult.ok) {
    return canonicalResult;
  }

  const searchResult = await upsertSearchDocument(db, {
    id: makeTypedId("sdoc", clock, random),
    entityId: frontmatter.id,
    documentKind: frontmatter.type,
    title: frontmatter.title,
    body,
    codeTerms: frontmatter.scope.symbols.join(" "),
    authority: CANONICAL_AUTHORITY,
    contentHash: hash,
    indexedAt: now,
  });
  if (!searchResult.ok) {
    return searchResult;
  }

  // `upsertSearchDocument` is keyed on `entity_id`; on re-index it keeps the
  // row's original `sdoc` id, which differs from the one just generated. Read
  // the effective id so the embedding job's foreign key (and its
  // `(sdoc, provider, model)` dedup key) reference the real row rather than a
  // phantom id.
  const storedSearch = await getSearchDocumentByEntityId(db, frontmatter.id);
  if (!storedSearch.ok) {
    return storedSearch;
  }
  if (storedSearch.value !== null) {
    // Queue this (re-)indexed document for embedding. Offline-safe: this only
    // enqueues work — no embedding provider is called here (ID-014 forbids
    // remote calls in hooks, and sync stays usable with no network/key). The
    // worker (`runEmbeddingSync`) drains the queue during `iroha sync` when
    // embedding is enabled and a key is present, and otherwise leaves jobs
    // pending (database-schema.md §12 step 9). Both plain `sync` and
    // `sync --rebuild` funnel through here, so one hook covers both.
    const enqueueResult = await enqueueEmbeddingJob(db, {
      id: makeTypedId("job", clock, random),
      searchDocumentId: storedSearch.value.id,
      provider: EMBEDDING_PROVIDER,
      model: EMBEDDING_MODEL,
      createdAt: now,
      updatedAt: now,
    });
    if (!enqueueResult.ok) {
      return enqueueResult;
    }
  }

  return ok(undefined);
}

/**
 * Inserts a canonical document's `relations[]` (WP-04) into the graph. A
 * target that does not (yet) exist locally as an `entities` row — a
 * forward reference to a not-yet-synced Forge/Git entity, or one dropped by
 * a prior tombstone — cannot satisfy `relations.to_entity_id`'s foreign key.
 * Rather than failing the whole sync over one unresolved edge, this records
 * a `sync_required` dirty marker (WP-04 acceptance: "malformed canonical
 * file fails rebuild safely" — extended here to "one bad edge", not the
 * whole graph) and continues.
 */
async function insertRelationsForDocument(
  db: Database,
  repositoryId: TypedId<"repo">,
  document: CanonicalDocument,
  clock: Clock,
  random: RandomSource,
): Promise<Result<{ unresolved: number }, IrohaError>> {
  const now = clock.now().toISOString();
  let unresolved = 0;
  for (const relation of document.frontmatter.relations) {
    const targetResult = await getEntityById(db, relation.target);
    if (!targetResult.ok) {
      return targetResult;
    }
    if (targetResult.value === null) {
      unresolved += 1;
      const markerResult = await insertDirtyMarker(db, {
        id: makeTypedId("dirty", clock, random),
        repositoryId,
        markerType: "sync_required",
        entityId: document.frontmatter.id,
        detailsJson: JSON.stringify({
          reason: "unresolved_relation_target",
          relationType: relation.type,
          target: relation.target,
        }),
        createdAt: now,
      });
      if (!markerResult.ok) {
        return markerResult;
      }
      continue;
    }
    const inserted = await insertRelation(db, {
      id: makeTypedId("rel", clock, random),
      repositoryId,
      fromEntityId: document.frontmatter.id,
      relationType: relation.type,
      toEntityId: relation.target,
      sourceKind: "canonical",
      createdAt: now,
    });
    if (!inserted.ok) {
      return inserted;
    }
  }
  return ok({ unresolved });
}

/**
 * `iroha sync` (implementation-plan.md WP-05, requirements.md Scenario C):
 * scans `.iroha/`, diffs it against this local DB's current
 * `canonical_documents`, and applies the difference — upserting
 * added/changed entities, recording a `sync_required` tombstone marker for
 * deletions that remain referenced (canonical-schema.md §13), and a
 * `canonical_db_divergence` marker for any file that failed to parse/
 * validate (so one malformed document does not abort the whole sync).
 * Idempotent: re-running with no on-disk changes touches nothing (every
 * write here is an upsert or an `ON CONFLICT DO NOTHING`).
 */
export async function syncCanonicalToDatabase(
  db: Database,
  repositoryId: TypedId<"repo">,
  irohaCanonicalDir: string,
  clock: Clock,
  random: RandomSource,
): Promise<Result<SyncCanonicalResult, IrohaError>> {
  const now = clock.now().toISOString();

  const scanResult = await scanCanonicalDirectory(irohaCanonicalDir);
  if (!scanResult.ok) {
    return scanResult;
  }
  const scan = scanResult.value;

  for (const failure of scan.errors) {
    const markerResult = await insertDirtyMarker(db, {
      id: makeTypedId("dirty", clock, random),
      repositoryId,
      markerType: "canonical_db_divergence",
      detailsJson: JSON.stringify({ path: failure.path, message: failure.error.message }),
      createdAt: now,
    });
    if (!markerResult.ok) {
      return markerResult;
    }
  }

  const baselineResult = await listCanonicalDocumentsByRepository(db, repositoryId);
  if (!baselineResult.ok) {
    return baselineResult;
  }
  const baseline = new Map(baselineResult.value.map((doc) => [doc.canonicalPath, doc.fileHash]));

  const diff = diffCanonicalFiles(scan, baseline);

  for (const entry of [...diff.added, ...diff.changed]) {
    const upserted = await upsertOneDocument(
      db,
      repositoryId,
      entry.path,
      entry.hash,
      entry.document,
      clock,
      random,
    );
    if (!upserted.ok) {
      return upserted;
    }
  }

  let unresolvedRelations = 0;
  for (const entry of [...diff.added, ...diff.changed]) {
    const relationsResult = await insertRelationsForDocument(
      db,
      repositoryId,
      entry.document,
      clock,
      random,
    );
    if (!relationsResult.ok) {
      return relationsResult;
    }
    unresolvedRelations += relationsResult.value.unresolved;
  }

  const tombstones = findTombstoneReferences(scan, diff.deletedPaths);
  const tombstonedByPath = new Map(
    baselineResult.value.map((doc) => [doc.canonicalPath, doc.entityId]),
  );
  for (const deletedPath of diff.deletedPaths) {
    const entityId = tombstonedByPath.get(deletedPath);
    if (entityId === undefined) {
      continue;
    }
    const statusResult = await updateEntityStatus(db, entityId, {
      status: "tombstoned",
      updatedAt: now,
    });
    if (!statusResult.ok) {
      return statusResult;
    }
    const reference = tombstones.find((t) => t.deletedId === entityId);
    if (reference !== undefined) {
      const markerResult = await insertDirtyMarker(db, {
        id: makeTypedId("dirty", clock, random),
        repositoryId,
        markerType: "sync_required",
        entityId,
        detailsJson: JSON.stringify({ reason: "tombstone_still_referenced", ...reference }),
        createdAt: now,
      });
      if (!markerResult.ok) {
        return markerResult;
      }
    }
  }

  const cursorResult = await upsertSyncCursor(db, {
    repositoryId,
    provider: SYNC_PROVIDER,
    lastSuccessAt: now,
    lastAttemptAt: now,
  });
  if (!cursorResult.ok) {
    return cursorResult;
  }

  return ok({
    added: diff.added.length,
    changed: diff.changed.length,
    unchanged: diff.unchanged.length,
    deleted: diff.deletedPaths.length,
    scanErrors: scan.errors.length,
    unresolvedRelations,
  });
}
