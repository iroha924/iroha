import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixedClock } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database, openDatabase } from "./connection.js";
import { loadMigrations, runMigrations } from "./migrator.js";
import { createTempDbPath, removeTempDir } from "./test-helpers/tmp-db.js";

const REAL_MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));
const CLOCK = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));

async function copyMigrationsDir(throughVersion = Number.POSITIVE_INFINITY): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iroha-migrations-fixture-"));
  const entries = await readdir(REAL_MIGRATIONS_DIR);
  for (const entry of entries) {
    if (Number.parseInt(entry, 10) > throughVersion) {
      continue;
    }
    const content = await readFile(join(REAL_MIGRATIONS_DIR, entry), "utf8");
    await writeFile(join(dir, entry), content, "utf8");
  }
  return dir;
}

/**
 * The minimum `tool_events` ancestry the foreign keys demand, so an upgrade runs
 * against a *populated* table rather than an empty one.
 */
async function seedDeniedToolEvent(db: Database): Promise<void> {
  const at = "2026-07-20T00:00:00.000Z";
  await db.executeMultiple(`
    INSERT INTO repositories (id, vcs, root_fingerprint, created_at, updated_at)
      VALUES ('repo_1', 'git', 'fp_1', '${at}', '${at}');
    INSERT INTO entities (id, repository_id, entity_type, title, status, source_kind, created_at, updated_at)
      VALUES ('ses_1', 'repo_1', 'session', 'a session', 'active', 'hook', '${at}', '${at}');
    INSERT INTO agent_sessions (id, repository_id, platform, started_at, last_seen_at)
      VALUES ('ses_1', 'repo_1', 'claude_code', '${at}', '${at}');
    INSERT INTO session_runs (id, session_id, start_source, cwd_fingerprint, started_at, status)
      VALUES ('run_1', 'ses_1', 'startup', 'fp_cwd', '${at}', 'active');
    INSERT INTO turns (id, run_id, started_at, status)
      VALUES ('trn_1', 'run_1', '${at}', 'active');
    INSERT INTO tool_events (id, turn_id, tool_name, phase, status, occurred_at)
      VALUES ('evt_1', 'trn_1', 'Edit', 'denied', 'denied', '${at}');
  `);
}

