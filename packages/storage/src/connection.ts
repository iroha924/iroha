import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
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
    // Confirmed by reproduction: a raw `file:${path}` string breaks when
    // `path` contains URL metacharacters legal in POSIX (and Windows, for
    // `#`) directory names — `#` throws `URL_INVALID: URL fragments are
    // not supported` outright, and `?` would similarly be parsed as a
    // query string, either failing to open or opening the wrong path.
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
 * Confirmed by external research (SQLite's own docs at
 * https://sqlite.org/tempfiles.html, and matching reports against multiple
 * Node SQLite bindings — e.g. https://github.com/oven-sh/bun/issues/25964,
 * https://github.com/JoshuaWise/better-sqlite3/issues/376): in WAL mode,
 * closing the last connection to a database makes SQLite acquire an
 * exclusive lock, checkpoint, and delete the `-wal`/`-shm` files before
 * releasing it — and on Windows this can leave the main `.db` file locked
 * for longer than `db.close()` returning suggests, causing `EBUSY` on an
 * immediately-following `rename()`/`rm()` (this package's own
 * `renameWithRetry` in `rebuild.ts` exists because of exactly that). Every
 * connection this package opens re-applies `INIT_PRAGMAS` (including
 * `journal_mode = WAL`) on next open, so switching to `DELETE` mode here is
 * a transient, connection-local change, not a lasting one — it avoids that
 * checkpoint-and-delete sequence entirely. Best-effort: this can fail if
 * another connection is still attached to the same database, and does not
 * fail `closeDatabase` if so.
 */
export async function closeDatabase(db: Database): Promise<void> {
  await db.execute("PRAGMA journal_mode = DELETE").catch(() => undefined);
  db.close();
}
