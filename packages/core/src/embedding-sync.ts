import type { RepositoryConfig } from "@iroha/config";
import {
  type Clock,
  err,
  IrohaError,
  makeTypedId,
  ok,
  type RandomSource,
  type Result,
  type TypedId,
} from "@iroha/domain";
import { createVoyageProvider, type EmbeddingProvider } from "@iroha/search";
import {
  type Database,
  getEmbeddingMetadataBySearchDocumentId,
  getSearchDocumentById,
  insertDirtyMarker,
  listDueEmbeddingJobs,
  updateEmbeddingJobStatus,
  upsertEmbedding,
} from "@iroha/storage";

type EmbeddingConfig = RepositoryConfig["search"]["embedding"];

/** Bounded work per `listDueEmbeddingJobs` poll. */
const JOB_BATCH = 128;
/** Backstop against a runaway loop; a very large index simply finishes over several syncs. */
const MAX_JOBS_PER_RUN = 10_000;
/** After this many attempts a job is dead-lettered and a dirty marker surfaces it. */
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_CAP_SECONDS = 3_600;

export interface RunEmbeddingSyncResult {
  /** Jobs whose vector was written this run. */
  processed: number;
  /** Jobs left `failed` with a future retry (transient provider outage). */
  failed: number;
  /** Jobs dead-lettered (non-retryable, or retry budget exhausted). */
  dead: number;
  /** Non-null when no work was attempted because embedding is off or unconfigured. */
  skipped: "disabled" | "missing_key" | null;
}

export interface RunEmbeddingSyncOptions {
  /** Injected in tests to avoid network/env; defaults to a Voyage provider built from config + env. */
  provider?: EmbeddingProvider;
}

/**
 * Builds a Voyage provider from config + env, or returns `null` when embedding
 * is disabled or its API key env var is unset. Shared by the sync worker and
 * the query-embedding path (`mcpSearch`) so both resolve the key identically —
 * and neither ever puts the value anywhere but the provider's request header.
 */
export function resolveEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider | null {
  if (!config.enabled) {
    return null;
  }
  const apiKey = process.env[config.api_key_env];
  if (apiKey === undefined || apiKey.length === 0) {
    return null;
  }
  return createVoyageProvider({ apiKey, model: config.model, dimension: config.dimension });
}

/** Exponential backoff (deterministic — single local writer, no jitter needed). */
function backoffAt(clock: Clock, attempts: number): string {
  const seconds = Math.min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 2 ** (attempts - 1));
  return new Date(clock.now().getTime() + seconds * 1000).toISOString();
}

/**
 * Drains the `embedding_jobs` queue during `iroha sync`: for each due job it
 * embeds the document's text and writes the vector, or records retry/backoff
 * state on failure. An embedding outage never fails the overall sync
 * (CLAUDE.md: "Embedding failure must degrade to lexical search") — provider
 * failures are captured per job as `failed`/`dead` and this returns `ok` with
 * counts; only a real DB/programming error returns `err`.
 *
 * A retryable provider failure (network, 429/5xx) will almost certainly hit
 * every remaining job this run too, so the first one backs its job off and
 * stops the run rather than burning the whole queue's retry budget on one
 * outage. A non-retryable failure (4xx, malformed body) is specific to one
 * document, so that job is dead-lettered and the run continues.
 */
