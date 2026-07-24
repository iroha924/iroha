import { CryptoRandomSource, FixedRandomSource } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { probeCapabilities } from "./capability.js";
import { closeDatabase, type Database, openDatabase } from "./connection.js";
import { createTempDbPath, removeTempDir } from "./test-helpers/tmp-db.js";

describe("probeCapabilities", () => {
  let tempDir: string | undefined;
  let db: Database | undefined;

  afterEach(async () => {
    if (db) {
      await closeDatabase(db);
      db = undefined;
    }
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it("reports FTS unicode61, FTS trigram, and vector support on an unmigrated connection", async () => {
    const { dir, dbPath } = await createTempDbPath();
    tempDir = dir;
    const opened = await openDatabase(dbPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    db = opened.value;

    const capabilities = await probeCapabilities(db, new CryptoRandomSource());

    expect(capabilities).toEqual({ ftsUnicode61: true, ftsTrigram: true, vector: true });
  });

  it("does not leave scratch tables behind", async () => {
    const { dir, dbPath } = await createTempDbPath();
    tempDir = dir;
    const opened = await openDatabase(dbPath);
    if (!opened.ok) throw new Error("failed to open database");
    db = opened.value;

    await probeCapabilities(db, new CryptoRandomSource());

    const leftover = await db.execute(
      "SELECT name FROM sqlite_master WHERE name LIKE '__iroha_capability_probe%'",
    );
    expect(leftover.rows.length).toBe(0);
  });

  it("gives each call a distinct scratch-table suffix instead of a fixed name", async () => {
    // With a fixed (non-unique) scratch-table name, two overlapping
    // `probeCapabilities` calls against the same DB file collide on
    // `CREATE VIRTUAL TABLE ... already exists`, and the loser's
    // `catch { return false }` misreports a supported libSQL build as
    // unsupported. This test doesn't attempt genuine cross-connection
    // concurrency: two connections issuing DDL at once via `Promise.all`
    // crashes this native binding outright rather than raising a catchable
    // error. Instead it proves the fix's mechanism — two calls with
    // different `RandomSource` bytes never reuse the same table name, and
    // each still reports the real result.
    const { dir, dbPath } = await createTempDbPath();
    tempDir = dir;
    const opened = await openDatabase(dbPath);
    if (!opened.ok) throw new Error("failed to open database");
    db = opened.value;

    const a = await probeCapabilities(db, new FixedRandomSource(new Uint8Array(8).fill(1)));
    const b = await probeCapabilities(db, new FixedRandomSource(new Uint8Array(8).fill(2)));

    expect(a).toEqual({ ftsUnicode61: true, ftsTrigram: true, vector: true });
    expect(b).toEqual({ ftsUnicode61: true, ftsTrigram: true, vector: true });
  });
});
