import type { TypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database } from "../connection.js";
import { openMigratedTestDb, removeTempDir } from "../test-helpers/tmp-db.js";
import {
  getActorById,
  getActorByProviderExternalId,
  getCanonicalDocumentByEntityId,
  getCanonicalDocumentByPath,
  getEntityById,
  getRepositoryById,
  getRepositoryByRootFingerprint,
  insertActor,
  insertEntity,
  insertRepository,
  listCanonicalDocumentsByRepository,
  listEntitiesByRepository,
  updateEntityAuthority,
  updateEntityStatus,
  updateRepositoryRemote,
  upsertCanonicalDocument,
  upsertEntity,
} from "./identity.js";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";

function repoId(suffix: string): TypedId<"repo"> {
  return `repo_${suffix.padEnd(26, "0")}` as TypedId<"repo">;
}
function actId(suffix: string): TypedId<"act"> {
  return `act_${suffix.padEnd(26, "0")}` as TypedId<"act">;
}

describe("identity repositories", () => {
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

  it("inserts and reads back a repository by id and by root fingerprint", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const id = repoId("a");

    const inserted = await insertRepository(db, {
      id,
      rootFingerprint: "fp-a",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(inserted.ok).toBe(true);

    const byId = await getRepositoryById(db, id);
    expect(byId.ok).toBe(true);
    if (byId.ok) {
      expect(byId.value).toEqual({
        id,
        vcs: "git",
        rootFingerprint: "fp-a",
        remoteUrlNormalized: null,
        defaultBranch: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }

    const byFingerprint = await getRepositoryByRootFingerprint(db, "fp-a");
    expect(byFingerprint.ok).toBe(true);
    if (byFingerprint.ok) {
      expect(byFingerprint.value?.id).toBe(id);
    }
  });

  it("returns null (not an error) for a repository that does not exist", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;

    const result = await getRepositoryById(db, repoId("missing"));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  it("maps a duplicate root_fingerprint to a CONFLICT error", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    await insertRepository(db, {
      id: repoId("b"),
      rootFingerprint: "fp-dup",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const second = await insertRepository(db, {
      id: repoId("c"),
      rootFingerprint: "fp-dup",
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("CONFLICT");
    }
  });

  it("updates remote metadata on a repository", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const id = repoId("d");
    await insertRepository(db, { id, rootFingerprint: "fp-d", createdAt: NOW, updatedAt: NOW });

    await updateRepositoryRemote(db, id, {
      remoteUrlNormalized: "https://example.com/repo.git",
      defaultBranch: "main",
      updatedAt: LATER,
    });

    const result = await getRepositoryById(db, id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value?.remoteUrlNormalized).toBe("https://example.com/repo.git");
      expect(result.value?.defaultBranch).toBe("main");
      expect(result.value?.updatedAt).toBe(LATER);
    }
  });

  it("inserts and reads back an actor by id and by provider/external id", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const id = actId("a");

    await insertActor(db, {
      id,
      provider: "github",
      externalId: "12345",
      displayName: "Ada Lovelace",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const byId = await getActorById(db, id);
    expect(byId.ok).toBe(true);
    if (byId.ok) {
      expect(byId.value?.displayName).toBe("Ada Lovelace");
    }

    const byExternal = await getActorByProviderExternalId(db, "github", "12345");
    expect(byExternal.ok).toBe(true);
    if (byExternal.ok) {
      expect(byExternal.value?.id).toBe(id);
    }
  });

  it("inserts an entity, reads it back, and updates status/authority", async () => {
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

    const entityId = "dec_0000000000000000000000010";
    const inserted = await insertEntity(db, {
      id: entityId,
      repositoryId,
      entityType: "decision",
      title: "Use libSQL",
      status: "pending",
      authority: 30,
      sourceKind: "mcp",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(inserted.ok).toBe(true);

    const read = await getEntityById(db, entityId);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.status).toBe("pending");
      expect(read.value?.authority).toBe(30);
    }

    await updateEntityStatus(db, entityId, { status: "approved", updatedAt: LATER });
    await updateEntityAuthority(db, entityId, { authority: 100, updatedAt: LATER });

    const updated = await getEntityById(db, entityId);
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.value?.status).toBe("approved");
      expect(updated.value?.authority).toBe(100);
    }
  });

  it("lists entities scoped to a repository with type/status filters", async () => {
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
    await insertEntity(db, {
      id: "dec_0000000000000000000000011",
      repositoryId,
      entityType: "decision",
      title: "A",
      status: "approved",
      authority: 100,
      sourceKind: "canonical",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await insertEntity(db, {
      id: "rul_0000000000000000000000012",
      repositoryId,
      entityType: "rule",
      title: "B",
      status: "pending",
      authority: 30,
      sourceKind: "mcp",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const onlyDecisions = await listEntitiesByRepository(db, repositoryId, {
      entityType: "decision",
    });
    expect(onlyDecisions.ok).toBe(true);
    if (onlyDecisions.ok) {
      expect(onlyDecisions.value.map((e) => e.id)).toEqual(["dec_0000000000000000000000011"]);
    }

    const onlyApproved = await listEntitiesByRepository(db, repositoryId, { status: "approved" });
    expect(onlyApproved.ok).toBe(true);
    if (onlyApproved.ok) {
      expect(onlyApproved.value.map((e) => e.id)).toEqual(["dec_0000000000000000000000011"]);
    }

    const all = await listEntitiesByRepository(db, repositoryId);
    expect(all.ok).toBe(true);
    if (all.ok) {
      expect(all.value.length).toBe(2);
    }
  });

  it("upserts a canonical document, bumping the revision on re-approval", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = repoId("g");
    await insertRepository(db, {
      id: repositoryId,
      rootFingerprint: "fp-g",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const entityId = "dec_0000000000000000000000013";
    await insertEntity(db, {
      id: entityId,
      repositoryId,
      entityType: "decision",
      title: "A",
      status: "approved",
      authority: 100,
      sourceKind: "canonical",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const first = await upsertCanonicalDocument(db, {
      entityId,
      canonicalPath: "knowledge/decisions/dec_0000000000000000000000013.md",
      revision: 1,
      frontmatterJson: "{}",
      body: "body v1",
      fileHash: "sha256:aa",
      approvedAt: NOW,
      importedAt: NOW,
    });
    expect(first.ok).toBe(true);

    const readFirst = await getCanonicalDocumentByEntityId(db, entityId);
    expect(readFirst.ok).toBe(true);
    if (readFirst.ok) {
      expect(readFirst.value?.revision).toBe(1);
      expect(readFirst.value?.body).toBe("body v1");
    }

    const second = await upsertCanonicalDocument(db, {
      entityId,
      canonicalPath: "knowledge/decisions/dec_0000000000000000000000013.md",
      revision: 2,
      frontmatterJson: "{}",
      body: "body v2",
      fileHash: "sha256:bb",
      approvedAt: LATER,
      importedAt: LATER,
    });
    expect(second.ok).toBe(true);

    const readSecond = await getCanonicalDocumentByEntityId(db, entityId);
    expect(readSecond.ok).toBe(true);
    if (readSecond.ok) {
      expect(readSecond.value?.revision).toBe(2);
      expect(readSecond.value?.body).toBe("body v2");
    }

    const byPath = await getCanonicalDocumentByPath(
      db,
      "knowledge/decisions/dec_0000000000000000000000013.md",
    );
    expect(byPath.ok).toBe(true);
    if (byPath.ok) {
      expect(byPath.value?.entityId).toBe(entityId);
    }
  });

  it("upserts an entity, updating mutable fields but preserving the original created_at", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = repoId("h");
    await insertRepository(db, {
      id: repositoryId,
      rootFingerprint: "fp-h",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const entityId = "dec_0000000000000000000000014";

    const first = await upsertEntity(db, {
      id: entityId,
      repositoryId,
      entityType: "decision",
      title: "First title",
      status: "approved",
      authority: 100,
      sourceKind: "canonical",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(first.ok).toBe(true);

    const second = await upsertEntity(db, {
      id: entityId,
      repositoryId,
      entityType: "decision",
      title: "Revised title",
      status: "approved",
      authority: 100,
      sourceKind: "canonical",
      createdAt: LATER,
      updatedAt: LATER,
    });
    expect(second.ok).toBe(true);

    const read = await getEntityById(db, entityId);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.title).toBe("Revised title");
      expect(read.value?.updatedAt).toBe(LATER);
      expect(read.value?.createdAt).toBe(NOW);
    }
  });

  it("lists canonical documents scoped to a repository via the entities join", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = repoId("i");
    const otherRepositoryId = repoId("j");
    await insertRepository(db, {
      id: repositoryId,
      rootFingerprint: "fp-i",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await insertRepository(db, {
      id: otherRepositoryId,
      rootFingerprint: "fp-j",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const entityId = "dec_0000000000000000000000015";
    await insertEntity(db, {
      id: entityId,
      repositoryId,
      entityType: "decision",
      title: "In scope",
      status: "approved",
      authority: 100,
      sourceKind: "canonical",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await upsertCanonicalDocument(db, {
      entityId,
      canonicalPath: "knowledge/decisions/dec_0000000000000000000000015.md",
      revision: 1,
      frontmatterJson: "{}",
      body: "in scope",
      fileHash: "sha256:cc",
      approvedAt: NOW,
      importedAt: NOW,
    });

    const otherEntityId = "dec_0000000000000000000000016";
    await insertEntity(db, {
      id: otherEntityId,
      repositoryId: otherRepositoryId,
      entityType: "decision",
      title: "Out of scope",
      status: "approved",
      authority: 100,
      sourceKind: "canonical",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await upsertCanonicalDocument(db, {
      entityId: otherEntityId,
      canonicalPath: "knowledge/decisions/dec_0000000000000000000000016.md",
      revision: 1,
      frontmatterJson: "{}",
      body: "out of scope",
      fileHash: "sha256:dd",
      approvedAt: NOW,
      importedAt: NOW,
    });

    const result = await listCanonicalDocumentsByRepository(db, repositoryId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((doc) => doc.entityId)).toEqual([entityId]);
    }
  });
});
