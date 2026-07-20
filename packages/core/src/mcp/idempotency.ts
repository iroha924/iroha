import type { Clock, IrohaError, Result, TypedId } from "@iroha/domain";
import { err, ok } from "@iroha/domain";
import {
  type Database,
  type Executor,
  getIdempotencyRecord,
  insertIdempotencyRecord,
  withTransaction,
} from "@iroha/storage";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotentWriteArgs<T> {
  db: Database;
  clock: Clock;
  repositoryId: TypedId<"repo">;
  operation: string;
  idempotencyKey: string;
  /** Reconstructs the response from a stored record (a dedup hit). */
  fromStored: (responseJson: string) => T;
  /** Serializes a fresh result for storage, plus an optional linked entity id. */
  toStored: (data: T) => { responseJson: string; resultEntityId?: string };
  /** The write body; runs inside the transaction, before the idempotency row is recorded. */
  work: (tx: Executor) => Promise<Result<T, IrohaError>>;
}

/**
 * Runs a local MCP write under the idempotency contract (mcp-contract.md §9): a
 * repeat of the same (repository, operation, key) returns the original result
 * and never duplicates the write. A pre-check short-circuits the common retry;
 * the idempotency row is inserted last inside the same transaction, so a
 * concurrent racer that wins the unique key rolls this one back — its stored
 * result is then returned instead of the constraint error.
 */
export async function runIdempotentWrite<T>(
  args: IdempotentWriteArgs<T>,
): Promise<Result<T, IrohaError>> {
  const existing = await getIdempotencyRecord(
    args.db,
    args.repositoryId,
    args.operation,
    args.idempotencyKey,
  );
  if (!existing.ok) {
    return err(existing.error);
  }
  if (existing.value !== null) {
    return ok(args.fromStored(existing.value.responseJson));
  }

  const now = args.clock.now();
  const committed = await withTransaction(
    args.db,
    "write",
    async (tx): Promise<Result<T, IrohaError>> => {
      const result = await args.work(tx);
      if (!result.ok) {
        return result;
      }
      const stored = args.toStored(result.value);
      const recorded = await insertIdempotencyRecord(tx, {
        repositoryId: args.repositoryId,
        operation: args.operation,
        idempotencyKey: args.idempotencyKey,
        ...(stored.resultEntityId !== undefined ? { resultEntityId: stored.resultEntityId } : {}),
        responseJson: stored.responseJson,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
      });
      if (!recorded.ok) {
        return err(recorded.error);
      }
      return ok(result.value);
    },
  );

  if (!committed.ok && committed.error.code === "CONFLICT") {
    const winner = await getIdempotencyRecord(
      args.db,
      args.repositoryId,
      args.operation,
      args.idempotencyKey,
    );
    if (winner.ok && winner.value !== null) {
      return ok(args.fromStored(winner.value.responseJson));
    }
  }
  return committed;
}
