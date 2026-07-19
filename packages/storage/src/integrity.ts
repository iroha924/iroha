import { err, type IrohaError, ok, type Result } from "@iroha/domain";
import type { Database } from "./connection.js";
import { mapLibsqlError } from "./errors.js";

export interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  referredTable: string;
  foreignKeyIndex: number;
}

export type ApplicationIntegrityViolation =
  | { type: "approved_knowledge_missing_canonical_document"; knowledgeItemId: string }
  | {
      type: "search_fts_row_count_mismatch";
      index: "unicode" | "trigram";
      searchDocumentsCount: number;
      ftsCount: number;
    }
  | { type: "embedding_content_hash_stale"; embeddingId: number; searchDocumentId: string }
  | { type: "relation_points_to_rejected_entity"; relationId: string };

export interface IntegrityReport {
  sqliteIntegrityOk: boolean;
  sqliteIntegrityErrors: string[];
  foreignKeyViolations: ForeignKeyViolation[];
  applicationViolations: ApplicationIntegrityViolation[];
}

/**
 * `PRAGMA integrity_check` returns exactly one row containing the text
 * "ok" when the database is sound; otherwise one row per problem found
 * (confirmed by reproduction: single column named after the pragma).
 */
async function runSqliteIntegrityCheck(
  db: Database,
): Promise<Result<{ ok: boolean; errors: string[] }, IrohaError>> {
  try {
    const result = await db.execute("PRAGMA integrity_check");
    const messages = result.rows.map((row) => String(row.integrity_check));
    return ok({
      ok: messages.length === 1 && messages[0] === "ok",
      errors: messages.filter((m) => m !== "ok"),
    });
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to run PRAGMA integrity_check"));
  }
}

async function runForeignKeyCheck(
  db: Database,
): Promise<Result<ForeignKeyViolation[], IrohaError>> {
  try {
    const result = await db.execute("PRAGMA foreign_key_check");
    return ok(
      result.rows.map((row) => ({
        table: String(row.table),
        rowid: row.rowid === null ? null : Number(row.rowid),
        referredTable: String(row.parent),
        foreignKeyIndex: Number(row.fkid),
      })),
    );
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to run PRAGMA foreign_key_check"));
  }
}

/**
 * Application-level checks that are expressible purely in SQL against this
 * database (implementation/database-schema.md §13). Checks that require
 * filesystem access to canonical files (path existence, filename/ID
 * agreement) belong to the CLI/sync layer, not this package — and
 * "no canonical ID represented by multiple paths" is already structurally
 * guaranteed by `canonical_documents.entity_id` being its primary key.
 */
async function runApplicationChecks(
  db: Database,
): Promise<Result<ApplicationIntegrityViolation[], IrohaError>> {
  const violations: ApplicationIntegrityViolation[] = [];

  try {
    // Checks for the actual `canonical_documents` row (joined by entity id,
    // the real relationship — `canonical_documents` has no foreign key on
    // `knowledge_items.canonical_path`, which is a free-text column), not
    // merely whether `canonical_path` is populated: a knowledge item can
    // have a non-null `canonical_path` while its `canonical_documents` row
    // is missing entirely, which the earlier `canonical_path IS NULL`
    // check did not catch.
    const missingCanonical = await db.execute(
      `SELECT k.id AS id FROM knowledge_items k
       WHERE k.approved_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM canonical_documents c WHERE c.entity_id = k.id)`,
    );
    for (const row of missingCanonical.rows) {
      violations.push({
        type: "approved_knowledge_missing_canonical_document",
        knowledgeItemId: String(row.id),
      });
    }

    // Confirmed by reproduction: `count(*)`/an unfiltered `SELECT` against an
    // external-content FTS5 table (`content = 'search_documents'`) always
    // mirrors the content table's row range regardless of whether the sync
    // trigger ever ran — it does not consult the inverted index at all
    // without a `MATCH` constraint. The `<table>_docsize` shadow table FTS5
    // maintains internally has exactly one row per document actually
    // indexed, so it — not the virtual table itself — is what reflects real
    // drift between `search_documents` and its FTS indexes.
    const [docsCount, unicodeCount, trigramCount] = await Promise.all([
      db.execute("SELECT count(*) AS c FROM search_documents"),
      db.execute("SELECT count(*) AS c FROM search_fts_unicode_docsize"),
      db.execute("SELECT count(*) AS c FROM search_fts_trigram_docsize"),
    ]);
    const docs = Number(docsCount.rows[0]?.c ?? 0);
    const unicode = Number(unicodeCount.rows[0]?.c ?? 0);
    const trigram = Number(trigramCount.rows[0]?.c ?? 0);
    if (unicode !== docs) {
      violations.push({
        type: "search_fts_row_count_mismatch",
        index: "unicode",
        searchDocumentsCount: docs,
        ftsCount: unicode,
      });
    }
    if (trigram !== docs) {
      violations.push({
        type: "search_fts_row_count_mismatch",
        index: "trigram",
        searchDocumentsCount: docs,
        ftsCount: trigram,
      });
    }

    const staleEmbeddings = await db.execute(
      `SELECT e.row_id AS embedding_row_id, e.search_document_id AS search_document_id
       FROM embeddings_1024 e
       JOIN search_documents s ON s.id = e.search_document_id
       WHERE e.content_hash <> s.content_hash`,
    );
    for (const row of staleEmbeddings.rows) {
      violations.push({
        type: "embedding_content_hash_stale",
        embeddingId: Number(row.embedding_row_id),
        searchDocumentId: String(row.search_document_id),
      });
    }

    const relationsToRejected = await db.execute(
      `SELECT r.id AS relation_id
       FROM relations r
       JOIN entities e_from ON e_from.id = r.from_entity_id
       JOIN entities e_to ON e_to.id = r.to_entity_id
       WHERE e_from.status = 'rejected' OR e_to.status = 'rejected'`,
    );
    for (const row of relationsToRejected.rows) {
      violations.push({
        type: "relation_points_to_rejected_entity",
        relationId: String(row.relation_id),
      });
    }
  } catch (cause) {
    return err(mapLibsqlError(cause, "Failed to run application integrity checks"));
  }

  return ok(violations);
}

/**
 * Runs the release/doctor-repair integrity checks from implementation/
 * database-schema.md §13: the two `PRAGMA` checks plus the subset of
 * application-level checks that need only this database (not the Git
 * worktree's canonical files).
 */
export async function checkIntegrity(db: Database): Promise<Result<IntegrityReport, IrohaError>> {
  const sqliteResult = await runSqliteIntegrityCheck(db);
  if (!sqliteResult.ok) {
    return sqliteResult;
  }
  const fkResult = await runForeignKeyCheck(db);
  if (!fkResult.ok) {
    return fkResult;
  }
  const appResult = await runApplicationChecks(db);
  if (!appResult.ok) {
    return appResult;
  }

  return ok({
    sqliteIntegrityOk: sqliteResult.value.ok,
    sqliteIntegrityErrors: sqliteResult.value.errors,
    foreignKeyViolations: fkResult.value,
    applicationViolations: appResult.value,
  });
}
