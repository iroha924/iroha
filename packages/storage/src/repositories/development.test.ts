import type { TypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database } from "../connection.js";
import { openMigratedTestDb, removeTempDir } from "../test-helpers/tmp-db.js";
import {
  getCommitById,
  getCommitBySha,
  getFileById,
  getFileByPath,
  getPullRequestByExternalId,
  getPullRequestById,
  getReviewCommentById,
  getSymbolById,
  getWorkItemByExternalId,
  getWorkItemById,
  listReviewCommentsByPullRequest,
  listSymbolsByFile,
  upsertCommit,
  upsertFile,
  upsertPullRequest,
  upsertReviewComment,
  upsertSymbol,
  upsertWorkItem,
} from "./development.js";
import { insertEntity, insertRepository } from "./identity.js";

const NOW = "2026-01-01T00:00:00.000Z";

function repoId(suffix: string): TypedId<"repo"> {
  return `repo_${suffix.padEnd(26, "0")}` as TypedId<"repo">;
}
function issId(suffix: string): TypedId<"iss"> {
  return `iss_${suffix.padEnd(26, "0")}` as TypedId<"iss">;
}
function comId(suffix: string): TypedId<"com"> {
  return `com_${suffix.padEnd(26, "0")}` as TypedId<"com">;
}
function prId(suffix: string): TypedId<"pr"> {
  return `pr_${suffix.padEnd(27, "0")}` as TypedId<"pr">;
}
function cmtId(suffix: string): TypedId<"cmt"> {
  return `cmt_${suffix.padEnd(26, "0")}` as TypedId<"cmt">;
}
function filId(suffix: string): TypedId<"fil"> {
  return `fil_${suffix.padEnd(26, "0")}` as TypedId<"fil">;
}
function symId(suffix: string): TypedId<"sym"> {
  return `sym_${suffix.padEnd(26, "0")}` as TypedId<"sym">;
}

