import type { TypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database } from "./connection.js";
import { insertEntity, insertRepository } from "./repositories/identity.js";
import { upsertSearchDocument } from "./repositories/index.js";
import { openMigratedTestDb, removeTempDir } from "./test-helpers/tmp-db.js";

/**
 * implementation-plan.md WP-03 acceptance: "FTS Unicode/trigram smoke
 * search". `capability.ts`'s probe only confirms the tokenizers exist
 * (disposable scratch tables), and `integrity.ts`'s docsize check only
 * confirms row counts stay in sync — neither runs an actual `MATCH` query
 * against real content through the real `search_fts_unicode`/
 * `search_fts_trigram` tables from migrations/001_initial.sql. This file
 * does that directly against the schema, since no repository function for
 * hybrid/FTS querying exists yet in this package (that's WP-08's job; this
 * only proves the indexes themselves work).
 *
 * Query shape confirmed by reproduction: an *aliased* FTS5 table
 * (`FROM search_fts_unicode f ... WHERE f MATCH ?`) fails with
 * "no such column: f" — the unaliased table name must be used directly in
 * both the FROM/JOIN and the MATCH clause.
 */

const NOW = "2026-01-01T00:00:00.000Z";

async function matchUnicode(db: Database, term: string): Promise<string[]> {
  const result = await db.execute({
    sql: `SELECT s.id AS id FROM search_fts_unicode
      JOIN search_documents s ON s.rowid = search_fts_unicode.rowid
      WHERE search_fts_unicode MATCH ?`,
    args: [term],
  });
  return result.rows.map((row) => String(row.id));
}

async function matchTrigram(db: Database, term: string): Promise<string[]> {
  const result = await db.execute({
    sql: `SELECT s.id AS id FROM search_fts_trigram
      JOIN search_documents s ON s.rowid = search_fts_trigram.rowid
      WHERE search_fts_trigram MATCH ?`,
    args: [term],
  });
  return result.rows.map((row) => String(row.id));
}

describe("FTS unicode61/trigram smoke search", () => {
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

  it("finds English/code content via unicode61, including diacritics-removed and code_terms matches", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = "repo_ftssmoke0000000000000000" as TypedId<"repo">;
    await insertRepository(db, {
      id: repositoryId,
      rootFingerprint: "fp-fts-en",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const entityId = "dec_ftssmoke000000000000000001";
    await insertEntity(db, {
      id: entityId,
      repositoryId,
      entityType: "decision",
      title: "Use libSQL for storage",
      status: "approved",
      authority: 100,
      sourceKind: "canonical",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const searchDocumentId = "sdoc_ftssmoke00000000000000" as TypedId<"sdoc">;
    const inserted = await upsertSearchDocument(db, {
      id: searchDocumentId,
      entityId,
      documentKind: "decision",
      title: "Use libSQL for storage",
      body: "The migration runner applies schema checksums café",
      codeTerms: "runMigrations checkIntegrity",
      authority: 100,
      contentHash: "sha256:aa",
      indexedAt: NOW,
    });
    expect(inserted.ok).toBe(true);

    expect(await matchUnicode(db, "migration")).toEqual([searchDocumentId]);
    expect(await matchUnicode(db, "checkIntegrity")).toEqual([searchDocumentId]);
    // unicode61 remove_diacritics 2: "café" in the body matches an ASCII "cafe" query.
    expect(await matchUnicode(db, "cafe")).toEqual([searchDocumentId]);
    expect(await matchUnicode(db, "nonexistentterm")).toEqual([]);
  });

  it("finds Japanese/CJK content via trigram substring search", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const repositoryId = "repo_ftssmoke0000000000000001" as TypedId<"repo">;
    await insertRepository(db, {
      id: repositoryId,
      rootFingerprint: "fp-fts-ja",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const entityId = "dec_ftssmoke000000000000000002";
    await insertEntity(db, {
      id: entityId,
      repositoryId,
      entityType: "decision",
      title: "日本語での検索テスト",
      status: "approved",
      authority: 100,
      sourceKind: "canonical",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const searchDocumentId = "sdoc_ftssmoke00000000000001" as TypedId<"sdoc">;
    const inserted = await upsertSearchDocument(db, {
      id: searchDocumentId,
      entityId,
      documentKind: "decision",
      title: "日本語での検索テスト",
      body: "トライグラムインデックスが正しく機能することを確認する",
      authority: 100,
      contentHash: "sha256:bb",
      indexedAt: NOW,
    });
    expect(inserted.ok).toBe(true);

    // A substring not aligned to any word boundary — the whole point of trigram indexing.
    expect(await matchTrigram(db, "トライグラム")).toEqual([searchDocumentId]);
    expect(await matchTrigram(db, "見つからない")).toEqual([]);
  });
});
