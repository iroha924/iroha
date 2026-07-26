/**
 * In-process, per-repository write serialization (canonical-schema.md §12 step 1:
 * "acquire a per-repository canonical write lock"). The MCP server and the
 * dashboard each run as a single process that can have concurrent in-flight
 * writers — the dashboard serves concurrent HTTP requests, and the MCP SDK
 * dispatches tool calls without awaiting each handler, so parallel tool use can
 * overlap. A promise chain keyed by repository id serializes those critical
 * sections so at most one is mid-write at a time, instead of each racer blocking
 * ~2.5s on libSQL's native `busy_timeout` wait (which starves the event loop).
 *
 * Callers that cannot have a concurrent in-process writer — a hook (one event
 * per short-lived process), `iroha sync`, forge sync (one-shot CLI) — do not
 * need it.
 *
 * It deliberately does NOT provide a cross-process lock. No cross-process lock
 * primitive exists in this repo and it has been deferred repeatedly; see the
 * WP-09 ADR. A canonical write in another process (a second `iroha` invocation)
 * is not serialized against this one — the canonical file rename is still
 * atomic, MCP writes stay correct via the idempotency-key conflict path, and a
 * DB divergence is repaired by the next `sync`, but simultaneous writers across
 * processes are not mutually excluded.
 */
const chains = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` after any previously queued critical section for the same
 * repository has settled (resolved or rejected), so writes never overlap
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
