import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { err, IrohaError, ok, type Result } from "@iroha/domain";
import { type Client, createClient } from "@libsql/client";
import { mapLibsqlError } from "./errors.js";

export type Database = Client;

/**
 * The subset of `Client`/`Transaction` that repository functions need.
 * Both types satisfy this structurally, so a repository function written
 * against `Executor` runs unchanged whether called directly against a
 * `Database` (single, independently-committed statement) or against a
 * `Transaction` handed out by `withTransaction` (composed atomically with
 * other repository calls) — without this package building its own
 * transaction-aware ORM layer.
 */
export type Executor = Pick<Client, "execute">;

/**
 * Confirmed by reproduction: a failure while opening a local `file:`
 * database (e.g. the path is a directory, not a file) throws a plain
 * `Error` from the native binding — not a `LibsqlError` — whose `.message`
 * embeds the absolute path (`ConnectionFailed("Unable to open connection to
 * local database <path>: 14")`). `mapLibsqlError` cannot classify that shape
 * and falls back to `INTERNAL_ERROR`; since every caller of this helper is
 * already inside an "open the database" context, any otherwise-unclassified
 * failure here is a `DB_UNAVAILABLE` condition, and the fallback message
 * (never the raw `cause.message`) is what reaches `message`/`details`.
 */
function mapOpenFailure(cause: unknown, fallbackMessage: string): IrohaError {
  const mapped = mapLibsqlError(cause, fallbackMessage);
  return mapped.code === "INTERNAL_ERROR"
    ? new IrohaError("DB_UNAVAILABLE", fallbackMessage, { cause })
    : mapped;
}

/**
 * Every new connection runs these in order (implementation/database-schema.md
 * §3). Confirmed by reproduction: for a local `file:` URL, `@libsql/client`
 * keeps one native connection per `Client`, so PRAGMAs set here stay in
 * effect for every later `execute()`/`transaction()` call on the same
 * `Database` — they do not need to be re-applied per statement.
 */
const INIT_PRAGMAS = [
  "PRAGMA foreign_keys = ON",
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA busy_timeout = 2500",
  "PRAGMA temp_store = MEMORY",
];

/**
 * Opens (creating if absent) the libSQL database at `path` and applies the
 * required connection PRAGMAs. Callers own `path` resolution — this
 * package never derives `.git`/`iroha` paths itself (that is `@iroha/git`'s
 * responsibility, per implementation/database-schema.md §2).
 */
export async function openDatabase(path: string): Promise<Result<Database, IrohaError>> {
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (cause) {
    return err(mapOpenFailure(cause, "Failed to create database directory"));
  }

  let client: Client;
  try {
    client = createClient({ url: `file:${path}` });
  } catch (cause) {
    return err(mapOpenFailure(cause, "Failed to open database"));
  }

  try {
    for (const pragma of INIT_PRAGMAS) {
      await client.execute(pragma);
    }
  } catch (cause) {
    client.close();
    return err(mapOpenFailure(cause, "Failed to initialize database connection"));
  }

  return ok(client);
}

export function closeDatabase(db: Database): void {
  db.close();
}
