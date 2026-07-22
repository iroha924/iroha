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
  /**
   * Path of the timestamped backup of the previous database, or `null` when
   * there was no previous database to back up — a fresh clone that ran
   * `sync --rebuild` before any `iroha init` created `index.db` locally
   * (requirements.md Scenario E). See `replaceDatabaseAtomically`.
   */
  backupPath: string | null;
}

const WAL_SUFFIXES = ["-wal", "-shm"] as const;

/**
 * `rename()` with a bounded retry on `EBUSY`/`EPERM` — confirmed by
 * reproduction (Windows CI): a native libSQL connection's file-handle
 * teardown can still be in flight after this package's own
 * `closeDatabase()` call returns, so a `rename()` immediately following a
 * close can transiently fail even though every caller of this function has
 * already closed its connections per its own contract. This is the one
 * rename in this file that is on the actual product-required path
 * (database-schema.md §12 step 11, "atomically replace the DB"), so it gets
 * a real retry — but only a modest one: chasing a longer and longer budget
 * to make an occasional multi-second Windows CI stall disappear (observed up
 * to ~9s at least once, plausibly antivirus-related) is not a guarantee this
 * function needs to provide. If the lock genuinely does not clear within a
 * few seconds, surfacing a real, retryable error to the caller is the
 * correct behavior.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const maxAttempts = 10;
  const delayMs = 300;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM") || attempt === maxAttempts) {
        throw cause;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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
 *
 * Bootstrap case (requirements.md Scenario E, issue #27): when `primaryDbPath`
 * does not exist — a teammate who ran `sync --rebuild` on a fresh clone before
 * any `iroha init` created the git-ignored `index.db` locally — the move-aside
 * fails with `ENOENT`. There is then no current database to back up, so this
 * moves the rebuilt sibling straight into place and returns `backupPath: null`,
 * making `sync --rebuild` on a never-initialized clone just work.
 */
export async function replaceDatabaseAtomically(
  primaryDbPath: string,
  siblingDbPath: string,
  clock: Clock,
): Promise<Result<ReplaceDatabaseResult, IrohaError>> {
  const timestamp = clock.now().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${primaryDbPath}.backup-${timestamp}`;
  let bootstrapped = false;
  try {
    await renameWithRetry(primaryDbPath, backupPath);
    await renameSidecarIfExists(primaryDbPath, backupPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      // No current database to move aside — a fresh clone bootstrapping its
      // local index (see the doc comment above). `ENOENT` here can only mean
      // the move-aside source is missing: `renameSidecarIfExists` swallows its
      // own `ENOENT`, and the backup destination lives in the sibling's own
      // directory, which necessarily exists. Fall through to install the
      // sibling with no backup.
      bootstrapped = true;
    } else {
      // Best-effort recovery, mirroring the catch block below: if the main
      // rename succeeded but a sidecar rename then failed (plausible on
      // Windows, where this file already documents transient EBUSY/EPERM
      // issues), undo the partial move so this does not leave the repository
      // without a database at `primaryDbPath`.
      await rename(backupPath, primaryDbPath).catch(() => undefined);
      await renameSidecarIfExists(backupPath, primaryDbPath).catch(() => undefined);
      return err(
        new IrohaError("INTERNAL_ERROR", "Failed to move aside the current database", { cause }),
      );
    }
  }
  try {
    await renameWithRetry(siblingDbPath, primaryDbPath);
    await renameSidecarIfExists(siblingDbPath, primaryDbPath);
  } catch (cause) {
    // Best-effort recovery: restore the original database (and its sidecars)
    // so a failed rebuild does not leave the repository without any database
    // at all. When bootstrapping there was no prior database to restore — the
    // repository simply stays without one, exactly as it was before this call.
    if (!bootstrapped) {
      await rename(backupPath, primaryDbPath).catch(() => undefined);
      await renameSidecarIfExists(backupPath, primaryDbPath).catch(() => undefined);
    }
    return err(
      new IrohaError("INTERNAL_ERROR", "Failed to move the rebuilt database into place", { cause }),
    );
  }
  return ok({ backupPath: bootstrapped ? null : backupPath });
}
