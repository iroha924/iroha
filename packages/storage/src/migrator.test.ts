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

async function copyMigrationsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iroha-migrations-fixture-"));
  const entries = await readdir(REAL_MIGRATIONS_DIR);
  for (const entry of entries) {
    const content = await readFile(join(REAL_MIGRATIONS_DIR, entry), "utf8");
    await writeFile(join(dir, entry), content, "utf8");
  }
  return dir;
}

describe("runMigrations", () => {
  let tempDirs: string[] = [];
  let dbs: Database[] = [];

  afterEach(async () => {
    for (const db of dbs) {
      closeDatabase(db);
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
      expect(result.value).toEqual([{ version: 1, name: "initial" }]);
    }

    const tables = await opened.value.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entities'",
    );
    expect(tables.rows.length).toBe(1);

    const migrations = await opened.value.execute(
      "SELECT version, name, checksum FROM schema_migrations",
    );
    expect(migrations.rows.length).toBe(1);
    expect(migrations.rows[0]?.version).toBe(1);

    const userVersion = await opened.value.execute("PRAGMA user_version");
    expect(userVersion.rows[0]?.user_version).toBe(1);
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
      join(migrationsDir, "002_add_synthetic_table.sql"),
      "BEGIN IMMEDIATE;\nCREATE TABLE synthetic_two (id INTEGER PRIMARY KEY);\nPRAGMA user_version = 2;\nCOMMIT;\n",
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
      expect(result.value.map((m) => m.version)).toEqual([1, 2]);
    }
    const userVersion = await opened.value.execute("PRAGMA user_version");
    expect(userVersion.rows[0]?.user_version).toBe(2);
    const migrations = await opened.value.execute(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(migrations.rows.map((r) => r.version)).toEqual([1, 2]);
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
      join(migrationsDir, "002_add_synthetic_table.sql"),
      "BEGIN IMMEDIATE;\nCREATE TABLE synthetic_two (id INTEGER PRIMARY KEY);\nPRAGMA user_version = 2;\nCOMMIT;\n",
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
      join(migrationsDir, "002_add_synthetic_table.sql"),
      "BEGIN IMMEDIATE;\nCREATE TABLE synthetic_two (id INTEGER PRIMARY KEY);\nPRAGMA user_version = 2;\nCOMMIT;\n",
      "utf8",
    );

    await runMigrations(opened.value, migrationsDir, dbPath, CLOCK, { skipBackup: true });

    const entries = await readdir(dir);
    expect(entries.some((entry) => entry.includes(".backup-"))).toBe(false);
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
