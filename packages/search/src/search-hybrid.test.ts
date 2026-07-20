import type { TypedId } from "@iroha/domain";
import {
  closeDatabase,
  type Database,
  insertEntity,
  insertRepository,
  updateEntityStatus,
  upsertEmbedding,
  upsertSearchDocument,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { searchHybrid } from "./search-hybrid.js";
import { openMigratedTestDb, removeTempDir } from "./test-helpers/tmp-db.js";

const NOW = "2026-01-01T00:00:00.000Z";
let seq = 0;

function sdocId(suffix: string): TypedId<"sdoc"> {
  return `sdoc_${suffix.padEnd(25, "0")}` as TypedId<"sdoc">;
}

/** A 1024-dim vector that is `1` at `hotIndex` and 0 elsewhere (unit basis vector). */
function unitVector(hotIndex: number): number[] {
  const v = new Array(1024).fill(0);
  v[hotIndex] = 1;
  return v;
}

interface SeedDoc {
  entityId: string;
  title: string;
  body: string;
  authority?: number;
  updatedAt?: string;
  embedding?: number[];
}

async function seedDoc(db: Database, repositoryId: TypedId<"repo">, doc: SeedDoc): Promise<void> {
  const authority = doc.authority ?? 100;
  const contentHash = `sha256:${doc.entityId}`;
  seq += 1;
  const sdoc = sdocId(`h${seq}`);
  await insertEntity(db, {
    id: doc.entityId,
    repositoryId,
    entityType: "decision",
    title: doc.title,
    status: "approved",
    authority,
    sourceKind: "canonical",
    createdAt: NOW,
    updatedAt: doc.updatedAt ?? NOW,
  });
  const upserted = await upsertSearchDocument(db, {
    id: sdoc,
    entityId: doc.entityId,
    documentKind: "decision",
    title: doc.title,
    body: doc.body,
    authority,
    contentHash,
    indexedAt: NOW,
  });
  if (!upserted.ok) {
    throw new Error(`seed search doc failed: ${upserted.error.message}`);
  }
  if (doc.embedding !== undefined) {
    const embedded = await upsertEmbedding(db, {
      searchDocumentId: sdoc,
      contentHash,
      embedding: doc.embedding,
      createdAt: NOW,
    });
    if (!embedded.ok) {
      throw new Error(`seed embedding failed: ${embedded.error.message}`);
    }
  }
}

describe("searchHybrid", () => {
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

  async function open(): Promise<{ db: Database; repositoryId: TypedId<"repo"> }> {
    const opened = await openMigratedTestDb("iroha-hybrid-test-");
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = `repo_${"a".padEnd(26, "0")}` as TypedId<"repo">;
    await insertRepository(db, {
      id: repositoryId,
      rootFingerprint: "fp",
      createdAt: NOW,
      updatedAt: NOW,
    });
    return { db: opened.db, repositoryId };
  }

  it("ranks a lexical FTS match without a query vector", async () => {
    const { db: database, repositoryId } = await open();
    await seedDoc(database, repositoryId, {
      entityId: "dec_00000000000000000000000a1",
      title: "Use libSQL",
      body: "libSQL provides FTS5 and vector search.",
    });

    const result = await searchHybrid(database, { query: "libSQL", mode: "lexical", now: NOW });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((h) => h.entityId)).toEqual(["dec_00000000000000000000000a1"]);
      expect(result.value[0]?.matchedBy).toContain("unicode");
    }
  });

  it("surfaces a vector-only match in hybrid mode that lexical mode misses", async () => {
    const { db: database, repositoryId } = await open();
    await seedDoc(database, repositoryId, {
      entityId: "dec_00000000000000000000000a1",
      title: "alpha topic",
      body: "alpha alpha alpha",
      embedding: unitVector(0),
    });
    await seedDoc(database, repositoryId, {
      entityId: "dec_00000000000000000000000a2",
      title: "gamma topic",
      body: "gamma gamma gamma",
      embedding: unitVector(5),
    });

    // Query text matches only "alpha"; query vector is nearest to the gamma doc.
    const lexical = await searchHybrid(database, { query: "alpha", mode: "lexical", now: NOW });
    expect(lexical.ok).toBe(true);
    if (lexical.ok) {
      expect(lexical.value.map((h) => h.entityId)).toEqual(["dec_00000000000000000000000a1"]);
    }

    const hybrid = await searchHybrid(database, {
      query: "alpha",
      queryVector: unitVector(5),
      mode: "hybrid",
      now: NOW,
    });
    expect(hybrid.ok).toBe(true);
    if (hybrid.ok) {
      const ids = hybrid.value.map((h) => h.entityId);
      expect(ids).toContain("dec_00000000000000000000000a2"); // vector-only doc now present
      const gamma = hybrid.value.find((h) => h.entityId === "dec_00000000000000000000000a2");
      expect(gamma?.matchedBy).toEqual(["vector"]);
    }
  });

  it("lets the authority multiplier lift a higher-authority doc above a better vector rank", async () => {
    const { db: database, repositoryId } = await open();
    await seedDoc(database, repositoryId, {
      entityId: "dec_00000000000000000000000a1",
      title: "high authority",
      body: "no lexical overlap here",
      authority: 100,
      embedding: unitVector(0),
    });
    await seedDoc(database, repositoryId, {
      entityId: "dec_00000000000000000000000a2",
      title: "low authority",
      body: "no lexical overlap here",
      authority: 60,
      embedding: unitVector(1),
    });

    // Query vector is nearest to the low-authority doc (vector rank 1), then the
    // high-authority doc (rank 2). The 1.25x authority boost must flip them.
    const query = new Array(1024).fill(0);
    query[0] = 0.1;
    query[1] = 0.9;
    const result = await searchHybrid(database, {
      query: "zzzznomatch",
      queryVector: query,
      mode: "vector",
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]?.entityId).toBe("dec_00000000000000000000000a1");
    }
  });

  it("uses recency only as a bounded tie-breaker between otherwise-close docs", async () => {
    const { db: database, repositoryId } = await open();
    await seedDoc(database, repositoryId, {
      entityId: "dec_00000000000000000000000a1",
      title: "old doc",
      body: "no lexical overlap here",
      authority: 100,
      updatedAt: "2019-01-01T00:00:00.000Z",
      embedding: unitVector(0),
    });
    await seedDoc(database, repositoryId, {
      entityId: "dec_00000000000000000000000a2",
      title: "new doc",
      body: "no lexical overlap here",
      authority: 100,
      updatedAt: NOW,
      embedding: unitVector(1),
    });

    // Vector rank 1 is the OLD doc, rank 2 is the NEW doc; same authority. The
    // <=5% recency nudge flips this near-tie toward the fresher doc.
    const query = new Array(1024).fill(0);
    query[0] = 0.9;
    query[1] = 0.85;
    const result = await searchHybrid(database, {
      query: "zzzznomatch",
      queryVector: query,
      mode: "vector",
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]?.entityId).toBe("dec_00000000000000000000000a2");
    }
  });

  it("excludes a tombstoned entity from vector results", async () => {
    const { db: database, repositoryId } = await open();
    await seedDoc(database, repositoryId, {
      entityId: "dec_00000000000000000000000a1",
      title: "deleted",
      body: "no lexical overlap here",
      embedding: unitVector(0),
    });
    await updateEntityStatus(database, "dec_00000000000000000000000a1", {
      status: "tombstoned",
      updatedAt: NOW,
    });

    const result = await searchHybrid(database, {
      query: "zzzznomatch",
      queryVector: unitVector(0),
      mode: "vector",
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });
});
