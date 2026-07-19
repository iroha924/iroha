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
const LATER = "2026-01-01T01:00:00.000Z";

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

  it("returns neighbors ordered by id, so a limit truncates deterministically", async () => {
    // dashboard-api.md §4: "deterministic sort with ID tie-breaker" —
    // without an ORDER BY, a `limit` cutoff could keep a different subset
    // of edges across otherwise-identical calls.
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "b2");
    await seedEntity(db, "dec_00000000000000000000000b2r", repositoryId);
    for (const suffix of ["c", "a", "b"]) {
      await seedEntity(db, `dec_00000000000000000000000b2${suffix}`, repositoryId);
      await insertRelation(db, {
        id: relId(`b2${suffix}`),
        repositoryId,
        fromEntityId: "dec_00000000000000000000000b2r",
        relationType: "RELATED_TO",
        toEntityId: `dec_00000000000000000000000b2${suffix}`,
        sourceKind: "human",
        createdAt: NOW,
      });
    }

    const first = await getNeighbors(db, "dec_00000000000000000000000b2r", { limit: 2 });
    const second = await getNeighbors(db, "dec_00000000000000000000000b2r", { limit: 2 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.map((r) => r.id)).toEqual(second.value.map((r) => r.id));
      expect(first.value.map((r) => r.id)).toEqual(
        [relId("b2a"), relId("b2b"), relId("b2c")].sort().slice(0, 2),
      );
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

  it("keeps a DUPLICATES edge directly between two explicit roots", async () => {
    // Every root is pre-marked visited to stop re-expansion, but a direct
    // DUPLICATES edge between two roots the caller explicitly asked about
    // is not a "cycle already visited" — confirmed by reproduction that
    // treating every root as already-visited for the DUPLICATES check
    // silently drops this edge.
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "f2");
    for (const suffix of ["a", "b"]) {
      await seedEntity(db, `dec_0000000000000000000000f2${suffix}`, repositoryId);
    }
    await insertRelation(db, {
      id: relId("f2a"),
      repositoryId,
      fromEntityId: "dec_0000000000000000000000f2a",
      relationType: "DUPLICATES",
      toEntityId: "dec_0000000000000000000000f2b",
      sourceKind: "human",
      createdAt: NOW,
    });

    const subgraph = await getSubgraph(
      db,
      ["dec_0000000000000000000000f2a", "dec_0000000000000000000000f2b"],
      2,
      200,
    );
    expect(subgraph.ok).toBe(true);
    if (subgraph.ok) {
      expect(subgraph.value.map((r) => r.id)).toEqual([relId("f2a")]);
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

  it("does not reset an already-pending embedding job on a re-enqueue attempt", async () => {
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
    // Already pending/in-progress work must not be disturbed by a second
    // enqueue attempt for the same (search_document_id, provider, model).
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
      expect(due.value.map((j) => j.id)).toEqual([id]);
    }
  });

  it("revives a completed embedding job to pending on re-enqueue (content changed)", async () => {
    // Regression test: embedding_jobs has no content_hash column, so it
    // cannot tell a genuinely-finished embedding from one whose
    // search_documents.content_hash changed after the job completed.
    // Confirmed by reproduction that a plain `DO NOTHING` conflict clause
    // leaves the stale completed job untouched, so listDueEmbeddingJobs
    // never surfaces it again and the vector never refreshes.
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "i2");
    await seedEntity(db, "dec_00000000000000000000000i2", repositoryId);
    const sdoc = sdocId("i2a");
    await upsertSearchDocument(db, {
      id: sdoc,
      entityId: "dec_00000000000000000000000i2",
      documentKind: "decision",
      title: "t",
      body: "b",
      authority: 100,
      contentHash: "sha256:aa",
      indexedAt: NOW,
    });
    const id = jobId("i2a");
    await enqueueEmbeddingJob(db, {
      id,
      searchDocumentId: sdoc,
      provider: "voyage",
      model: "voyage-4",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await updateEmbeddingJobStatus(db, id, {
      status: "completed",
      attempts: 1,
      updatedAt: NOW,
    });

    // The document's content changed; the caller re-enqueues to request a
    // fresh embedding.
    await enqueueEmbeddingJob(db, {
      id: jobId("i2b"),
      searchDocumentId: sdoc,
      provider: "voyage",
      model: "voyage-4",
      createdAt: LATER,
      updatedAt: LATER,
    });

    const due = await listDueEmbeddingJobs(db, LATER, 10);
    expect(due.ok).toBe(true);
    if (due.ok) {
      // The original job row is revived in place (same id), not
      // duplicated under the new id passed to the second enqueue call.
      expect(due.value.map((j) => j.id)).toEqual([id]);
      expect(due.value[0]?.status).toBe("pending");
      expect(due.value[0]?.attempts).toBe(0);
    }
  });

  it("does not reset a failed embedding job's backoff state on re-enqueue", async () => {
    // Regression test: reviving `failed`/`dead` jobs unconditionally on
    // every enqueue call would discard their backoff (next_attempt_at) and
    // retry-budget (attempts) state, causing an immediate hot retry
    // against a provider that just failed — confirmed by review. A routine
    // "queue missing embeddings" pass that re-enqueues the same document
    // must not bypass the scheduled backoff.
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = await seedRepository(db, "i3");
    await seedEntity(db, "dec_00000000000000000000000i3", repositoryId);
    const sdoc = sdocId("i3a");
    await upsertSearchDocument(db, {
      id: sdoc,
      entityId: "dec_00000000000000000000000i3",
      documentKind: "decision",
      title: "t",
      body: "b",
      authority: 100,
      contentHash: "sha256:aa",
      indexedAt: NOW,
    });
    const id = jobId("i3a");
    await enqueueEmbeddingJob(db, {
      id,
      searchDocumentId: sdoc,
      provider: "voyage",
      model: "voyage-4",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const farFuture = "2026-01-02T00:00:00.000Z";
    await updateEmbeddingJobStatus(db, id, {
      status: "failed",
      attempts: 2,
      nextAttemptAt: farFuture,
      lastErrorCode: "RATE_LIMITED",
      updatedAt: NOW,
    });

    // A rebuild pass re-enqueues, still seeing the embedding as missing.
    await enqueueEmbeddingJob(db, {
      id: jobId("i3b"),
      searchDocumentId: sdoc,
      provider: "voyage",
      model: "voyage-4",
      createdAt: LATER,
      updatedAt: LATER,
    });

    // Not due yet at LATER — the backoff must still be in effect.
    const dueAtLater = await listDueEmbeddingJobs(db, LATER, 10);
    expect(dueAtLater.ok).toBe(true);
    if (dueAtLater.ok) {
      expect(dueAtLater.value.length).toBe(0);
    }
    // Due once the original backoff actually elapses, with its retry
    // state intact.
    const dueAtFarFuture = await listDueEmbeddingJobs(db, farFuture, 10);
    expect(dueAtFarFuture.ok).toBe(true);
    if (dueAtFarFuture.ok) {
      expect(dueAtFarFuture.value.map((j) => j.id)).toEqual([id]);
      expect(dueAtFarFuture.value[0]?.status).toBe("failed");
      expect(dueAtFarFuture.value[0]?.attempts).toBe(2);
      expect(dueAtFarFuture.value[0]?.lastErrorCode).toBe("RATE_LIMITED");
    }
  });
});
