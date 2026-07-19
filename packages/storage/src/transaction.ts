import { err, type IrohaError, ok, type Result } from "@iroha/domain";
import type { Transaction, TransactionMode } from "@libsql/client";
import type { Database } from "./connection.js";
import { mapLibsqlError } from "./errors.js";

/**
 * implementation/database-schema.md §3: "retry SQLITE_BUSY with bounded
 * jitter for at most 2 seconds". `PRAGMA busy_timeout = 2500` (connection.ts)
 * already makes a *single* driver call wait up to ~2.5s before raising
 * SQLITE_BUSY — and, confirmed by reproduction, that wait is a blocking
 * native call that starves this process's event loop for its whole
 * duration (a competing writer's own release can only run once the call
 * returns, never during it). This 2-second budget therefore starts only
 * once that first attempt has already failed, bounding how much *additional*
 * app-level retrying happens on top of the PRAGMA's own wait, rather than
 * being consumed by (and colliding with) the first attempt's duration.
 */
const BUSY_RETRY_BUDGET_MS = 2000;
const BUSY_RETRY_BASE_DELAY_MS = 20;
const BUSY_RETRY_MAX_DELAY_MS = 250;

function jitteredDelayMs(attempt: number): number {
  const cap = Math.min(BUSY_RETRY_MAX_DELAY_MS, BUSY_RETRY_BASE_DELAY_MS * 2 ** attempt);
  return Math.random() * cap;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeQuietly(tx: Transaction): Promise<void> {
  try {
    tx.close();
  } catch {
    // Best-effort: the transaction may already be closed by a prior
    // commit/rollback, and `Transaction.close()` is documented to no-op in
    // that case, but a driver-level throw here must not shadow the real
    // result already computed above.
  }
}

/**
 * Runs `fn` inside a single interactive transaction, committing on success
 * and rolling back otherwise. `fn` reports its own outcome as a `Result`
 * rather than throwing for expected failures (constraint conflicts, illegal
 * state transitions, ...) — only a driver-level throw (e.g. SQLITE_BUSY
 * while starting the transaction, or an uncaught error inside `fn`) is
 * caught here. Retries the whole attempt, with bounded jitter, only when the
 * failure is SQLITE_BUSY and the retry budget has not elapsed.
 */
export async function withTransaction<T>(
  db: Database,
  mode: TransactionMode,
  fn: (tx: Transaction) => Promise<Result<T, IrohaError>>,
): Promise<Result<T, IrohaError>> {
  // Lazily started on the first SQLITE_BUSY failure — see the budget
  // comment above for why counting the first (PRAGMA-covered) attempt
  // against it would be wrong.
  let retryDeadline: number | undefined;
  let attempt = 0;

  function shouldRetryBusy(): boolean {
    const now = Date.now();
    if (retryDeadline === undefined) {
      retryDeadline = now + BUSY_RETRY_BUDGET_MS;
      return true;
    }
    return now < retryDeadline;
  }

  for (;;) {
    let tx: Transaction;
    try {
      tx = await db.transaction(mode);
    } catch (cause) {
      const mapped = mapLibsqlError(cause, "Failed to start transaction");
      if (mapped.code === "DB_BUSY" && shouldRetryBusy()) {
        await sleep(jitteredDelayMs(attempt));
        attempt += 1;
        continue;
      }
      return err(mapped);
    }

    try {
      const result = await fn(tx);
      if (!result.ok) {
        await tx.rollback();
        if (result.error.code === "DB_BUSY" && shouldRetryBusy()) {
          await sleep(jitteredDelayMs(attempt));
          attempt += 1;
          continue;
        }
        return result;
      }
      await tx.commit();
      return result;
    } catch (cause) {
      await tx.rollback().catch(() => undefined);
      const mapped = mapLibsqlError(cause, "Transaction failed");
      if (mapped.code === "DB_BUSY" && shouldRetryBusy()) {
        await sleep(jitteredDelayMs(attempt));
        attempt += 1;
        continue;
      }
      return err(mapped);
    } finally {
      await closeQuietly(tx);
    }
  }
}