async function seedRepository(db: Database, suffix: string): Promise<TypedId<"repo">> {
  const id = repoId(suffix);
  await insertRepository(db, {
    id,
    rootFingerprint: `fp-${suffix}`,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

async function seedEntity(
  db: Database,
  id: string,
  repositoryId: TypedId<"repo">,
  entityType: "issue" | "commit" | "pull_request" | "review" | "file" | "symbol",
): Promise<void> {
  await insertEntity(db, {
    id,
    repositoryId,
    entityType,
    title: id,
    status: "active",
    authority: 80,
    sourceKind: "github",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe("development repositories", () => {
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

  it("upserts a work item and reads it back by id and by external id", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "b");
    const id = issId("b");
    await seedEntity(db, id, repositoryId, "issue");

    const inserted = await upsertWorkItem(db, {
      id,
      repositoryId,
      provider: "github",
      externalId: "42",
      number: 42,
      state: "open",
    });
    expect(inserted.ok).toBe(true);

    const updated = await upsertWorkItem(db, {
      id,
      repositoryId,
      provider: "github",
      externalId: "42",
      number: 42,
      state: "closed",
      closedAt: NOW,
    });
    expect(updated.ok).toBe(true);

    const byId = await getWorkItemById(db, id);
    expect(byId.ok).toBe(true);
    if (byId.ok) {
      expect(byId.value?.state).toBe("closed");
      expect(byId.value?.closedAt).toBe(NOW);
    }

    const byExternal = await getWorkItemByExternalId(db, repositoryId, "github", "42");
    expect(byExternal.ok).toBe(true);
    if (byExternal.ok) {
      expect(byExternal.value?.id).toBe(id);
    }
  });

  it("upserts a local work item idempotently when given a stable external id", async () => {
    // Regression test: SQLite's UNIQUE constraint treats NULL as distinct
    // from every other NULL, so an omitted external_id would never trigger
    // ON CONFLICT — confirmed by reproduction. `externalId` is required for
    // this exact reason; a caller creating a local (non-synced) work item
    // must still supply some stable natural key for idempotent re-upserts.
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "b2");
    const id = issId("b2");
    await seedEntity(db, id, repositoryId, "issue");

    await upsertWorkItem(db, {
      id,
      repositoryId,
      provider: "local",
      externalId: "local-1",
      state: "open",
    });
    await upsertWorkItem(db, {
      id,
      repositoryId,
      provider: "local",
      externalId: "local-1",
      state: "closed",
    });

    const byExternal = await getWorkItemByExternalId(db, repositoryId, "local", "local-1");
    expect(byExternal.ok).toBe(true);
    if (byExternal.ok) {
      expect(byExternal.value?.state).toBe("closed");
    }
  });

  it("upserts a commit and reads it back by id and by sha", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "c");
    const id = comId("c");
    await seedEntity(db, id, repositoryId, "commit");

    await upsertCommit(db, {
      id,
      repositoryId,
      sha: "deadbeef",
      message: "initial commit",
      committedAt: NOW,
    });

    const byId = await getCommitById(db, id);
    expect(byId.ok).toBe(true);
    if (byId.ok) {
      expect(byId.value?.message).toBe("initial commit");
    }
    const bySha = await getCommitBySha(db, repositoryId, "deadbeef");
    expect(bySha.ok).toBe(true);
    if (bySha.ok) {
      expect(bySha.value?.id).toBe(id);
    }
  });

  it("upserts a pull request and reads it back by id and by external id", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "d");
    const id = prId("d");
    await seedEntity(db, id, repositoryId, "pull_request");

    await upsertPullRequest(db, {
      id,
      repositoryId,
      provider: "github",
      externalId: "99",
      number: 99,
      url: "https://example.com/pr/99",
      state: "open",
    });

    const byId = await getPullRequestById(db, id);
    expect(byId.ok).toBe(true);
    if (byId.ok) {
      expect(byId.value?.number).toBe(99);
    }
    const byExternal = await getPullRequestByExternalId(db, repositoryId, "github", "99");
    expect(byExternal.ok).toBe(true);
    if (byExternal.ok) {
      expect(byExternal.value?.id).toBe(id);
    }
  });

  it("upserts review comments and lists them for a pull request in created_at order", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "e");
    const prIdValue = prId("e");
    await seedEntity(db, prIdValue, repositoryId, "pull_request");
    await upsertPullRequest(db, {
      id: prIdValue,
      repositoryId,
      provider: "github",
      externalId: "1",
      number: 1,
      url: "https://example.com/pr/1",
      state: "open",
    });

    const c1 = cmtId("e1");
    await seedEntity(db, c1, repositoryId, "review");
    await upsertReviewComment(db, {
      id: c1,
      pullRequestId: prIdValue,
      provider: "github",
      externalId: "c1",
      bodySummary: "first",
      resolutionState: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const c2 = cmtId("e2");
    await seedEntity(db, c2, repositoryId, "review");
    await upsertReviewComment(db, {
      id: c2,
      pullRequestId: prIdValue,
      provider: "github",
      externalId: "c2",
      bodySummary: "second",
      resolutionState: "resolved",
      createdAt: "2026-01-01T01:00:00.000Z",
    });

    const list = await listReviewCommentsByPullRequest(db, prIdValue);
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value.map((c) => c.bodySummary)).toEqual(["first", "second"]);
    }

    const byId = await getReviewCommentById(db, c2);
    expect(byId.ok).toBe(true);
    if (byId.ok) {
      expect(byId.value?.resolutionState).toBe("resolved");
    }
  });

  it("upserts a file and reads it back by id and by path", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "f");
    const id = filId("f");
    await seedEntity(db, id, repositoryId, "file");

    await upsertFile(db, { id, repositoryId, path: "src/index.ts", language: "typescript" });
    await upsertFile(db, {
      id,
      repositoryId,
      path: "src/index.ts",
      language: "typescript",
      lastBlobSha: "abc123",
    });

    const byId = await getFileById(db, id);
    expect(byId.ok).toBe(true);
    if (byId.ok) {
      expect(byId.value?.lastBlobSha).toBe("abc123");
    }
    const byPath = await getFileByPath(db, repositoryId, "src/index.ts");
    expect(byPath.ok).toBe(true);
    if (byPath.ok) {
      expect(byPath.value?.id).toBe(id);
    }
  });

  it("upserts symbols and lists them for a file", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "g");
    const fileId = filId("g");
    await seedEntity(db, fileId, repositoryId, "file");
    await upsertFile(db, { id: fileId, repositoryId, path: "src/foo.ts" });

    const symId1 = symId("g1");
    await seedEntity(db, symId1, repositoryId, "symbol");
    await upsertSymbol(db, {
      id: symId1,
      fileId,
      symbolKind: "function",
      qualifiedName: "foo",
      lineStart: 1,
      lineEnd: 3,
    });

    const list = await listSymbolsByFile(db, fileId);
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value.map((s) => s.qualifiedName)).toEqual(["foo"]);
    }

    const byId = await getSymbolById(db, symId1);
    expect(byId.ok).toBe(true);
    if (byId.ok) {
      expect(byId.value?.symbolKind).toBe("function");
    }
  });
});
