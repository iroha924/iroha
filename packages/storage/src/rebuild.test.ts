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
    // Built with `join` (not a hardcoded `/`-separated literal) so the
    // expectation matches whatever separator `path.dirname`/`path.join`
    // produce on the host platform — confirmed by reproduction that a
    // hardcoded POSIX literal fails on Windows, where `join` emits `\`.
    const dir = join("repo", ".git", "iroha");
    const primaryDbPath = join(dir, "index.db");

    const path = createSiblingDatabasePath(primaryDbPath, random);

    expect(path).toBe(join(dir, "index.rebuild-0102030405060708.db"));
  });

  it("produces different paths for different random sources", () => {
    const primaryDbPath = join("repo", ".git", "iroha", "index.db");
    const a = createSiblingDatabasePath(
      primaryDbPath,
      new FixedRandomSource(new Uint8Array(8).fill(1)),
    );
    const b = createSiblingDatabasePath(
      primaryDbPath,
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

  it("moves each side's -wal/-shm sidecar files along with the swap", async () => {
    const { dir, dbPath } = await createTempDbPath();
    tempDir = dir;
    await writeFile(dbPath, "old-content", "utf8");
    await writeFile(`${dbPath}-wal`, "old-wal", "utf8");
    await writeFile(`${dbPath}-shm`, "old-shm", "utf8");
    const siblingPath = join(dir, "index.rebuild-abc.db");
    await writeFile(siblingPath, "new-content", "utf8");
    await writeFile(`${siblingPath}-wal`, "new-wal", "utf8");
    // No -shm for the sibling, to also confirm a missing sidecar is a no-op.

    const result = await replaceDatabaseAtomically(dbPath, siblingPath, CLOCK);

    expect(result.ok).toBe(true);
    expect(await readFile(`${dbPath}-wal`, "utf8")).toBe("new-wal");
    if (result.ok) {
      expect(await readFile(`${result.value.backupPath}-wal`, "utf8")).toBe("old-wal");
      expect(await readFile(`${result.value.backupPath}-shm`, "utf8")).toBe("old-shm");
    }
    // The sibling never had a `-shm` file, so no stray `-shm` should exist
    // at the promoted primary path either.
    await expect(readFile(`${dbPath}-shm`, "utf8")).rejects.toThrow();
  });
});
