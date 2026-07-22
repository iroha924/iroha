import type { TypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database } from "../connection.js";
import { openMigratedTestDb, removeTempDir } from "../test-helpers/tmp-db.js";
import { getOverviewCounts } from "./dashboard.js";
import { insertEntity, insertRepository } from "./identity.js";

const NOW = "2026-01-01T00:00:00.000Z";

function repoId(suffix: string): TypedId<"repo"> {
  return `repo_${suffix.padEnd(26, "0")}` as TypedId<"repo">;
}

describe("getOverviewCounts", () => {
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

  it("breaks approved knowledge down by type, excluding non-approved and non-knowledge entities", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = repoId("a");
    await insertRepository(db, {
      id: repositoryId,
      rootFingerprint: "fp-a",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const seed = async (id: string, entityType: string, status: string): Promise<void> => {
      await insertEntity(db as Database, {
        id,
        repositoryId,
        // biome-ignore lint/suspicious/noExplicitAny: EntityType is a wide union; the literals below are valid members
        entityType: entityType as any,
        title: id,
        status,
        authority: 100,
        sourceKind: "canonical",
        createdAt: NOW,
        updatedAt: NOW,
      });
    };

    await seed(`dec_${"1".padEnd(25, "0")}`, "decision", "approved");
    await seed(`rul_${"2".padEnd(25, "0")}`, "rule", "approved");
    await seed(`con_${"3".padEnd(25, "0")}`, "concept", "approved");
    await seed(`con_${"4".padEnd(25, "0")}`, "concept", "approved");
    // Excluded: a superseded knowledge entity and an approved non-knowledge entity.
    await seed(`pat_${"5".padEnd(25, "0")}`, "pattern", "superseded");
    await seed(`rev_${"6".padEnd(25, "0")}`, "review", "approved");

    const result = await getOverviewCounts(db, repositoryId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.approvedKnowledge).toBe(4);
    expect(result.value.approvedKnowledgeByType).toEqual({
      decision: 1,
      rule: 1,
      concept: 2,
      insight: 0,
      incident: 0,
      pattern: 0,
      review_learning: 0,
    });
  });
});
