import { afterEach, describe, expect, it } from "vitest";
import { probeCapabilities } from "./capability.js";
import { closeDatabase, type Database, openDatabase } from "./connection.js";
import { createTempDbPath, removeTempDir } from "./test-helpers/tmp-db.js";

describe("probeCapabilities", () => {
  let tempDir: string | undefined;
  let db: Database | undefined;

  afterEach(async () => {
    if (db) {
      closeDatabase(db);
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

    const capabilities = await probeCapabilities(db);

    expect(capabilities).toEqual({ ftsUnicode61: true, ftsTrigram: true, vector: true });
  });

  it("does not leave scratch tables behind", async () => {
    const { dir, dbPath } = await createTempDbPath();
    tempDir = dir;
    const opened = await openDatabase(dbPath);
    if (!opened.ok) throw new Error("failed to open database");
    db = opened.value;

    await probeCapabilities(db);

    const leftover = await db.execute(
      "SELECT name FROM sqlite_master WHERE name LIKE '__iroha_capability_probe%'",
    );
    expect(leftover.rows.length).toBe(0);
  });
});
