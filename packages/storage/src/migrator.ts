import { createHash } from "node:crypto";
import { copyFile, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type Clock, err, IrohaError, ok, type Result } from "@iroha/domain";
import type { Database } from "./connection.js";
import { mapLibsqlError } from "./errors.js";

/**
 * implementation/database-schema.md §4 says migration files are named
 * `<four-digit>_<name>.sql`, but the only actual migration file,
 * `migrations/001_initial.sql`, uses a 3-digit prefix, and every other
 * cross-reference in the doc bundle (design.md, README.md, decision-log.md,
 * validation-report.md) also cites "001_initial.sql". Rather than picking a
 * side of that prose/filename disagreement, this accepts any digit-count
 * numeric prefix — see implementation/decision-log.md ID-024.
 */
const MIGRATION_FILENAME_PATTERN = /^(\d+)_(.+)\.sql$/;

export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  /** `sha256:<hex>`, matching `schema_migrations.checksum`'s CHECK constraint. */
  checksum: string;
  sql: string;
}

function computeChecksum(sql: string): string {
  return `sha256:${createHash("sha256").update(sql).digest("hex")}`;
}

/** Reads and parses every `<digits>_<name>.sql` file in `migrationsDir`, sorted by version. */
export async function loadMigrations(
  migrationsDir: string,
): Promise<Result<MigrationFile[], IrohaError>> {
  let entries: string[];
  try {
    entries = await readdir(migrationsDir);
  } catch (cause) {
    return err(new IrohaError("INTERNAL_ERROR", "Failed to read migrations directory", { cause }));
  }

  const files: MigrationFile[] = [];
  for (const entry of entries) {
    const match = MIGRATION_FILENAME_PATTERN.exec(entry);
    if (!match) {
      continue;
    }
    const versionText = match[1];
    const name = match[2];
    if (versionText === undefined || name === undefined) {
      continue;
    }
    const sql = await readFile(join(migrationsDir, entry), "utf8");
    files.push({
      version: Number.parseInt(versionText, 10),
      name,
      filename: entry,
      checksum: computeChecksum(sql),
      sql,
    });
  }
  files.sort((a, b) => a.version - b.version);

  for (let i = 1; i < files.length; i++) {
    const previous = files[i - 1];
    const current = files[i];
    if (previous !== undefined && current !== undefined && previous.version === current.version) {
      return err(
        new IrohaError("INTERNAL_ERROR", `Two migration files claim version ${current.version}`, {
          details: { version: current.version, filenames: [previous.filename, current.filename] },
        }),
      );
    }
  }

  return ok(files);
}

interface AppliedMigration {
  version: number;
  checksum: string;
}

async function getAppliedMigrations(
  db: Database,
): Promise<Result<Map<number, AppliedMigration>, IrohaError>> {
  try {
    const tableCheck = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    );
    if (tableCheck.rows.length === 0) {
      return ok(new Map());
    }
    const rows = await db.execute("SELECT version, checksum FROM schema_migrations");
    return ok(
      new Map(
        rows.rows.map((row) => [
          Number(row.version),
          { version: Number(row.version), checksum: String(row.checksum) },
        ]),
      ),
    );
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to read schema_migrations"));
  }
}

/** Copies `<path><suffix>` to `<destination><suffix>` if the source exists; a no-op otherwise. */
async function copySidecarIfExists(
  path: string,
  destination: string,
  suffix: string,
): Promise<void> {
  try {
    await copyFile(`${path}${suffix}`, `${destination}${suffix}`);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      throw cause;
    }
  }
}

/**
 * Flushes WAL content into the main database file (implementation/
 * database-schema.md §3 keeps journal_mode=WAL on), then copies it next to
 * itself with a timestamp suffix. A missing source file (a brand-new,
 * not-yet-migrated database) has nothing to preserve, so that is treated as
 * a no-op rather than an error.
 *
 * `PRAGMA wal_checkpoint(TRUNCATE)` does not throw when it cannot fully
 * checkpoint — confirmed by reproduction that a concurrent reader blocking
 * the checkpoint makes it return a result row (`{busy: 1, log, checkpointed}`)
 * instead. Rather than inspecting that row to decide whether it's safe to
 * copy only the main file, this always also copies the `-wal`/`-shm`
 * sidecar files (when present) alongside the backup, so the backup is
 * self-consistent regardless of whether the checkpoint fully completed.
 */
