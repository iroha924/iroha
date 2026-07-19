import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FixedClock, FixedRandomSource } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { createSiblingDatabasePath, replaceDatabaseAtomically } from "./rebuild.js";
import { createTempDbPath, removeTempDir } from "./test-helpers/tmp-db.js";

const CLOCK = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));

describe("createSiblingDatabasePath", () => {
  it("returns a random path next to the primary database", () => {
    const random = new FixedRandomSource(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));

    const path = createSiblingDatabasePath("/repo/.git/iroha/index.db", random);

    expect(path).toBe("/repo/.git/iroha/index.rebuild-0102030405060708.db");
  });

  it("produces different paths for different random sources", () => {
    const a = createSiblingDatabasePath(
      "/repo/.git/iroha/index.db",
      new FixedRandomSource(new Uint8Array(8).fill(1)),
    );
    const b = createSiblingDatabasePath(
      "/repo/.git/iroha/index.db",
      new FixedRandomSource(new Uint8Array(8).fill(2)),
    );

    expect(a).not.toBe(b);
  });
});

describe("replaceDatabaseAtomically", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it("swaps the sibling database into place and backs up the previous one", async () => {
    const { dir, dbPath } = await createTempDbPath();
    tempDir = dir;
    await writeFile(dbPath, "old-content", "utf8");
    const siblingPath = join(dir, "index.rebuild-abc.db");
    await writeFile(siblingPath, "new-content", "utf8");

    const result = await replaceDatabaseAtomically(dbPath, siblingPath, CLOCK);

    expect(result.ok).toBe(true);
    expect(await readFile(dbPath, "utf8")).toBe("new-content");
    if (result.ok) {
      expect(await readFile(result.value.backupPath, "utf8")).toBe("old-content");
    }
  });

  it("restores the original database when moving the sibling into place fails", async () => {
    const { dir, dbPath } = await createTempDbPath();
    tempDir = dir;
    await writeFile(dbPath, "old-content", "utf8");
    const missingSiblingPath = join(dir, "index.rebuild-does-not-exist.db");

    const result = await replaceDatabaseAtomically(dbPath, missingSiblingPath, CLOCK);

    expect(result.ok).toBe(false);
    // The original database must still be usable at its original path —
    // a failed rebuild must not leave the repository with no database.
    expect(await readFile(dbPath, "utf8")).toBe("old-content");
    const entries = await readdir(dir);
    expect(entries.some((entry) => entry.includes(".backup-"))).toBe(false);
  });
});