export async function runEmbeddingSync(
  db: Database,
  repositoryId: TypedId<"repo">,
  config: EmbeddingConfig,
  clock: Clock,
  random: RandomSource,
  options: RunEmbeddingSyncOptions = {},
): Promise<Result<RunEmbeddingSyncResult, IrohaError>> {
  if (!config.enabled) {
    return ok({ processed: 0, failed: 0, dead: 0, skipped: "disabled" });
  }
  // Reuse the shared resolver (config already known enabled here, so a null
  // means the API key env var is unset) rather than re-reading the env inline —
  // any future hardening of key resolution then reaches the worker too.
  const provider = options.provider ?? resolveEmbeddingProvider(config);
  if (provider === null) {
    return ok({ processed: 0, failed: 0, dead: 0, skipped: "missing_key" });
  }

  let processed = 0;
  let failed = 0;
  let dead = 0;

  while (processed + failed + dead < MAX_JOBS_PER_RUN) {
    const dueResult = await listDueEmbeddingJobs(db, clock.now().toISOString(), JOB_BATCH);
    if (!dueResult.ok) {
      return dueResult;
    }
    if (dueResult.value.length === 0) {
      break;
    }

    let outage = false;
    for (const job of dueResult.value) {
      const docResult = await getSearchDocumentById(db, job.searchDocumentId);
      if (!docResult.ok) {
        return docResult;
      }
      const doc = docResult.value;
      if (doc === null) {
        // The FK cascade removes jobs when their document is deleted, so this
        // is only transiently reachable; complete it so it is not retried.
        const marked = await updateEmbeddingJobStatus(db, job.id, {
          status: "completed",
          updatedAt: clock.now().toISOString(),
        });
        if (!marked.ok) {
          return marked;
        }
        continue;
      }

      // Skip the provider call when a current vector already exists for this
      // exact content — e.g. one carried across a `sync --rebuild` by
      // `reuseEmbeddings`. This is what realizes the rebuild-reuse cost saving
      // (database-schema.md §12 steps 8-9): the vector is present, so the job
      // just completes.
      const existing = await getEmbeddingMetadataBySearchDocumentId(db, job.searchDocumentId);
      if (!existing.ok) {
        return existing;
      }
      if (existing.value !== null && existing.value.contentHash === doc.contentHash) {
        const marked = await updateEmbeddingJobStatus(db, job.id, {
          status: "completed",
          updatedAt: clock.now().toISOString(),
        });
        if (!marked.ok) {
          return marked;
        }
        processed += 1;
        continue;
      }

      const embedded = await provider.embed([`${doc.title}\n\n${doc.body}`], "document");
      if (embedded.ok) {
        const vector = embedded.value[0];
        if (vector === undefined) {
          return err(
            new IrohaError("INTERNAL_ERROR", "Embedding provider returned no vector for input"),
          );
        }
        const upserted = await upsertEmbedding(db, {
          searchDocumentId: job.searchDocumentId,
          contentHash: doc.contentHash,
          embedding: vector,
          createdAt: clock.now().toISOString(),
        });
        if (!upserted.ok) {
          return upserted;
        }
        const marked = await updateEmbeddingJobStatus(db, job.id, {
          status: "completed",
          updatedAt: clock.now().toISOString(),
        });
        if (!marked.ok) {
          return marked;
        }
        processed += 1;
        continue;
      }

      const attempts = job.attempts + 1;
      const isTerminal = !embedded.error.retryable || attempts >= MAX_ATTEMPTS;
      const status = isTerminal ? "dead" : "failed";
      const marked = await updateEmbeddingJobStatus(db, job.id, {
        status,
        attempts,
        ...(status === "failed" ? { nextAttemptAt: backoffAt(clock, attempts) } : {}),
        lastErrorCode: embedded.error.code,
        updatedAt: clock.now().toISOString(),
      });
      if (!marked.ok) {
        return marked;
      }
      if (status === "dead") {
        dead += 1;
        const marker = await insertDirtyMarker(db, {
          id: makeTypedId("dirty", clock, random),
          repositoryId,
          markerType: "embedding_retry",
          entityId: doc.entityId,
          detailsJson: JSON.stringify({ jobId: job.id, lastErrorCode: embedded.error.code }),
          createdAt: clock.now().toISOString(),
        });
        if (!marker.ok) {
          return marker;
        }
      } else {
        failed += 1;
      }
      if (embedded.error.retryable) {
        outage = true;
        break;
      }
    }

    if (outage) {
      break;
    }
  }

  return ok({ processed, failed, dead, skipped: null });
}
