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
 * entirely).
 */
export async function replaceDatabaseAtomically(
  primaryDbPath: string,
  siblingDbPath: string,
  clock: Clock,
): Promise<Result<ReplaceDatabaseResult, IrohaError>> {
  const timestamp = clock.now().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${primaryDbPath}.backup-${timestamp}`;
  try {
    await rename(primaryDbPath, backupPath);
  } catch (cause) {
    return err(
      new IrohaError("INTERNAL_ERROR", "Failed to move aside the current database", { cause }),
    );
  }
  try {
    await rename(siblingDbPath, primaryDbPath);
  } catch (cause) {
    // Best-effort recovery: restore the original database so a failed
    // rebuild does not leave the repository without any database at all.
    await rename(backupPath, primaryDbPath).catch(() => undefined);
    return err(
      new IrohaError("INTERNAL_ERROR", "Failed to move the rebuilt database into place", { cause }),
    );
  }
  return ok({ backupPath });
}