async function backupDatabaseFile(
  db: Database,
  dbPath: string,
  clock: Clock,
): Promise<Result<true, IrohaError>> {
  try {
    await stat(dbPath);
  } catch {
    return ok(true);
  }

  try {
    await db.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to checkpoint database before backup"));
  }

  const timestamp = clock.now().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.backup-${timestamp}`;
  try {
    await copyFile(dbPath, backupPath);
    await copySidecarIfExists(dbPath, backupPath, "-wal");
    await copySidecarIfExists(dbPath, backupPath, "-shm");
    return ok(true);
  } catch (cause) {
    return err(
      new IrohaError("INTERNAL_ERROR", "Failed to back up database before migration", { cause }),
    );
  }
}

export interface AppliedMigrationResult {
  version: number;
  name: string;
}

export interface RunMigrationsOptions {
  /**
   * Skips the pre-migration backup — for a brand-new sibling database
   * created by `sync --rebuild`, per implementation/database-schema.md §4
   * ("unless it is being rebuilt from scratch"). Defaults to `false`.
   */
  skipBackup?: boolean;
}

/**
 * Applies every migration in `migrationsDir` not yet recorded in
 * `schema_migrations`, in version order. Each file is expected to be
 * self-contained (its own `BEGIN IMMEDIATE`/`COMMIT`, matching
 * `migrations/001_initial.sql`) — this runner records the bookkeeping row
 * in `schema_migrations` as a separate statement only after that file's own
 * transaction has already committed, so a crash between the two leaves
 * `PRAGMA user_version` ahead of `schema_migrations` (detectable, not
 * silently lost) rather than a partially-applied migration.
 */
export async function runMigrations(
  db: Database,
  migrationsDir: string,
  dbPath: string,
  clock: Clock,
  options: RunMigrationsOptions = {},
): Promise<Result<AppliedMigrationResult[], IrohaError>> {
  const filesResult = await loadMigrations(migrationsDir);
  if (!filesResult.ok) {
    return filesResult;
  }
  const files = filesResult.value;

  const appliedResult = await getAppliedMigrations(db);
  if (!appliedResult.ok) {
    return appliedResult;
  }
  const applied = appliedResult.value;

  // Drift recovery: a migration file's own transaction (its DDL plus
  // `PRAGMA user_version`) can commit while the separate `schema_migrations`
  // bookkeeping `INSERT` a few lines below never runs — a crash between the
  // two leaves `PRAGMA user_version` ahead of what `applied` records. A
  // naive retry would then treat that file as pending and re-execute its
  // DDL, which fails ("table already exists") instead of recovering. Any
  // file whose version is already reflected in `user_version` but missing
  // from `applied` is backfilled here (using that file's own checksum, not
  // re-run) rather than treated as pending.
  const userVersionBeforeResult = await db.execute("PRAGMA user_version");
  const userVersionBefore = Number(userVersionBeforeResult.rows[0]?.user_version ?? 0);
  for (const file of files) {
    if (file.version <= userVersionBefore && !applied.has(file.version)) {
      try {
        await db.execute({
          sql: "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
          args: [file.version, file.name, file.checksum, clock.now().toISOString()],
        });
      } catch (cause) {
        return err(
          mapLibsqlError(
            cause,
            `Failed to backfill schema_migrations for already-applied migration ${file.filename}`,
          ),
        );
      }
      applied.set(file.version, { version: file.version, checksum: file.checksum });
    }
  }

  for (const file of files) {
    const existing = applied.get(file.version);
    if (existing !== undefined && existing.checksum !== file.checksum) {
      return err(
        new IrohaError(
          "SCHEMA_MISMATCH",
          `Migration ${file.filename} has changed since it was applied`,
          { details: { version: file.version } },
        ),
      );
    }
  }

  const pending = files.filter((file) => !applied.has(file.version));
  if (pending.length === 0) {
    return ok([]);
  }

  // `applied.size > 0` — not mere file existence — decides whether this is
  // an "in-place migration" worth protecting: `openDatabase` already
  // creates an empty database file on first open, before any migration has
  // run, and backing that up would copy nothing of value.
  if (options.skipBackup !== true && applied.size > 0) {
    const backupResult = await backupDatabaseFile(db, dbPath, clock);
    if (!backupResult.ok) {
      return backupResult;
    }
  }

  const results: AppliedMigrationResult[] = [];
  for (const file of pending) {
    try {
      await db.executeMultiple(file.sql);
    } catch (cause) {
      return err(mapLibsqlError(cause, `Migration ${file.filename} failed`));
    }
    try {
      await db.execute({
        sql: "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        args: [file.version, file.name, file.checksum, clock.now().toISOString()],
      });
    } catch (cause) {
      return err(
        mapLibsqlError(cause, `Migration ${file.filename} committed but recording it failed`),
      );
    }
    results.push({ version: file.version, name: file.name });
  }

  const userVersionResult = await db.execute("PRAGMA user_version");
  const userVersion = Number(userVersionResult.rows[0]?.user_version ?? 0);
  const maxKnownVersion = Math.max(...files.map((file) => file.version));
  if (userVersion !== maxKnownVersion) {
    return err(
      new IrohaError(
        "SCHEMA_MISMATCH",
        "schema_migrations and PRAGMA user_version disagree after migration",
        { details: { userVersion, maxKnownVersion } },
      ),
    );
  }

  return ok(results);
}
