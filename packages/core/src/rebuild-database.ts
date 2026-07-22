import { access, rm } from "node:fs/promises";
import {
  type Clock,
  err,
  IrohaError,
  ok,
  type RandomSource,
  type Result,
  type TypedId,
} from "@iroha/domain";
import {
  checkIntegrity,
  closeDatabase,
  createSiblingDatabasePath,
  type Database,
  getEmbeddingVectorByContentHash,
  insertRepository,
  listSearchDocumentHashes,
  openDatabase,
  replaceDatabaseAtomically,
  runMigrations,
  upsertEmbedding,
} from "@iroha/storage";
import { computeRootFingerprint } from "./init-repository.js";
import { resolveInitializedRepository } from "./resolve-repository.js";
import { type SyncCanonicalResult, syncCanonicalToDatabase } from "./sync-canonical.js";

/**
 * Best-effort: the `.iroha` local database (including any sibling rebuild
 * artifact) is a disposable, rebuildable index, not canonical data, and each
 * sibling path carries a random suffix (`createSiblingDatabasePath`) so a
 * leftover file can never collide with a future rebuild. A transient
 * `EBUSY`/`EPERM` from the native libSQL binding's file-handle teardown
 * (still in flight right after this file's own `await closeDatabase(siblingDb)`
 * call, especially on Windows) is not worth retrying for — this always runs
 * on a failure path that is already reporting a real error, so it silently
 * leaves the orphaned file rather than spending time chasing a guarantee
 * the product does not need.
 */
async function removeSiblingDatabase(dbPath: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await rm(`${dbPath}${suffix}`, { force: true }).catch(() => undefined);
  }
}

/**
 * Carries already-computed embeddings from the current database into the fresh
 * sibling by content hash (database-schema.md §12 steps 8-9), so an unchanged
 * corpus does not re-hit the embedding provider after a rebuild. Best-effort
 * and fully offline: if the previous database is gone or unreadable — often the
 * very reason a rebuild is being run — reuse is silently skipped and the
 * sibling's pending `embedding_jobs` are embedded on the next `iroha sync`.
 * Each restored vector satisfies `runEmbeddingSync`'s content-hash guard, so
 * its job completes there without a provider call. Per-document read errors are
 * skipped for the same reason: a missing reuse only costs a re-embed, never
 * correctness.
 */
async function reuseEmbeddings(
  siblingDb: Database,
  primaryDbPath: string,
  clock: Clock,
): Promise<void> {
  // Only reuse from a database that already exists. `openDatabase` would
  // otherwise *create* the primary file — which, when the rebuild is running
  // precisely because that file is missing/deleted, would silently resurrect
  // it and defeat the atomic-swap failure path in `replaceDatabaseAtomically`.
  try {
    await access(primaryDbPath);
  } catch {
    return;
  }
  const primaryOpen = await openDatabase(primaryDbPath);
  if (!primaryOpen.ok) {
    return;
  }
  try {
    const hashes = await listSearchDocumentHashes(siblingDb);
    if (!hashes.ok) {
      return;
    }
    const now = clock.now().toISOString();
    for (const { searchDocumentId, contentHash } of hashes.value) {
      const vector = await getEmbeddingVectorByContentHash(primaryOpen.value, contentHash);
      if (!vector.ok || vector.value === null) {
        continue;
      }
      await upsertEmbedding(siblingDb, {
        searchDocumentId,
        contentHash,
        embedding: vector.value,
        createdAt: now,
      });
    }
  } finally {
    await closeDatabase(primaryOpen.value);
  }
}

export interface RebuildDatabaseResult {
  repositoryId: TypedId<"repo">;
  dbPath: string;
  /** `null` when the rebuild bootstrapped a fresh clone that had no local database to back up (issue #27). */
  backupPath: string | null;
  sync: SyncCanonicalResult;
}