describe("runMigrations", () => {
  let tempDirs: string[] = [];
  let dbs: Database[] = [];

  afterEach(async () => {
    for (const db of dbs) {
      await closeDatabase(db);
    }
    dbs = [];
    for (const dir of tempDirs) {
      await removeTempDir(dir);
    }
    tempDirs = [];
  });

  it("applies the real migration to a fresh empty database", async () => {
    const { dir, dbPath } = await createTempDbPath();
    tempDirs.push(dir);
    const opened = await openDatabase(dbPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    dbs.push(opened.value);

    const result = await runMigrations(opened.value, REAL_MIGRATIONS_DIR, dbPath, CLOCK);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { version: 1, name: "initial" },
        { version: 2, name: "session_tokens" },
        { version: 3, name: "relations_reverse_index" },
        { version: 4, name: "knowledge_items_severity" },
        { version: 5, name: "tool_events_denied_rule" },
        { version: 6, name: "digest_issues" },
        { version: 7, name: "drop_imported_doc_candidates" },
      ]);
    }

    const tables = await opened.value.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('entities', 'session_tokens')",
    );
    expect(tables.rows.length).toBe(2);

    const migrations = await opened.value.execute(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    );
    expect(migrations.rows.length).toBe(7);
    expect(migrations.rows[0]?.version).toBe(1);
    expect(migrations.rows[1]?.version).toBe(2);
    expect(migrations.rows[2]?.version).toBe(3);
    expect(migrations.rows[3]?.version).toBe(4);
    expect(migrations.rows[4]?.version).toBe(5);
    expect(migrations.rows[5]?.version).toBe(6);
    expect(migrations.rows[6]?.version).toBe(7);

    const userVersion = await opened.value.execute("PRAGMA user_version");
    expect(userVersion.rows[0]?.user_version).toBe(7);
  });

  it("is a no-op the second time it runs against an already-migrated database", async () => {
    const { dir, dbPath } = await createTempDbPath();
    tempDirs.push(dir);
    const opened = await openDatabase(dbPath);
    if (!opened.ok) throw new Error("failed to open database");
    dbs.push(opened.value);

    await runMigrations(opened.value, REAL_MIGRATIONS_DIR, dbPath, CLOCK);
    const second = await runMigrations(opened.value, REAL_MIGRATIONS_DIR, dbPath, CLOCK);

    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value).toEqual([]);
    }
  });

  it("fails with SCHEMA_MISMATCH when an already-applied migration file's content changes", async () => {
    const migrationsDir = await copyMigrationsDir();
    tempDirs.push(migrationsDir);
    const { dir, dbPath } = await createTempDbPath();
    tempDirs.push(dir);
    const opened = await openDatabase(dbPath);
    if (!opened.ok) throw new Error("failed to open database");
    dbs.push(opened.value);

    const first = await runMigrations(opened.value, migrationsDir, dbPath, CLOCK);
    expect(first.ok).toBe(true);

    await writeFile(
      join(migrationsDir, "001_initial.sql"),
      `${await readFile(join(migrationsDir, "001_initial.sql"), "utf8")}\n-- tampered`,
      "utf8",
    );

    const second = await runMigrations(opened.value, migrationsDir, dbPath, CLOCK);

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("SCHEMA_MISMATCH");
    }
  });

  it("applies a second migration in sequence and keeps user_version/schema_migrations in agreement", async () => {
    const migrationsDir = await copyMigrationsDir();
    tempDirs.push(migrationsDir);
    await writeFile(
      join(migrationsDir, "008_add_synthetic_table.sql"),
      "BEGIN IMMEDIATE;\nCREATE TABLE synthetic_two (id INTEGER PRIMARY KEY);\nPRAGMA user_version = 8;\nCOMMIT;\n",
      "utf8",
    );
    const { dir, dbPath } = await createTempDbPath();
    tempDirs.push(dir);
    const opened = await openDatabase(dbPath);
    if (!opened.ok) throw new Error("failed to open database");
    dbs.push(opened.value);

    const result = await runMigrations(opened.value, migrationsDir, dbPath, CLOCK);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    }
    const userVersion = await opened.value.execute("PRAGMA user_version");
    expect(userVersion.rows[0]?.user_version).toBe(8);
    const migrations = await opened.value.execute(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(migrations.rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("upgrades a populated database from the previous release's schema in place", async () => {
    // What an existing install actually does on upgrade: the fresh-database test
    // above applies every migration to an empty file, which exercises neither
    // `ALTER TABLE` against existing rows nor the row-preservation the user cares
    // about. Pinned to the last released schema version rather than
    // `latest - 1`, so it keeps testing the real upgrade edge as more land.
    const releasedDir = await copyMigrationsDir(4);
    tempDirs.push(releasedDir);
    const { dir, dbPath } = await createTempDbPath();
    tempDirs.push(dir);
    const opened = await openDatabase(dbPath);
    if (!opened.ok) throw new Error("failed to open database");
    dbs.push(opened.value);

    const released = await runMigrations(opened.value, releasedDir, dbPath, CLOCK);
    expect(released.ok).toBe(true);
    const releasedVersion = await opened.value.execute("PRAGMA user_version");
    expect(releasedVersion.rows[0]?.user_version).toBe(4);
    await seedDeniedToolEvent(opened.value);

    const upgraded = await runMigrations(opened.value, REAL_MIGRATIONS_DIR, dbPath, CLOCK);

    expect(upgraded.ok).toBe(true);
    if (upgraded.ok) {
      expect(upgraded.value).toEqual([
        { version: 5, name: "tool_events_denied_rule" },
        { version: 6, name: "digest_issues" },
        { version: 7, name: "drop_imported_doc_candidates" },
      ]);
    }
    const userVersion = await opened.value.execute("PRAGMA user_version");
    expect(userVersion.rows[0]?.user_version).toBe(7);

    // The pre-existing row survives, and its new column defaults to unattributed
    // rather than to a rule it was never denied by.
    const event = await opened.value.execute(
      "SELECT id, status, denied_by_rule_id FROM tool_events WHERE id = 'evt_1'",
    );
    expect(event.rows[0]?.status).toBe("denied");
    expect(event.rows[0]?.denied_by_rule_id).toBe(null);

    // The digest store is writable at its full shape, `period_end` included —
    // pruning ages on that column, so a missing one silently keeps prose forever.
    await opened.value.execute({
      sql: `INSERT INTO digest_issues
              (repository_id, period_unit, period_key, period_end, prose_json, composed_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        "repo_1",
        "week",
        "2026-W30",
        "2026-07-27T00:00:00.000Z",
        '{"headline":"h"}',
        "2026-07-26T00:00:00.000Z",
      ],
    });
    const issues = await opened.value.execute("SELECT period_key FROM digest_issues");
    expect(issues.rows[0]?.period_key).toBe("2026-W30");
  });

  it("backs up the database file before applying a migration to an existing database", async () => {
    const migrationsDir = await copyMigrationsDir();
    tempDirs.push(migrationsDir);
    const { dir, dbPath } = await createTempDbPath();
    tempDirs.push(dir);
    const opened = await openDatabase(dbPath);
    if (!opened.ok) throw new Error("failed to open database");
    dbs.push(opened.value);

    await runMigrations(opened.value, migrationsDir, dbPath, CLOCK);

    await writeFile(
      join(migrationsDir, "008_add_synthetic_table.sql"),
      "BEGIN IMMEDIATE;\nCREATE TABLE synthetic_two (id INTEGER PRIMARY KEY);\nPRAGMA user_version = 8;\nCOMMIT;\n",
      "utf8",
    );

    await runMigrations(opened.value, migrationsDir, dbPath, CLOCK);

    const entries = await readdir(dir);
    expect(entries.some((entry) => entry.includes(".backup-"))).toBe(true);
  });

  it("does not create a backup file when skipBackup is set", async () => {
    const migrationsDir = await copyMigrationsDir();
    tempDirs.push(migrationsDir);
    const { dir, dbPath } = await createTempDbPath();
    tempDirs.push(dir);
    const opened = await openDatabase(dbPath);
    if (!opened.ok) throw new Error("failed to open database");
    dbs.push(opened.value);

    await runMigrations(opened.value, migrationsDir, dbPath, CLOCK);

    await writeFile(
      join(migrationsDir, "008_add_synthetic_table.sql"),
      "BEGIN IMMEDIATE;\nCREATE TABLE synthetic_two (id INTEGER PRIMARY KEY);\nPRAGMA user_version = 8;\nCOMMIT;\n",
      "utf8",
    );

    await runMigrations(opened.value, migrationsDir, dbPath, CLOCK, { skipBackup: true });

    const entries = await readdir(dir);
    expect(entries.some((entry) => entry.includes(".backup-"))).toBe(false);
  });

  it("backfills schema_migrations instead of re-running SQL when user_version is ahead (crash recovery)", async () => {
    const migrationsDir = await copyMigrationsDir();
    tempDirs.push(migrationsDir);
    const { dir, dbPath } = await createTempDbPath();
    tempDirs.push(dir);
    const opened = await openDatabase(dbPath);
    if (!opened.ok) throw new Error("failed to open database");
    dbs.push(opened.value);

    // Simulate a process that committed migration 001's own transaction
    // (its DDL + `PRAGMA user_version = 1`) but crashed before the separate
    // `schema_migrations` bookkeeping INSERT that `runMigrations` normally
    // issues right after — a naive retry would re-run this SQL and fail with
    // "table already exists".
    const migrationsLoaded = await loadMigrations(migrationsDir);
    if (!migrationsLoaded.ok) throw new Error("failed to load migrations");
    const initial = migrationsLoaded.value.find((f) => f.version === 1);
    if (initial === undefined) throw new Error("expected migration version 1");
    await opened.value.executeMultiple(initial.sql);

    const beforeRows = await opened.value.execute("SELECT * FROM schema_migrations");
    expect(beforeRows.rows.length).toBe(0);

    const result = await runMigrations(opened.value, migrationsDir, dbPath, CLOCK);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Version 1 was backfilled (already applied by the simulated crash), not
      // re-executed — re-running its DDL would fail with "table already exists".
      // Only the genuinely-pending versions after 1 were newly applied.
      expect(result.value.map((m) => m.version)).toEqual([2, 3, 4, 5, 6, 7]);
    }
    const afterRows = await opened.value.execute(
      "SELECT version, checksum FROM schema_migrations WHERE version = 1",
    );
    expect(afterRows.rows).toEqual([{ version: 1, checksum: initial.checksum }]);
  });

  it("fails with SCHEMA_MISMATCH when user_version is ahead of every migration file this build knows about", async () => {
    const newerMigrationsDir = await copyMigrationsDir();
    tempDirs.push(newerMigrationsDir);
    await writeFile(
      join(newerMigrationsDir, "008_add_synthetic_table.sql"),
      "BEGIN IMMEDIATE;\nCREATE TABLE synthetic_two (id INTEGER PRIMARY KEY);\nPRAGMA user_version = 8;\nCOMMIT;\n",
      "utf8",
    );
    const { dir, dbPath } = await createTempDbPath();
    tempDirs.push(dir);
    const opened = await openDatabase(dbPath);
    if (!opened.ok) throw new Error("failed to open database");
    dbs.push(opened.value);

    // A newer build applies all migrations, reaching user_version 8.
    const first = await runMigrations(opened.value, newerMigrationsDir, dbPath, CLOCK);
    expect(first.ok).toBe(true);

    // A downgraded build ships only the real migrations, not the synthetic 008
    // above — nothing is "pending" from its point of view, but its own
    // repository code was written against the real latest version, not the
    // version 7 this database is actually at.
    const olderMigrationsDir = await copyMigrationsDir();
    tempDirs.push(olderMigrationsDir);

    const result = await runMigrations(opened.value, olderMigrationsDir, dbPath, CLOCK);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SCHEMA_MISMATCH");
    }
  });

  it("fails with SCHEMA_MISMATCH when schema_migrations records a version this build's files do not include, even if PRAGMA user_version has not caught up", async () => {
    // Comparing only `PRAGMA user_version` against `maxKnownVersion` misses
    // this case — `schema_migrations` already has an "orphaned" bookkeeping
    // row for a version this (downgraded) build's migrations directory does not
    // include at all, while `PRAGMA user_version` itself is still behind.
    const migrationsDir = await copyMigrationsDir();
    tempDirs.push(migrationsDir);
    const { dir, dbPath } = await createTempDbPath();
    tempDirs.push(dir);
    const opened = await openDatabase(dbPath);
    if (!opened.ok) throw new Error("failed to open database");
    dbs.push(opened.value);

    const first = await runMigrations(opened.value, migrationsDir, dbPath, CLOCK);
    expect(first.ok).toBe(true);
    const userVersionAfterFirst = await opened.value.execute("PRAGMA user_version");
    expect(userVersionAfterFirst.rows[0]?.user_version).toBe(7);

    // Simulate schema_migrations already recording version 8 (e.g. a
    // concurrent/other process's bookkeeping insert) without PRAGMA
    // user_version having advanced to 8 yet.
    await opened.value.execute({
      sql: "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      args: [
        8,
        "orphaned",
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        CLOCK.now().toISOString(),
      ],
    });

    // This build's migrations directory stops at the real latest version — it
    // does not even know version 7 exists.
    const result = await runMigrations(opened.value, migrationsDir, dbPath, CLOCK);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SCHEMA_MISMATCH");
    }
  });
});

describe("loadMigrations", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it("ignores files that do not match the migration filename pattern", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-migrations-load-"));
    await writeFile(join(tempDir, "001_initial.sql"), "SELECT 1;", "utf8");
    await writeFile(join(tempDir, "README.md"), "not a migration", "utf8");

    const result = await loadMigrations(tempDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((f) => f.filename)).toEqual(["001_initial.sql"]);
    }
  });

  it("accepts both 3-digit and 4-digit numeric prefixes", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-migrations-load-"));
    await writeFile(join(tempDir, "001_initial.sql"), "SELECT 1;", "utf8");
    await writeFile(join(tempDir, "0002_next.sql"), "SELECT 2;", "utf8");

    const result = await loadMigrations(tempDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((f) => f.version)).toEqual([1, 2]);
    }
  });

  it("fails when two files claim the same version", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-migrations-load-"));
    await mkdir(tempDir, { recursive: true });
    await writeFile(join(tempDir, "001_a.sql"), "SELECT 1;", "utf8");
    await writeFile(join(tempDir, "001_b.sql"), "SELECT 2;", "utf8");

    const result = await loadMigrations(tempDir);

    expect(result.ok).toBe(false);
  });

  it("computes a stable sha256 checksum for identical content", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-migrations-load-"));
    await writeFile(join(tempDir, "001_initial.sql"), "SELECT 1;", "utf8");

    const result = await loadMigrations(tempDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]?.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});
