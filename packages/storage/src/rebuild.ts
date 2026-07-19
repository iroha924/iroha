import { rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Clock, err, IrohaError, ok, type RandomSource, type Result } from "@iroha/domain";

/**
 * implementation/database-schema.md §12 step 2: "create a sibling DB with a
 * random temporary name". Only builds the path — callers open/migrate it
 * themselves (`openDatabase`/`runMigrations` with `skipBackup: true`, since
 * a brand-new sibling has nothing yet worth backing up).
 */
export function createSiblingDatabasePath(primaryDbPath: string, random: RandomSource): string {
  const suffix = Buffer.from(random.bytes(8)).toString("hex");
  return join(dirname(primaryDbPath), `index.rebuild-${suffix}.db`);
}

export interface ReplaceDatabaseResult {
  backupPath: string;
}

const WAL_SUFFIXES = ["-wal", "-shm"] as const;

/**
 * `rename()` with a bounded retry on `EBUSY`/`EPERM` — confirmed by
 * reproduction (Windows CI): a native libSQL connection's file-handle
 * teardown can still be in flight for a short window after this package's
 * own `closeDatabase()` call returns (the same lag `windows-ci-compat.md`
 * documents for `rm()`), so a `rename()` immediately following a close can
 * transiently fail even though every caller of this function has already
 * closed its connections per its own contract. Two smaller budgets (5
 * attempts/1.5s, then 8 attempts/3.6s) both proved insufficient on Windows
 * CI when the rename follows immediately after the close in the same call
 * stack (as opposed to after other work has run, which is what the
 * originally-verified 5-attempt budget in `@iroha/storage`'s own
 * `test-helpers/tmp-db.ts` relies on). This budget caps each backoff step at
 * 500ms and allows up to 20 attempts (~9s worst case) to cover a
 * multi-second teardown lag without retrying indefinitely.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const maxAttempts = 20;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM") || attempt === maxAttempts) {
        throw cause;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 100, 500)));
    }
  }
}

/** Renames `<fromBase><suffix>` to `<toBase><suffix>` if it exists; a no-op otherwise. */
async function renameSidecarIfExists(fromBase: string, toBase: string): Promise<void> {
  for (const suffix of WAL_SUFFIXES) {
    try {
      await renameWithRetry(`${fromBase}${suffix}`, `${toBase}${suffix}`);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw cause;
      }
    }
  }
}

/**
 * implementation/database-schema.md §12 steps 11–12: atomically swaps the
 * rebuilt sibling database into place and retains the previous database as
 * a timestamped backup. Callers must close every connection to both
 * `primaryDbPath` and `siblingDbPath` first — this function only renames
 * files, it does not manage connection lifecycle or WAL checkpointing
 * (`migrator.ts`'s `backupDatabaseFile` shows the checkpoint-before-copy
 * pattern this rebuild flow relies on its caller having already applied to
 * the sibling before calling this).
 *
 * Renames `primaryDbPath` out of the way before moving `siblingDbPath` into
 * its place, so neither `rename()` call ever needs to overwrite an existing
 * destination (Node's `fs.rename` does support overwriting on both POSIX
 * and Windows, but avoiding it removes that platform-behavior dependency
 * entirely). Also moves each side's `-wal`/`-shm` sidecar files if present,
 * so a sibling not fully checkpointed by its caller doesn't silently lose
 * data left only in its `-wal` file — confirmed by reproduction that
 * `PRAGMA wal_checkpoint(TRUNCATE)` plus closing the connection does not by
 * itself delete these files, only truncate their content.
 */
export async function replaceDatabaseAtomically(
  primaryDbPath: string,
  siblingDbPath: string,
  clock: Clock,
): Promise<Result<ReplaceDatabaseResult, IrohaError>> {
  const timestamp = clock.now().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${primaryDbPath}.backup-${timestamp}`;
  try {
    await renameWithRetry(primaryDbPath, backupPath);
    await renameSidecarIfExists(primaryDbPath, backupPath);
  } catch (cause) {
    // Best-effort recovery, mirroring the catch block below: if the main
    // rename succeeded but a sidecar rename then failed (plausible on
    // Windows, where this file already documents transient EBUSY/EPERM
    // issues), undo the partial move so this does not leave the repository
    // without a database at `primaryDbPath`. A no-op when the main rename
    // itself is what failed, since there is then nothing to move back.
    await rename(backupPath, primaryDbPath).catch(() => undefined);
    await renameSidecarIfExists(backupPath, primaryDbPath).catch(() => undefined);
    return err(
      new IrohaError("INTERNAL_ERROR", "Failed to move aside the current database", { cause }),
    );
  }
  try {
    await renameWithRetry(siblingDbPath, primaryDbPath);
    await renameSidecarIfExists(siblingDbPath, primaryDbPath);
  } catch (cause) {
    // Best-effort recovery: restore the original database (and its
    // sidecars) so a failed rebuild does not leave the repository without
    // any database at all.
    await rename(backupPath, primaryDbPath).catch(() => undefined);
    await renameSidecarIfExists(backupPath, primaryDbPath).catch(() => undefined);
    return err(
      new IrohaError("INTERNAL_ERROR", "Failed to move the rebuilt database into place", { cause }),
    );
  }
  return ok({ backupPath });
}