/**
 * `iroha sync --rebuild` (database-schema.md §12, requirements.md Scenario
 * E): builds a fresh sibling database from `.iroha/` alone — Git history
 * and Forge metadata import (§12 steps 1/5) are out of WP-05's scope, and
 * embedding reuse (§12 steps 8-9) needs WP-08's embedding provider — then
 * validates it with `checkIntegrity` (§12 step 10) before ever touching the
 * live database. A canonical parse/schema error, or any integrity
 * violation, discards the sibling and leaves the primary database
 * untouched (§12: "fail the rebuild without replacing the current DB").
 *
 * On a fresh clone that has never been initialized locally — the git-tracked
 * `.iroha/` canonical files are present but the git-ignored primary `index.db`
 * does not exist yet — this bootstraps that database instead of failing
 * (requirements.md Scenario E, issue #27): `resolveInitializedRepository`
 * succeeds from `.iroha/config.yaml`, and `replaceDatabaseAtomically` installs
 * the rebuilt sibling with no backup (`backupPath: null`).
 */
export async function rebuildDatabase(
  cwd: string,
  clock: Clock,
  random: RandomSource,
  migrationsDir: string,
): Promise<Result<RebuildDatabaseResult, IrohaError>> {
  const resolvedResult = await resolveInitializedRepository(cwd);
  if (!resolvedResult.ok) {
    return resolvedResult;
  }
  const {
    gitLocation,
    irohaCanonicalDir,
    repositoryId,
    dbPath: primaryDbPath,
  } = resolvedResult.value;

  const siblingDbPath = createSiblingDatabasePath(primaryDbPath, random);

  const openResult = await openDatabase(siblingDbPath);
  if (!openResult.ok) {
    return openResult;
  }
  const siblingDb = openResult.value;

  const migrated = await runMigrations(siblingDb, migrationsDir, siblingDbPath, clock, {
    skipBackup: true,
  });
  if (!migrated.ok) {
    await closeDatabase(siblingDb);
    await removeSiblingDatabase(siblingDbPath);
    return migrated;
  }

  const now = clock.now().toISOString();
  const insertedRepository = await insertRepository(siblingDb, {
    id: repositoryId,
    rootFingerprint: computeRootFingerprint(gitLocation.commonDir),
    createdAt: now,
    updatedAt: now,
  });
  if (!insertedRepository.ok) {
    await closeDatabase(siblingDb);
    await removeSiblingDatabase(siblingDbPath);
    return insertedRepository;
  }

  const syncResult = await syncCanonicalToDatabase(
    siblingDb,
    repositoryId,
    irohaCanonicalDir,
    clock,
    random,
  );
  if (!syncResult.ok) {
    await closeDatabase(siblingDb);
    await removeSiblingDatabase(siblingDbPath);
    return syncResult;
  }

  await reuseEmbeddings(siblingDb, primaryDbPath, clock);

  const integrityResult = await checkIntegrity(siblingDb);
  if (!integrityResult.ok) {
    await closeDatabase(siblingDb);
    await removeSiblingDatabase(siblingDbPath);
    return integrityResult;
  }
  const integrity = integrityResult.value;
  const hasViolations =
    !integrity.sqliteIntegrityOk ||
    integrity.foreignKeyViolations.length > 0 ||
    integrity.applicationViolations.length > 0;
  if (hasViolations) {
    await closeDatabase(siblingDb);
    await removeSiblingDatabase(siblingDbPath);
    return err(
      new IrohaError("INTERNAL_ERROR", "Rebuild failed integrity checks", {
        details: { integrity },
      }),
    );
  }

  await closeDatabase(siblingDb);

  const replaced = await replaceDatabaseAtomically(primaryDbPath, siblingDbPath, clock);
  if (!replaced.ok) {
    // `replaceDatabaseAtomically` only ever fails before its rename of
    // `siblingDbPath` into `primaryDbPath` succeeds (each of its two
    // renames is atomic-or-untouched, and it already restores its own
    // partial state on a mid-sequence failure) — the sibling is still at
    // `siblingDbPath` either way, so it is safe (and, unlike every earlier
    // failure branch above, was previously missing) to clean it up here too.
    await removeSiblingDatabase(siblingDbPath);
    return replaced;
  }

  return ok({
    repositoryId,
    dbPath: primaryDbPath,
    backupPath: replaced.value.backupPath,
    sync: syncResult.value,
  });
}
