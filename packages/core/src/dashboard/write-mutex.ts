/**
 * In-process, per-repository serialization for the canonical approval
 * transaction (canonical-schema.md §12 step 1: "acquire a per-repository
 * canonical write lock"). The dashboard runs as a single process, so a promise
 * chain keyed by repository id serializes concurrent approve/reject/supersede
 * critical sections within it — enough to keep the file write + DB commit of
 * one approval from interleaving with another.
 *
 * It deliberately does NOT provide a cross-process lock. No cross-process lock
 * primitive exists in this repo and it has been deferred repeatedly
 * (decision-log ID-022 / ID-024(5) / ID-026(10) / ID-028(q) / ID-030); see the
 * WP-09 ADR. A canonical write happening in another process (e.g. the MCP
 * server, or a second `iroha` invocation) is not serialized against this one —
 * the canonical file rename is still atomic, and a DB divergence is repaired by
 * the next `sync`, but simultaneous writers are not mutually excluded.
 */
const chains = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` after any previously queued critical section for the same
 * repository has settled (resolved or rejected), so approvals never overlap
 * in-process. One section's failure does not poison the lock for the next.
 */
export async function withRepositoryWriteLock<T>(
  repositoryId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(repositoryId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  chains.set(
    repositoryId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
