import type { Database } from "./connection.js";

export interface StorageCapabilities {
  ftsUnicode61: boolean;
  ftsTrigram: boolean;
  /** `F32_BLOB(1024)` + `libsql_vector_idx` + `vector32()` + `vector_top_k()`, tested end-to-end. */
  vector: boolean;
}

const PROBE_PREFIX = "__iroha_capability_probe";

async function dropIfExists(db: Database, table: string): Promise<void> {
  await db.execute(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
}

async function probeFts(db: Database, tokenizer: string, suffix: string): Promise<boolean> {
  const table = `${PROBE_PREFIX}_fts_${suffix}`;
  await dropIfExists(db, table);
  try {
    await db.execute(`CREATE VIRTUAL TABLE ${table} USING fts5(body, tokenize = "${tokenizer}")`);
    return true;
  } catch {
    return false;
  } finally {
    await dropIfExists(db, table);
  }
}

async function probeVector(db: Database): Promise<boolean> {
  const table = `${PROBE_PREFIX}_vector`;
  const index = `${PROBE_PREFIX}_vector_idx`;
  await dropIfExists(db, table);
  try {
    await db.execute(
      `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, embedding F32_BLOB(1024) NOT NULL)`,
    );
    await db.execute(
      `CREATE INDEX ${index} ON ${table}(libsql_vector_idx(embedding, 'metric=cosine'))`,
    );
    const sample = JSON.stringify(new Array(1024).fill(0.1));
    await db.execute({
      sql: `INSERT INTO ${table} (id, embedding) VALUES (1, vector32(?))`,
      args: [sample],
    });
    const top = await db.execute({
      sql: `SELECT id FROM vector_top_k('${index}', vector32(?), 1)`,
      args: [sample],
    });
    return top.rows.length === 1;
  } catch {
    return false;
  } finally {
    await dropIfExists(db, table);
  }
}

/**
 * Directly exercises each capability compatibility/implementation-plan.md
 * §9 requires `iroha doctor` to report (FTS5 `unicode61`, FTS5 `trigram`,
 * `F32_BLOB(1024)` + `libsql_vector_idx` + `vector_top_k`), using disposable
 * scratch tables rather than assuming the real schema is already migrated —
 * this lets `doctor` distinguish "libSQL build lacks the feature" from
 * "database not yet migrated".
 */
export async function probeCapabilities(db: Database): Promise<StorageCapabilities> {
  return {
    ftsUnicode61: await probeFts(db, "unicode61 remove_diacritics 2 tokenchars '-_'", "unicode61"),
    ftsTrigram: await probeFts(db, "trigram case_sensitive 0", "trigram"),
    vector: await probeVector(db),
  };
}
