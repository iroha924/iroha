import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database } from "./connection.js";
import { checkIntegrity } from "./integrity.js";
import { openMigratedTestDb, removeTempDir } from "./test-helpers/tmp-db.js";

const NOW = "2026-01-01T00:00:00.000Z";

async function insertRepository(db: Database, id: string): Promise<void> {
  await db.execute({
    sql: "INSERT INTO repositories (id, vcs, root_fingerprint, created_at, updated_at) VALUES (?, 'git', ?, ?, ?)",
    args: [id, `fp-${id}`, NOW, NOW],
  });
}

async function insertEntity(
  db: Database,
  id: string,
  repositoryId: string,
  status = "approved",
  entityType = "decision",
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO entities
      (id, repository_id, entity_type, title, status, authority, source_kind, created_at, updated_at)
      VALUES (?, ?, ?, 'title', ?, 100, 'canonical', ?, ?)`,
    args: [id, repositoryId, entityType, status, NOW, NOW],
  });
}

describe("checkIntegrity", () => {
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

  it("reports a clean database as fully healthy", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;

    const result = await checkIntegrity(db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sqliteIntegrityOk).toBe(true);
      expect(result.value.foreignKeyViolations).toEqual([]);
      expect(result.value.applicationViolations).toEqual([]);
    }
  });

  it("detects a foreign key violation left by a bypassed constraint", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    await insertRepository(db, "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa");

    await db.execute("PRAGMA foreign_keys = OFF");
    await db.execute({
      sql: "INSERT INTO commits (id, repository_id, sha, message, committed_at) VALUES (?, ?, 'sha', 'msg', ?)",
      args: ["com_missing0000000000000000", "repo_aaaaaaaaaaaaaaaaaaaaaaaaaa", NOW],
    });
    await db.execute("PRAGMA foreign_keys = ON");

    const result = await checkIntegrity(db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.foreignKeyViolations).toEqual([
        {
          table: "commits",
          rowid: expect.any(Number),
          referredTable: "entities",
          foreignKeyIndex: expect.any(Number),
        },
      ]);
    }
  });

  it("detects an approved knowledge item with no canonical document", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    await insertRepository(db, "repo_bbbbbbbbbbbbbbbbbbbbbbbbbb");
    await insertEntity(db, "dec_0000000000000000000000001", "repo_bbbbbbbbbbbbbbbbbbbbbbbbbb");
    await db.execute({
      sql: `INSERT INTO knowledge_items (id, knowledge_type, body, scope_json, enforcement, approved_at)
        VALUES (?, 'decision', 'body', '{}', 'advisory', ?)`,
      args: ["dec_0000000000000000000000001", NOW],
    });

    const result = await checkIntegrity(db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.applicationViolations).toEqual([
        {
          type: "approved_knowledge_missing_canonical_document",
          knowledgeItemId: "dec_0000000000000000000000001",
        },
      ]);
    }
  });

  it("detects an approved knowledge item whose canonical_path is set but the canonical_documents row is missing", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    await insertRepository(db, "repo_hhhhhhhhhhhhhhhhhhhhhhhhhh");
    await insertEntity(db, "dec_0000000000000000000000009", "repo_hhhhhhhhhhhhhhhhhhhhhhhhhh");
    // `canonical_path` is a free-text column with no foreign key into
    // canonical_documents — populating it does not guarantee the row
    // actually exists there.
    await db.execute({
      sql: `INSERT INTO knowledge_items (id, knowledge_type, body, scope_json, enforcement, approved_at, canonical_path)
        VALUES (?, 'decision', 'body', '{}', 'advisory', ?, ?)`,
      args: [
        "dec_0000000000000000000000009",
        NOW,
        "knowledge/decisions/dec_0000000000000000000000009.md",
      ],
    });

    const result = await checkIntegrity(db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.applicationViolations).toEqual([
        {
          type: "approved_knowledge_missing_canonical_document",
          knowledgeItemId: "dec_0000000000000000000000009",
        },
      ]);
    }
  });

  it("detects a search FTS index row not backed by search_documents", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    await insertRepository(db, "repo_eeeeeeeeeeeeeeeeeeeeeeeeee");
    await insertEntity(
      db,
      "fil_0000000000000000000000099",
      "repo_eeeeeeeeeeeeeeeeeeeeeeeeee",
      "approved",
      "file",
    );

    // Confirmed by reproduction: an FTS5 external-content table's own row
    // set (what `count(*)` reads) is populated only by the AFTER INSERT
    // trigger, not automatically kept in sync with `search_documents` — a
    // row inserted while that trigger is absent (e.g. a bulk import that
    // disabled it) leaves the index behind without ever raising an error,
    // which is exactly the drift this check exists to catch.
    await db.execute("DROP TRIGGER search_documents_ai");
    await db.execute({
      sql: `INSERT INTO search_documents
        (id, entity_id, document_kind, title, body, authority, content_hash, indexed_at)
        VALUES ('sdoc_0000000000000000000099', ?, 'file', 'title', 'body', 80, 'sha256:aa', ?)`,
      args: ["fil_0000000000000000000000099", NOW],
    });

    const result = await checkIntegrity(db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.applicationViolations).toEqual(
        expect.arrayContaining([
          {
            type: "search_fts_row_count_mismatch",
            index: "unicode",
            searchDocumentsCount: 1,
            ftsCount: 0,
          },
          {
            type: "search_fts_row_count_mismatch",
            index: "trigram",
            searchDocumentsCount: 1,
            ftsCount: 0,
          },
        ]),
      );
    }
  });

  it("detects an embedding whose content_hash no longer matches its search document", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    await insertRepository(db, "repo_cccccccccccccccccccccccc");
    await insertEntity(
      db,
      "fil_0000000000000000000000001",
      "repo_cccccccccccccccccccccccc",
      "approved",
      "file",
    );
    await db.execute({
      sql: `INSERT INTO search_documents
        (id, entity_id, document_kind, title, body, authority, content_hash, indexed_at)
        VALUES ('sdoc_0000000000000000000001', ?, 'file', 'title', 'body', 80, ?, ?)`,
      args: ["fil_0000000000000000000000001", "sha256:current", NOW],
    });
    const sample = JSON.stringify(new Array(1024).fill(0.1));
    await db.execute({
      sql: `INSERT INTO embeddings_1024
        (search_document_id, provider, model, dimension, content_hash, embedding, created_at)
        VALUES ('sdoc_0000000000000000000001', 'voyage', 'voyage-4', 1024, 'sha256:stale', vector32(?), ?)`,
      args: [sample, NOW],
    });

    const result = await checkIntegrity(db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.value.applicationViolations.filter((v) => v.type === "embedding_content_hash_stale"),
      ).toEqual([
        {
          type: "embedding_content_hash_stale",
          embeddingId: expect.any(Number),
          searchDocumentId: "sdoc_0000000000000000000001",
        },
      ]);
    }
  });

  it("detects a relation pointing to a rejected entity", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    await insertRepository(db, "repo_dddddddddddddddddddddddd");
    await insertEntity(
      db,
      "dec_0000000000000000000000002",
      "repo_dddddddddddddddddddddddd",
      "approved",
    );
    await insertEntity(
      db,
      "dec_0000000000000000000000003",
      "repo_dddddddddddddddddddddddd",
      "rejected",
    );
    await db.execute({
      sql: `INSERT INTO relations (id, repository_id, from_entity_id, relation_type, to_entity_id, source_kind, created_at)
        VALUES (?, ?, ?, 'RELATED_TO', ?, 'human', ?)`,
      args: [
        "rel_0000000000000000000000001",
        "repo_dddddddddddddddddddddddd",
        "dec_0000000000000000000000002",
        "dec_0000000000000000000000003",
        NOW,
      ],
    });

    const result = await checkIntegrity(db);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.applicationViolations).toEqual([
        { type: "relation_points_to_rejected_entity", relationId: "rel_0000000000000000000000001" },
      ]);
    }
  });
});
