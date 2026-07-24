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
  deleteCanonicalRelationsFromEntity,
  type Executor,
  enqueueEmbeddingJob,
  getEntityById,
  getSearchDocumentByEntityId,
  insertDirtyMarker,
  insertRelation,
  listCanonicalDocumentsByRepository,
  type UpsertKnowledgeItemInput,
  updateEntityStatus,
  upsertCanonicalDocument,
  upsertEntity,
  upsertKnowledgeItem,
  upsertSearchDocument,
  upsertSyncCursor,
  withTransaction,
} from "@iroha/storage";

/**
 * database-schema.md §6: approved canonical = 100 is the only documented tier. A
 * superseded/archived document must not tie current knowledge in ranking, so it is
 * tiered below (decision-log ID-048): `superseded = 70`, `archived = 60`. Both stay
 * **at or above** the `DEFAULT_MINIMUM_AUTHORITY` floor (60) on purpose — dropping
 * a status below it would exclude those rows only *after* the top-N FTS/vector
 * candidate cap, so a burst of low-authority matches could starve the candidate set
 * of visible knowledge. Being below the 80-99/100 boost buckets is enough to rank
 * them under current knowledge without hiding them. Applied to both the entity and
 * the search_document authority (the two ranking paths read different columns).
 */
function authorityForStatus(status: "approved" | "superseded" | "archived"): number {
  switch (status) {
    case "approved":
      return 100;
    case "superseded":
      return 70;
    case "archived":
      return 60;
  }
}
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

/**
 * Imports one already-written canonical document into the local DB — the
 * entity, `canonical_documents` row, `search_documents` row, and an enqueued
 * embedding job — at an authority tiered by lifecycle status (`authorityForStatus`,
 * `source_kind = 'canonical'`). Exported so
 * the WP-09 approval transaction (design.md §10 / ID-025(2)) reuses the exact
 * same import path `sync --rebuild` uses, guaranteeing that approving a
 * candidate and rebuilding from `.iroha/` produce byte-identical DB rows
 * (`path`/`hash` must be `computeCanonicalPath`/the file SHA-256, as the
 * canonical scan produces). It also projects every knowledge-type document
 * into `knowledge_items` (WP-10, closing decision-log ID-033), so approved
 * Rules/Decisions are visible to `listApprovedRulesForRepository` (SessionStart
 * context, MCP `get_active_rules`) and PreToolUse guardrail evaluation — for
 * both `sync`/`--rebuild` and the approval transaction, keeping them equivalent.
 */
export async function importCanonicalDocument(
  db: Executor,
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
    authority: authorityForStatus(frontmatter.status),
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

  // Project knowledge-type documents (every canonical type except
  // session_summary) into `knowledge_items`. A guardrail Rule carries its
  // machine-evaluable guard spec (canonical-schema.md §7); every other item is
  // advisory. The Zod-validated canonical document guarantees a guardrail Rule
  // has a `guard` object, so the `guard !== undefined` check only satisfies the
  // type-checker (the advisory fallback is unreachable for a guardrail Rule).
  if (frontmatter.type !== "session_summary") {
    const knowledgeCommon = {
      id: frontmatter.id,
      knowledgeType: frontmatter.type,
      body,
      scopeJson: JSON.stringify(frontmatter.scope),
      approvedAt: frontmatter.approved_at,
      canonicalPath: path,
      // Only a Rule carries the info/warning/error severity; every other type
      // leaves the column NULL (audit issue #30).
      ...(frontmatter.type === "rule" ? { severity: frontmatter.rule.severity } : {}),
    };
    const knowledgeInput: UpsertKnowledgeItemInput =
      frontmatter.type === "rule" &&
      frontmatter.rule.enforcement === "guardrail" &&
      frontmatter.rule.guard !== undefined
        ? {
            ...knowledgeCommon,
            enforcement: "guardrail",
            guardSpecJson: JSON.stringify(frontmatter.rule.guard),
          }
        : { ...knowledgeCommon, enforcement: "advisory" };
    const knowledgeResult = await upsertKnowledgeItem(db, knowledgeInput);
    if (!knowledgeResult.ok) {
      return knowledgeResult;
    }
  }

  const searchResult = await upsertSearchDocument(db, {
    id: makeTypedId("sdoc", clock, random),
    entityId: frontmatter.id,
    documentKind: frontmatter.type,
    title: frontmatter.title,
    body,
    codeTerms: frontmatter.scope.symbols.join(" "),
    authority: authorityForStatus(frontmatter.status),
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
export async function insertCanonicalDocumentRelations(
  db: Executor,
  repositoryId: TypedId<"repo">,
  document: CanonicalDocument,
  clock: Clock,
  random: RandomSource,
): Promise<Result<{ unresolved: number }, IrohaError>> {
  const now = clock.now().toISOString();
  // Reconcile: relation import is otherwise insert-only, so an edge removed from
  // this document's `relations[]` would survive a re-sync until a full rebuild.
  // Drop this document's existing canonical edges first, then re-insert the
  // current set below. Scoped to `source_kind='canonical'` from this entity, so
  // other sources / other documents' edges / incoming edges are untouched. The
  // caller runs this in a transaction (approve does; `syncCanonicalToDatabase`
  // wraps its per-document call) so a crash cannot leave the doc without edges.
  const pruned = await deleteCanonicalRelationsFromEntity(db, document.frontmatter.id);
  if (!pruned.ok) {
    return pruned;
  }
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
 *
 * `reprojectAll` re-imports every canonical document, not just the ones whose
 * file hash changed. A schema migration can add a projected column
 * (`migrations/004_knowledge_items_severity.sql`), which the incremental
 * hash-diff cannot backfill for an *unchanged* file — its hash still matches, so
 * it never re-imports and the new column stays NULL. `runSync` sets this on the
 * run where a migration was applied, so the projection is reconciled with the
 * new schema without a full `sync --rebuild`. Re-importing an unchanged document
 * is idempotent (every write is an upsert).
 */
export async function syncCanonicalToDatabase(
  db: Database,
  repositoryId: TypedId<"repo">,
  irohaCanonicalDir: string,
  clock: Clock,
  random: RandomSource,
  reprojectAll = false,
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
  // On a reproject run, an unchanged document is re-imported too so a newly
  // migrated projected column is backfilled from canonical (see the docstring).
  const toImport = reprojectAll
    ? [...diff.added, ...diff.changed, ...diff.unchanged]
    : [...diff.added, ...diff.changed];

  for (const entry of toImport) {
    const upserted = await importCanonicalDocument(
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
  for (const entry of toImport) {
    // One transaction per document so the delete-then-insert reconcile in
    // `insertCanonicalDocumentRelations` is atomic (the approve path wraps its
    // own call the same way). `db` here is always a `Database`, never a nested
    // transaction — `syncCanonicalToDatabase`'s callers pass an open connection.
    const relationsResult = await withTransaction(db, "write", (tx) =>
      insertCanonicalDocumentRelations(tx, repositoryId, entry.document, clock, random),
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
