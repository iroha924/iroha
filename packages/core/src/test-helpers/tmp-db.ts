import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixedClock } from "@iroha/domain";
import { type Database, openDatabase, runMigrations } from "@iroha/storage";

const REAL_MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations", import.meta.url));

/** Opens a fresh temp database with every `migrations/*.sql` file applied, ready for core use-case tests. */
export async function openMigratedTestDb(prefix = "iroha-core-test-"): Promise<{
  dir: string;
  db: Database;
}> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const dbPath = join(dir, "index.db");
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

/** Windows file-handle teardown lag — see `@iroha/storage`'s `test-helpers/tmp-db.ts` for the reproduction. */
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
