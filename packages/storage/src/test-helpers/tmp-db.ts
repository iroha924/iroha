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

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
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
