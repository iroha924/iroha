import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { err, IrohaError, ok, type Result } from "@iroha/domain";
import { type Client, createClient } from "@libsql/client";
import { mapLibsqlError } from "./errors.js";

export type Database = Client;

/**
 * The subset of `Client`/`Transaction` that repository functions need. Both
 * satisfy it structurally, so a repository function written against `Executor`
 * runs unchanged against a `Database` (an independently-committed statement) or
 * a `Transaction` from `withTransaction` (composed atomically), without this
 * package building its own transaction-aware ORM layer.
 */
export type Executor = Pick<Client, "execute">;

/**
 * A failure while opening a local `file:` database (e.g. the path is a
 * directory, not a file) throws a plain `Error` from the native binding — not
 * a `LibsqlError` — whose `.message` embeds the absolute path. `mapLibsqlError`
 * cannot classify that shape and falls back to `INTERNAL_ERROR`; since every
 * caller is inside an "open the database" context, any otherwise-unclassified
 * failure here is `DB_UNAVAILABLE`, and the fallback message (never the raw
 * `cause.message`, which holds the path) reaches `message`/`details`.
 */
function mapOpenFailure(cause: unknown, fallbackMessage: string): IrohaError {
  const mapped = mapLibsqlError(cause, fallbackMessage);
  return mapped.code === "INTERNAL_ERROR"
    ? new IrohaError("DB_UNAVAILABLE", fallbackMessage, { cause })
    : mapped;
}

/**
 * Every new connection runs these in order (contracts/database.md
 * §3). For a local `file:` URL `@libsql/client` keeps one native connection
 * per `Client`, so PRAGMAs set here stay in effect for every later
 * `execute()`/`transaction()` call on the same `Database` — they need not be
 * re-applied per statement.
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
 * responsibility, per contracts/database.md §2).
 */
export async function openDatabase(path: string): Promise<Result<Database, IrohaError>> {
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (cause) {
    return err(mapOpenFailure(cause, "Failed to create database directory"));
  }

  let client: Client;
  try {
    // A raw `file:${path}` string breaks when `path` contains URL
    // metacharacters legal in POSIX (and Windows, for `#`) directory names:
    // `#` throws `URL_INVALID: URL fragments are not supported`, and `?` is
    // parsed as a query string, opening the wrong path or failing.
    // `pathToFileURL` percent-encodes the path into a valid `file:` URL.
    client = createClient({ url: pathToFileURL(path).href });
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

/**
 * In WAL mode, closing the last connection makes SQLite acquire an exclusive
 * lock, checkpoint, and delete the `-wal`/`-shm` files before releasing it —
 * and on Windows this can leave the main `.db` file locked longer than
 * `db.close()` returning suggests, causing `EBUSY` on an immediately-following
 * `rename()`/`rm()` (why `rebuild.ts`'s `renameWithRetry` exists). Switching to
 * `DELETE` mode here avoids that checkpoint-and-delete sequence entirely, and
 * is transient: every connection re-applies `INIT_PRAGMAS` (`journal_mode =
 * WAL`) on next open. Best-effort — this has no effect if another connection
 * is still attached, and does not fail `closeDatabase` if so.
 */
export async function closeDatabase(db: Database): Promise<void> {
  await db.execute("PRAGMA journal_mode = DELETE").catch(() => undefined);
  db.close();
}
