import { IrohaError } from "@iroha/domain";
import { LibsqlError } from "@libsql/client";

/**
 * Matches implementation/database-schema.md §3: `PRAGMA busy_timeout = 2500`
 * already makes the driver wait up to 2.5s before this surfaces (confirmed
 * by reproduction), but a writer that loses the race after that wait still
 * needs to map to `DB_BUSY` so callers (transaction.ts) can retry.
 */
const BUSY_CODES = new Set(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_BUSY_TIMEOUT"]);

const CONSTRAINT_CODES = new Set([
  "SQLITE_CONSTRAINT",
  "SQLITE_CONSTRAINT_CHECK",
  "SQLITE_CONSTRAINT_FOREIGNKEY",
  "SQLITE_CONSTRAINT_NOTNULL",
  "SQLITE_CONSTRAINT_PRIMARYKEY",
  "SQLITE_CONSTRAINT_TRIGGER",
  "SQLITE_CONSTRAINT_UNIQUE",
]);

const UNAVAILABLE_CODES = new Set([
  "SQLITE_CANTOPEN",
  "SQLITE_IOERR",
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
  "SQLITE_READONLY",
]);

/**
 * Maps a thrown `@libsql/client` error to the shared `ErrorCode` union
 * (mcp-contract.md §4). `cause` keeps the original `LibsqlError` for local
 * diagnostics, but `message`/`details` never include raw SQL, bound
 * argument values, or filesystem paths — mcp-contract.md §4 forbids
 * returning those to the model, and this error can reach an MCP response
 * as-is.
 */
export function mapLibsqlError(
  cause: unknown,
  fallbackMessage = "Database operation failed",
): IrohaError {
  if (cause instanceof LibsqlError) {
    if (BUSY_CODES.has(cause.code)) {
      return new IrohaError("DB_BUSY", "Database is busy", { retryable: true, cause });
    }
    if (CONSTRAINT_CODES.has(cause.code)) {
      return new IrohaError("CONFLICT", "Database constraint violation", { cause });
    }
    if (UNAVAILABLE_CODES.has(cause.code)) {
      return new IrohaError("DB_UNAVAILABLE", "Database is unavailable", { cause });
    }
  }
  return new IrohaError("INTERNAL_ERROR", fallbackMessage, { cause });
}
