import { IrohaError } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database, openDatabase } from "./connection.js";
import { createTempDbPath, removeTempDir } from "./test-helpers/tmp-db.js";
import { withTransaction } from "./transaction.js";

async function openTestDb(): Promise<{ dir: string; db: Database }> {
  const { dir, dbPath } = await createTempDbPath();
  const result = await openDatabase(dbPath);
  if (!result.ok) {
    throw new Error(`failed to open test database: ${result.error.message}`);
  }
  await result.value.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
  return { dir, db: result.value };
}

describe("withTransaction", () => {
  let tempDir: string | undefined;
  let dbs: Database[] = [];

  afterEach(async () => {
    for (const db of dbs) {
      closeDatabase(db);
    }
    dbs = [];
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it("commits changes made by fn on success", async () => {
    const { dir, db } = await openTestDb();
    tempDir = dir;
    dbs.push(db);

    const result = await withTransaction(db, "write", async (tx) => {
      await tx.execute({ sql: "INSERT INTO t (id, label) VALUES (?, ?)", args: [1, "a"] });
      return { ok: true, value: undefined } as const;
    });

    expect(result.ok).toBe(true);
    const rows = await db.execute("SELECT * FROM t");
    expect(rows.rows.length).toBe(1);
  });

  it("rolls back changes made by fn when fn returns an error Result", async () => {
    const { dir, db } = await openTestDb();
    tempDir = dir;
    dbs.push(db);

    const result = await withTransaction(db, "write", async (tx) => {
      await tx.execute({ sql: "INSERT INTO t (id, label) VALUES (?, ?)", args: [1, "a"] });
      return { ok: false, error: new IrohaError("INVALID_INPUT", "nope") } as const;
    });

    expect(result.ok).toBe(false);
    const rows = await db.execute("SELECT * FROM t");
    expect(rows.rows.length).toBe(0);
  });

  it("surfaces fn's original error even when fn already closed the transaction itself", async () => {
    const { dir, db } = await openTestDb();
    tempDir = dir;
    dbs.push(db);

    // Confirmed by reproduction: a second `rollback()` on an
    // already-closed transaction throws `TRANSACTION_CLOSED`. `fn` rolling
    // back before returning its error simulates that condition for
    // withTransaction's own subsequent rollback call.
    const result = await withTransaction(db, "write", async (tx) => {
      await tx.execute({ sql: "INSERT INTO t (id, label) VALUES (?, ?)", args: [1, "a"] });
      await tx.rollback();
      return { ok: false, error: new IrohaError("CONFLICT", "original conflict") } as const;
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
      expect(result.error.message).toBe("original conflict");
    }
  });

  it("rolls back changes made by fn when fn throws", async () => {
    const { dir, db } = await openTestDb();
    tempDir = dir;
    dbs.push(db);

    const result = await withTransaction(db, "write", async (tx) => {
      await tx.execute({ sql: "INSERT INTO t (id, label) VALUES (?, ?)", args: [1, "a"] });
      throw new Error("boom");
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
    }
    const rows = await db.execute("SELECT * FROM t");
    expect(rows.rows.length).toBe(0);
  });

  it("waits out a concurrent writer and succeeds once the lock is released", async () => {
    const { dir, db } = await openTestDb();
    tempDir = dir;
    dbs.push(db);

    // A second connection to the SAME file competes for the write lock.
    const second = await openDatabase(`${dir}/index.db`);
    if (!second.ok) throw new Error("failed to open second connection");
    dbs.push(second.value);

    const holder = await db.transaction("write");
    await holder.execute({ sql: "INSERT INTO t (id, label) VALUES (?, ?)", args: [1, "a"] });

    const releaseAfterMs = 300;
    const releaseTimer = setTimeout(() => {
      holder.commit().catch(() => undefined);
    }, releaseAfterMs);

    const result = await withTransaction(second.value, "write", async (tx) => {
      await tx.execute({ sql: "INSERT INTO t (id, label) VALUES (?, ?)", args: [2, "b"] });
      return { ok: true, value: undefined } as const;
    });

    clearTimeout(releaseTimer);
    expect(result.ok).toBe(true);
    const rows = await db.execute("SELECT id FROM t ORDER BY id");
    expect(rows.rows.map((r) => r.id)).toEqual([1, 2]);
  }, 10_000);

  it("gives up with a retryable DB_BUSY error once the retry budget elapses", async () => {
    const { dir, db } = await openTestDb();
    tempDir = dir;
    dbs.push(db);

    const second = await openDatabase(`${dir}/index.db`);
    if (!second.ok) throw new Error("failed to open second connection");
    dbs.push(second.value);

    const holder = await db.transaction("write");
    await holder.execute({ sql: "INSERT INTO t (id, label) VALUES (?, ?)", args: [1, "a"] });
    // Deliberately never committed/rolled back within this test's scope.

    const result = await withTransaction(second.value, "write", async (tx) => {
      await tx.execute({ sql: "INSERT INTO t (id, label) VALUES (?, ?)", args: [2, "b"] });
      return { ok: true, value: undefined } as const;
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DB_BUSY");
      expect(result.error.retryable).toBe(true);
    }

    await holder.rollback();
  }, 10_000);
});
