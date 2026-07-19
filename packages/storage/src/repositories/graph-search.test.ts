import type { TypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database } from "../connection.js";
import { openMigratedTestDb, removeTempDir } from "../test-helpers/tmp-db.js";
import {
  enqueueEmbeddingJob,
  getEmbeddingMetadataBySearchDocumentId,
  getNeighbors,
  getPath,
  getSearchDocumentByEntityId,
  getSubgraph,
  insertRelation,
  listDueEmbeddingJobs,
  searchByVector,
  updateEmbeddingJobStatus,
  upsertEmbedding,
  upsertSearchDocument,
} from "./graph-search.js";
import { insertEntity, insertRepository } from "./identity.js";

const NOW = "2026-01-01T00:00:00.000Z";

function repoId(suffix: string): TypedId<"repo"> {
  return `repo_${suffix.padEnd(26, "0")}` as TypedId<"repo">;
}
function relId(suffix: string): TypedId<"rel"> {
  return `rel_${suffix.padEnd(26, "0")}` as TypedId<"rel">;
}
function sdocId(suffix: string): TypedId<"sdoc"> {
  return `sdoc_${suffix.padEnd(25, "0")}` as TypedId<"sdoc">;
}
function jobId(suffix: string): TypedId<"job"> {
  return `job_${suffix.padEnd(26, "0")}` as TypedId<"job">;
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

async function seedEntity(db: Database, id: string, repositoryId: TypedId<"repo">): Promise<void> {
  await insertEntity(db, {
    id,
    repositoryId,
    entityType: "decision",
    title: id,
    status: "approved",
    authority: 100,
    sourceKind: "canonical",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe("graph-search repositories", () => {
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

  it("inserts a relation once, ignoring a re-derived duplicate", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "a");
    await seedEntity(db, "dec_00000000000000000000000a1", repositoryId);
    await seedEntity(db, "dec_00000000000000000000000a2", repositoryId);

    const first = await insertRelation(db, {
      id: relId("a1"),
      repositoryId,
      fromEntityId: "dec_00000000000000000000000a1",
      relationType: "RELATED_TO",
      toEntityId: "dec_00000000000000000000000a2",
      sourceKind: "inferred",
      createdAt: NOW,
    });
    expect(first.ok).toBe(true);

    // Same (from, type, to, source) tuple re-derived by a later sync run.
    const second = await insertRelation(db, {
      id: relId("a2"),
      repositoryId,
      fromEntityId: "dec_00000000000000000000000a1",
      relationType: "RELATED_TO",
      toEntityId: "dec_00000000000000000000000a2",
      sourceKind: "inferred",
      createdAt: NOW,
    });
    expect(second.ok).toBe(true);

    const neighbors = await getNeighbors(db, "dec_00000000000000000000000a1");
    expect(neighbors.ok).toBe(true);
    if (neighbors.ok) {
      expect(neighbors.value.length).toBe(1);
    }
  });

  it("finds neighbors filtered by direction and relation type", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "b");
    await seedEntity(db, "dec_00000000000000000000000b1", repositoryId);
    await seedEntity(db, "dec_00000000000000000000000b2", repositoryId);
    await seedEntity(db, "dec_00000000000000000000000b3", repositoryId);
    await insertRelation(db, {
      id: relId("b1"),
      repositoryId,
      fromEntityId: "dec_00000000000000000000000b1",
      relationType: "SUPERSEDES",
      toEntityId: "dec_00000000000000000000000b2",
      sourceKind: "human",
      createdAt: NOW,
    });
    await insertRelation(db, {
      id: relId("b2"),
      repositoryId,
      fromEntityId: "dec_00000000000000000000000b3",
      relationType: "RELATED_TO",
      toEntityId: "dec_00000000000000000000000b1",
      sourceKind: "human",
      createdAt: NOW,
    });

    const outgoing = await getNeighbors(db, "dec_00000000000000000000000b1", {
      direction: "outgoing",
    });
    expect(outgoing.ok).toBe(true);
    if (outgoing.ok) {
      expect(outgoing.value.map((r) => r.toEntityId)).toEqual(["dec_00000000000000000000000b2"]);
    }

    const incoming = await getNeighbors(db, "dec_00000000000000000000000b1", {
      direction: "incoming",
    });
    expect(incoming.ok).toBe(true);
    if (incoming.ok) {
      expect(incoming.value.map((r) => r.fromEntityId)).toEqual(["dec_00000000000000000000000b3"]);
    }

    const typed = await getNeighbors(db, "dec_00000000000000000000000b1", {
      relationTypes: ["SUPERSEDES"],
    });
    expect(typed.ok).toBe(true);
    if (typed.ok) {
      expect(typed.value.length).toBe(1);
      expect(typed.value[0]?.relationType).toBe("SUPERSEDES");
    }
  });

  it("finds a multi-hop path and returns null when none exists within maxDepth", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "c");
    // A -> B -> C -> D, plus an isolated E.
    for (const suffix of ["a", "b", "c", "d", "e"]) {
      await seedEntity(db, `dec_0000000000000000000000c${suffix}`, repositoryId);
    }
    const edges: Array<[string, string]> = [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
    ];
    for (const [from, to] of edges) {
      await insertRelation(db, {
        id: relId(`c-${from}${to}`),
        repositoryId,
        fromEntityId: `dec_0000000000000000000000c${from}`,
        relationType: "RELATED_TO",
        toEntityId: `dec_0000000000000000000000c${to}`,
        sourceKind: "human",
        createdAt: NOW,
      });
    }

    const found = await getPath(
      db,
      "dec_0000000000000000000000ca",
      "dec_0000000000000000000000cd",
      4,
    );
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.value?.length).toBe(3);
    }

    const tooFar = await getPath(
      db,
      "dec_0000000000000000000000ca",
      "dec_0000000000000000000000cd",
      2,
    );
    expect(tooFar.ok).toBe(true);
    if (tooFar.ok) {
      expect(tooFar.value).toBeNull();
    }

    const unreachable = await getPath(
      db,
      "dec_0000000000000000000000ca",
      "dec_0000000000000000000000ce",
      4,
    );
    expect(unreachable.ok).toBe(true);
    if (unreachable.ok) {
      expect(unreachable.value).toBeNull();
    }
  });

  it("collects a bounded subgraph from multiple roots without revisiting nodes", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "d");
    for (const suffix of ["a", "b", "c"]) {
      await seedEntity(db, `dec_0000000000000000000000d${suffix}`, repositoryId);
    }
    await insertRelation(db, {
      id: relId("d1"),
      repositoryId,
      fromEntityId: "dec_0000000000000000000000da",
      relationType: "RELATED_TO",
      toEntityId: "dec_0000000000000000000000db",
      sourceKind: "human",
      createdAt: NOW,
    });
    await insertRelation(db, {
      id: relId("d2"),
      repositoryId,
      fromEntityId: "dec_0000000000000000000000db",
      relationType: "RELATED_TO",
      toEntityId: "dec_0000000000000000000000dc",
      sourceKind: "human",
      createdAt: NOW,
    });

    const subgraph = await getSubgraph(
      db,
      ["dec_0000000000000000000000da", "dec_0000000000000000000000db"],
      2,
      200,
    );
    expect(subgraph.ok).toBe(true);
    if (subgraph.ok) {
      expect(subgraph.value.map((r) => r.id).sort()).toEqual([relId("d1"), relId("d2")].sort());
    }
  });

  it("excludes a DUPLICATES edge back to an already-visited node, but keeps other relation types", async () => {
    // implementation/database-schema.md §11: subgraph traversal "excludes
    // DUPLICATES cycles already visited". A visited via RELATED_TO to B,
    // then B has a DUPLICATES edge back to A — that back edge must be
    // dropped, but a non-DUPLICATES edge between the same already-visited
    // pair must still be collected (it is real exploration data, not a
    // cycle to hide).
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "e");
    for (const suffix of ["a", "b"]) {
      await seedEntity(db, `dec_0000000000000000000000e${suffix}`, repositoryId);
    }
    await insertRelation(db, {
      id: relId("e1"),
      repositoryId,
      fromEntityId: "dec_0000000000000000000000ea",
      relationType: "RELATED_TO",
      toEntityId: "dec_0000000000000000000000eb",
      sourceKind: "human",
      createdAt: NOW,
    });
    await insertRelation(db, {
      id: relId("e2"),
      repositoryId,
      fromEntityId: "dec_0000000000000000000000eb",
      relationType: "DUPLICATES",
      toEntityId: "dec_0000000000000000000000ea",
      sourceKind: "human",
      createdAt: NOW,
    });
    await insertRelation(db, {
      id: relId("e3"),
      repositoryId,
      fromEntityId: "dec_0000000000000000000000eb",
      relationType: "CONTRADICTS",
      toEntityId: "dec_0000000000000000000000ea",
      sourceKind: "human",
      createdAt: NOW,
    });

    const subgraph = await getSubgraph(db, ["dec_0000000000000000000000ea"], 2, 200);
    expect(subgraph.ok).toBe(true);
    if (subgraph.ok) {
      const ids = subgraph.value.map((r) => r.id).sort();
      expect(ids).toEqual([relId("e1"), relId("e3")].sort());
      expect(ids).not.toContain(relId("e2"));
    }
  });

  it("upserts a search document, re-indexing in place on a second call", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "e");
    await seedEntity(db, "dec_00000000000000000000000e1", repositoryId);

    await upsertSearchDocument(db, {
      id: sdocId("e1"),
      entityId: "dec_00000000000000000000000e1",
      documentKind: "decision",
      title: "Use libSQL",
      body: "v1",
      authority: 100,
      contentHash: "sha256:aa",
      indexedAt: NOW,
    });
    await upsertSearchDocument(db, {
      id: sdocId("e1"),
      entityId: "dec_00000000000000000000000e1",
      documentKind: "decision",
      title: "Use libSQL",
      body: "v2",
      authority: 100,
      contentHash: "sha256:bb",
      indexedAt: NOW,
    });

    const read = await getSearchDocumentByEntityId(db, "dec_00000000000000000000000e1");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.body).toBe("v2");
      expect(read.value?.contentHash).toBe("sha256:bb");
    }
  });

  it("upserts a 1024-dim embedding and finds it via vector_top_k", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "f");
    await seedEntity(db, "dec_00000000000000000000000f1", repositoryId);
    const id = sdocId("f1");
    await upsertSearchDocument(db, {
      id,
      entityId: "dec_00000000000000000000000f1",
      documentKind: "decision",
      title: "Use libSQL",
      body: "body",
      authority: 100,
      contentHash: "sha256:aa",
      indexedAt: NOW,
    });

    const vector = new Array(1024).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    const inserted = await upsertEmbedding(db, {
      searchDocumentId: id,
      contentHash: "sha256:aa",
      embedding: vector,
      createdAt: NOW,
    });
    expect(inserted.ok).toBe(true);

    const metadata = await getEmbeddingMetadataBySearchDocumentId(db, id);
    expect(metadata.ok).toBe(true);
    if (metadata.ok) {
      expect(metadata.value?.contentHash).toBe("sha256:aa");
    }

    const hits = await searchByVector(db, vector, 5);
    expect(hits.ok).toBe(true);
    if (hits.ok) {
      expect(hits.value.map((h) => h.searchDocumentId)).toEqual([id]);
    }
  });

  it("rejects an embedding vector that is not exactly 1024 components", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "g");
    await seedEntity(db, "dec_00000000000000000000000g1", repositoryId);
    const id = sdocId("g1");
    await upsertSearchDocument(db, {
      id,
      entityId: "dec_00000000000000000000000g1",
      documentKind: "decision",
      title: "t",
      body: "b",
      authority: 100,
      contentHash: "sha256:aa",
      indexedAt: NOW,
    });

    const result = await upsertEmbedding(db, {
      searchDocumentId: id,
      contentHash: "sha256:aa",
      embedding: [0.1, 0.2],
      createdAt: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("rejects a query vector that is not exactly 1024 components", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;

    const result = await searchByVector(db, [0.1, 0.2], 5);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("enqueues an embedding job, lists it as due, and updates its status", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "h");
    await seedEntity(db, "dec_00000000000000000000000h1", repositoryId);
    const sdoc = sdocId("h1");
    await upsertSearchDocument(db, {
      id: sdoc,
      entityId: "dec_00000000000000000000000h1",
      documentKind: "decision",
      title: "t",
      body: "b",
      authority: 100,
      contentHash: "sha256:aa",
      indexedAt: NOW,
    });
    const id = jobId("h1");

    const enqueued = await enqueueEmbeddingJob(db, {
      id,
      searchDocumentId: sdoc,
      provider: "voyage",
      model: "voyage-4",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(enqueued.ok).toBe(true);

    const due = await listDueEmbeddingJobs(db, NOW, 10);
    expect(due.ok).toBe(true);
    if (due.ok) {
      expect(due.value.map((j) => j.id)).toEqual([id]);
      expect(due.value[0]?.status).toBe("pending");
    }

    await updateEmbeddingJobStatus(db, id, { status: "completed", updatedAt: NOW });

    const dueAfter = await listDueEmbeddingJobs(db, NOW, 10);
    expect(dueAfter.ok).toBe(true);
    if (dueAfter.ok) {
      expect(dueAfter.value.length).toBe(0);
    }
  });

  it("does not reset an already-enqueued embedding job on a re-enqueue attempt", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "i");
    await seedEntity(db, "dec_00000000000000000000000i1", repositoryId);
    const sdoc = sdocId("i1");
    await upsertSearchDocument(db, {
      id: sdoc,
      entityId: "dec_00000000000000000000000i1",
      documentKind: "decision",
      title: "t",
      body: "b",
      authority: 100,
      contentHash: "sha256:aa",
      indexedAt: NOW,
    });
    const id = jobId("i1");
    await enqueueEmbeddingJob(db, {
      id,
      searchDocumentId: sdoc,
      provider: "voyage",
      model: "voyage-4",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await updateEmbeddingJobStatus(db, id, { status: "completed", updatedAt: NOW });

    await enqueueEmbeddingJob(db, {
      id: jobId("i2"),
      searchDocumentId: sdoc,
      provider: "voyage",
      model: "voyage-4",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const due = await listDueEmbeddingJobs(db, NOW, 10);
    expect(due.ok).toBe(true);
    if (due.ok) {
      expect(due.value.length).toBe(0);
    }
  });
});
