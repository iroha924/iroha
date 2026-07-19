import type { TypedId } from "@iroha/domain";
import {
  closeDatabase,
  type Database,
  insertEntity,
  insertRepository,
  updateEntityStatus,
  upsertSearchDocument,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { searchText } from "./search-text.js";
import { openMigratedTestDb, removeTempDir } from "./test-helpers/tmp-db.js";

const NOW = "2026-01-01T00:00:00.000Z";

function repoId(suffix: string): TypedId<"repo"> {
  return `repo_${suffix.padEnd(26, "0")}` as TypedId<"repo">;
}
function sdocId(suffix: string): TypedId<"sdoc"> {
  return `sdoc_${suffix.padEnd(25, "0")}` as TypedId<"sdoc">;
}

async function seedSearchDocument(
  db: Database,
  repositoryId: TypedId<"repo">,
  entityId: string,
  input: { searchDocumentId: TypedId<"sdoc">; title: string; body: string; authority?: number },
): Promise<void> {
  await insertEntity(db, {
    id: entityId,
    repositoryId,
    entityType: "decision",
    title: input.title,
    status: "approved",
    authority: input.authority ?? 100,
    sourceKind: "canonical",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const upserted = await upsertSearchDocument(db, {
    id: input.searchDocumentId,
    entityId,
    documentKind: "decision",
    title: input.title,
    body: input.body,
    authority: input.authority ?? 100,
    contentHash: "sha256:aa",
    indexedAt: NOW,
  });
  if (!upserted.ok) {
    throw new Error(`failed to seed search document: ${upserted.error.message}`);
  }
}

describe("searchText", () => {
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

  it("finds an English/code-identifier document via the unicode61 index", async () => {
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
    await seedSearchDocument(db, repositoryId, "dec_0000000000000000000000001", {
      searchDocumentId: sdocId("a"),
      title: "Use libSQL for local storage",
      body: "libSQL provides an embedded database with FTS5 and vector search.",
    });

    const result = await searchText(db, "libSQL");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((hit) => hit.entityId)).toEqual(["dec_0000000000000000000000001"]);
    }
  });

  it("finds a Japanese/CJK document via the trigram index", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = repoId("b");
    await insertRepository(db, {
      id: repositoryId,
      rootFingerprint: "fp-b",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await seedSearchDocument(db, repositoryId, "dec_0000000000000000000000002", {
      searchDocumentId: sdocId("b"),
      title: "承認トランザクションの設計",
      body: "承認済みの正準文書はアトミックな書き込みトランザクションで保存する。",
    });

    const result = await searchText(db, "承認トランザクション");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((hit) => hit.entityId)).toEqual(["dec_0000000000000000000000002"]);
    }
  });

  it("ranks a document matched by both indexes above one matched by only one", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = repoId("c");
    await insertRepository(db, {
      id: repositoryId,
      rootFingerprint: "fp-c",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await seedSearchDocument(db, repositoryId, "dec_0000000000000000000000003", {
      searchDocumentId: sdocId("c"),
      title: "retry budget guidance",
      body: "retry budget guidance for network calls under a job timeout.",
    });
    await seedSearchDocument(db, repositoryId, "dec_0000000000000000000000004", {
      searchDocumentId: sdocId("d"),
      title: "unrelated topic",
      body: "retry-budget-guidance as a single hyphenated code identifier only.",
    });

    const result = await searchText(db, "retry budget guidance");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeGreaterThan(0);
      expect(result.value[0]?.entityId).toBe("dec_0000000000000000000000003");
    }
  });

  it("falls back to a bounded LIKE scan for queries shorter than 3 characters", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = repoId("d");
    await insertRepository(db, {
      id: repositoryId,
      rootFingerprint: "fp-d",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await seedSearchDocument(db, repositoryId, "dec_0000000000000000000000005", {
      searchDocumentId: sdocId("e"),
      title: "CI pipeline",
      body: "the CI pipeline runs lint, typecheck, test, and build.",
    });

    const result = await searchText(db, "CI");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((hit) => hit.entityId)).toEqual(["dec_0000000000000000000000005"]);
    }
  });

  it("returns an empty result for a query with no matches", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;

    const result = await searchText(db, "nonexistent-term-xyz");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  it("excludes a tombstoned entity's document from FTS results", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = repoId("e");
    await insertRepository(db, {
      id: repositoryId,
      rootFingerprint: "fp-e",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const entityId = "dec_0000000000000000000000006";
    await seedSearchDocument(db, repositoryId, entityId, {
      searchDocumentId: sdocId("f"),
      title: "Deleted decision",
      body: "this decision document was later deleted from .iroha/.",
    });

    const beforeTombstone = await searchText(db, "deleted decision");
    expect(beforeTombstone.ok).toBe(true);
    if (beforeTombstone.ok) {
      expect(beforeTombstone.value.map((hit) => hit.entityId)).toEqual([entityId]);
    }

    const updated = await updateEntityStatus(db, entityId, {
      status: "tombstoned",
      updatedAt: NOW,
    });
    expect(updated.ok).toBe(true);

    const afterTombstone = await searchText(db, "deleted decision");
    expect(afterTombstone.ok).toBe(true);
    if (afterTombstone.ok) {
      expect(afterTombstone.value).toEqual([]);
    }
  });

  it("excludes a tombstoned entity's document from the short-query LIKE fallback", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = repoId("f");
    await insertRepository(db, {
      id: repositoryId,
      rootFingerprint: "fp-f",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const entityId = "dec_0000000000000000000000007";
    await seedSearchDocument(db, repositoryId, entityId, {
      searchDocumentId: sdocId("g"),
      title: "CI pipeline (deleted)",
      body: "the CI pipeline runs lint, typecheck, test, and build.",
    });
    await updateEntityStatus(db, entityId, { status: "tombstoned", updatedAt: NOW });

    const result = await searchText(db, "CI");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });
});
