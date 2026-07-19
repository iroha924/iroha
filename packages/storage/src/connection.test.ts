import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "./connection.js";
import { createTempDbPath, removeTempDir } from "./test-helpers/tmp-db.js";

describe("openDatabase", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it("creates the parent directory and the database file", async () => {
    const { dir } = await createTempDbPath();
    tempDir = dir;
    const nestedDbPath = join(dir, "nested", "index.db");

    const result = await openDatabase(nestedDbPath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const fileStat = await stat(nestedDbPath);
      expect(fileStat.isFile()).toBe(true);
      await closeDatabase(result.value);
    }
  });

  it("opens a database whose path contains a URL metacharacter (#)", async () => {
    // Confirmed by reproduction: a raw `file:${path}` string throws
    // `URL_INVALID: URL fragments are not supported` when `path` contains
    // `#` — legal in a POSIX (and Windows) directory name, but meaningful
    // to a URL parser.
    const { dir } = await createTempDbPath();
    tempDir = dir;
    const weirdDir = join(dir, "repo#with-hash");
    await mkdir(weirdDir, { recursive: true });
    const dbPath = join(weirdDir, "index.db");

    const result = await openDatabase(dbPath);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const fileStat = await stat(dbPath);
      expect(fileStat.isFile()).toBe(true);
      await closeDatabase(result.value);
    }
  });

  it("applies the required connection PRAGMAs", async () => {
    const { dir, dbPath } = await createTempDbPath();
    tempDir = dir;

    const result = await openDatabase(dbPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const db = result.value;

    const foreignKeys = await db.execute("PRAGMA foreign_keys");
    expect(foreignKeys.rows[0]?.foreign_keys).toBe(1);

    const journalMode = await db.execute("PRAGMA journal_mode");
    expect(journalMode.rows[0]?.journal_mode).toBe("wal");

    const synchronous = await db.execute("PRAGMA synchronous");
    expect(synchronous.rows[0]?.synchronous).toBe(1); // NORMAL

    const busyTimeout = await db.execute("PRAGMA busy_timeout");
    expect(busyTimeout.rows[0]?.timeout).toBe(2500);

    const tempStore = await db.execute("PRAGMA temp_store");
    expect(tempStore.rows[0]?.temp_store).toBe(2); // MEMORY

    await closeDatabase(db);
  });

  it("returns DB_UNAVAILABLE instead of throwing when the path cannot be opened as a database", async () => {
    const { dir, dbPath } = await createTempDbPath();
    tempDir = dir;
    // A directory at the target path is not a valid SQLite file: this
    // reliably reproduces SQLITE_CANTOPEN without relying on OS-specific
    // permission semantics (which behave differently as root, in CI, etc).
    await mkdir(dbPath, { recursive: true });

    const result = await openDatabase(dbPath);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DB_UNAVAILABLE");
    }
  });

  it("does not embed the absolute database path in the error", async () => {
    const { dir, dbPath } = await createTempDbPath();
    tempDir = dir;
    await mkdir(dbPath, { recursive: true });

    const result = await openDatabase(dbPath);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.includes(dbPath)).toBe(false);
      expect(JSON.stringify(result.error.details ?? {}).includes(dbPath)).toBe(false);
    }
  });
});

describe("closeDatabase", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it("makes further statements on the connection fail", async () => {
    const { dir, dbPath } = await createTempDbPath();
    tempDir = dir;
    const result = await openDatabase(dbPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await closeDatabase(result.value);

    await expect(result.value.execute("SELECT 1")).rejects.toThrow();
  });
});
