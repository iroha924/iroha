import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixedClock } from "@iroha/domain";
import { type Database, openDatabase } from "../connection.js";
import { runMigrations } from "../migrator.js";

/** Returns a fresh temp directory and the `index.db` path inside it (not yet created). */
export async function createTempDbPath(prefix = "iroha-storage-test-"): Promise<{
  dir: string;
  dbPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, dbPath: join(dir, "index.db") };
}

/**
 * Confirmed by CI reproduction (windows-2025): `db.close()` returns
 * synchronously, but the native libsql binding's own file-handle teardown
 * can still be in flight, so an immediately-following `rm()` sees `EBUSY`
 * ("resource busy or locked") on Windows even though POSIX allows deleting
 * an open file.
 *
 * `fs.rm`'s own `maxRetries`/`retryDelay` option exists for exactly this
 * error class, but confirmed by CI reproduction that it does not bound the
 * wait the way its docs describe here (every affected hook ran to exactly
 * vitest's 10000ms hook timeout instead of failing or succeeding within the
 * configured retry budget) — so this rolls its own short, explicitly bounded
 * retry instead of trusting that option. Each unique `mkdtemp` directory is
 * never reused by another test, and nothing in this suite reads it back
 * after cleanup, so giving up quietly once the budget is spent is safe: it
 * leaves an orphaned directory in the CI runner's temp folder (which the
 * runner discards at job end) rather than failing the test over cleanup
 * hygiene.
 */
export async function removeTempDir(dir: string): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") {
        throw cause;
      }
      if (attempt === maxAttempts) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
}

const REAL_MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations", import.meta.url));

/** Opens a fresh temp database with every `migrations/*.sql` file applied, ready for repository tests. */
export async function openMigratedTestDb(prefix = "iroha-storage-test-"): Promise<{
  dir: string;
  db: Database;
}> {
  const { dir, dbPath } = await createTempDbPath(prefix);
  const opened = await openDatabase(dbPath);
  if (!opened.ok) {
    throw new Error(`failed to open test database: ${opened.error.message}`);
  }
  const migrated = await runMigrations(
    opened.value,
    REAL_MIGRATIONS_DIR,
    dbPath,
    new FixedClock(new Date("2026-01-01T00:00:00.000Z")),
  );
  if (!migrated.ok) {
    throw new Error(`failed to migrate test database: ${migrated.error.message}`);
  }
  return { dir, db: opened.value };
}
