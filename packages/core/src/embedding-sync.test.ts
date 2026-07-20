import { fileURLToPath } from "node:url";
import { writeCanonicalDocument } from "@iroha/canonical";
import type { RepositoryConfig } from "@iroha/config";
import {
  CryptoRandomSource,
  err,
  FixedClock,
  IrohaError,
  makeTypedId,
  ok,
  type TypedId,
} from "@iroha/domain";
import type { EmbeddingProvider } from "@iroha/search";
import {
  closeDatabase,
  type Database,
  enqueueEmbeddingJob,
  getSearchDocumentByEntityId,
  listDueEmbeddingJobs,
  listOpenDirtyMarkers,
  openDatabase,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "./commands.js";
import { runEmbeddingSync } from "./embedding-sync.js";
import { createTempGitRepo, removeTempDir } from "./test-helpers/tmp-repo.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));
const SEED_TIMEOUT_MS = 15000;
const CLOCK = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));

type EmbeddingConfig = RepositoryConfig["search"]["embedding"];

function embeddingConfig(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    enabled: true,
    provider: "voyage",
    model: "voyage-4",
    dimension: 1024,
    api_key_env: "VOYAGE_API_KEY",
    ...overrides,
  };
}

function fakeProvider(behavior: { vector?: number[]; error?: IrohaError }): {
  provider: EmbeddingProvider;
  calls: () => number;
} {
  let calls = 0;
  return {
    provider: {
      async embed(texts) {
        calls += 1;
        if (behavior.error !== undefined) {
          return err(behavior.error);
        }
        return ok(texts.map(() => behavior.vector ?? new Array(1024).fill(0.02)));
      },
    },
    calls: () => calls,
  };
}

interface Seeded {
  repoDir: string;
  dbPath: string;
  repositoryId: TypedId<"repo">;
  entityId: string;
}

/** Bootstraps a repo, writes one approved Decision, and syncs it so exactly one embedding job is pending. */
async function seedRepoWithPendingJob(): Promise<Seeded> {
  const repoDir = await createTempGitRepo();
  const boot = await runInit(repoDir, MIGRATIONS_DIR);
  if (!boot.ok) {
    throw new Error(`init failed: ${boot.error.message}`);
  }
  const entityId = makeTypedId("dec", CLOCK, new CryptoRandomSource());
  const written = await writeCanonicalDocument(
    {
      frontmatter: {
        schema_version: 1,
        id: entityId,
        type: "decision",
        title: "Use libSQL as the local index",
        status: "approved",
        revision: 1,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        created_by: { provider: "git", display_name: "Example Developer" },
        approved_by: { provider: "git", display_name: "Example Reviewer" },
        approved_at: "2026-01-01T00:00:00.000Z",
        labels: [],
        scope: { repository: boot.value.init.repositoryId, paths: [], symbols: [] },
        sources: [{ type: "url", ref: "https://example.com" }],
        relations: [],
        decision: { kind: "architecture" },
      },
      body: [
        "# Use libSQL as the local index",
        "## Context",
        "",
        "Context.",
        "## Decision",
        "",
        "Decision.",
        "## Rationale",
        "",
        "Rationale.",
        "## Consequences",
        "",
        "Consequences.",
        "## Alternatives considered",
        "",
        "None.",
      ].join("\n\n"),
    },
    boot.value.init.irohaCanonicalDir,
    new CryptoRandomSource(),
  );
  if (!written.ok) {
    throw new Error(`write failed: ${written.error.message}`);
  }
  const synced = await runInit(repoDir, MIGRATIONS_DIR);
  if (!synced.ok) {
    throw new Error(`sync failed: ${synced.error.message}`);
  }
  return {
    repoDir,
    dbPath: boot.value.init.dbPath,
    repositoryId: boot.value.init.repositoryId,
    entityId,
  };
}

describe("runEmbeddingSync", () => {
  let repoDir: string | undefined;
  let db: Database | undefined;

  afterEach(async () => {
    if (db) {
      await closeDatabase(db);
      db = undefined;
    }
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
  });

  async function openSeeded(): Promise<{ db: Database; seeded: Seeded }> {
    const seeded = await seedRepoWithPendingJob();
    repoDir = seeded.repoDir;
    const opened = await openDatabase(seeded.dbPath);
    if (!opened.ok) {
      throw new Error(`open failed: ${opened.error.message}`);
    }
    db = opened.value;
    return { db: opened.value, seeded };
  }

  it(
    "embeds a pending job and marks it completed",
    async () => {
      const { db: database, seeded } = await openSeeded();
      const fake = fakeProvider({});

      const result = await runEmbeddingSync(
        database,
        seeded.repositoryId,
        embeddingConfig(),
        CLOCK,
        new CryptoRandomSource(),
        { provider: fake.provider },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatchObject({ processed: 1, failed: 0, dead: 0, skipped: null });
      }
      expect(fake.calls()).toBe(1);
      const due = await listDueEmbeddingJobs(database, CLOCK.now().toISOString(), 10);
      expect(due.ok && due.value).toEqual([]);
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "skips the provider when a current embedding already exists (rebuild reuse guard)",
    async () => {
      const { db: database, seeded } = await openSeeded();
      // First run writes the embedding and completes the job.
      const first = fakeProvider({});
      await runEmbeddingSync(
        database,
        seeded.repositoryId,
        embeddingConfig(),
        CLOCK,
        new CryptoRandomSource(),
        {
          provider: first.provider,
        },
      );
      expect(first.calls()).toBe(1);

      // Re-enqueue the same document (revives completed -> pending).
      const doc = await getSearchDocumentByEntityId(database, seeded.entityId);
      expect(doc.ok && doc.value).not.toBeNull();
      if (!doc.ok || doc.value === null) return;
      const requeued = await enqueueEmbeddingJob(database, {
        id: makeTypedId("job", CLOCK, new CryptoRandomSource()),
        searchDocumentId: doc.value.id,
        provider: "voyage",
        model: "voyage-4",
        createdAt: CLOCK.now().toISOString(),
        updatedAt: CLOCK.now().toISOString(),
      });
      expect(requeued.ok).toBe(true);

      // Second run must complete the job WITHOUT calling the provider.
      const second = fakeProvider({});
      const result = await runEmbeddingSync(
        database,
        seeded.repositoryId,
        embeddingConfig(),
        CLOCK,
        new CryptoRandomSource(),
        { provider: second.provider },
      );
      expect(result.ok && result.value.processed).toBe(1);
      expect(second.calls()).toBe(0);
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "backs off (does not dead-letter) on a retryable provider outage",
    async () => {
      const { db: database, seeded } = await openSeeded();
      const fake = fakeProvider({
        error: new IrohaError("EMBEDDING_UNAVAILABLE", "provider down", { retryable: true }),
      });

      const result = await runEmbeddingSync(
        database,
        seeded.repositoryId,
        embeddingConfig(),
        CLOCK,
        new CryptoRandomSource(),
        { provider: fake.provider },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatchObject({ processed: 0, failed: 1, dead: 0, skipped: null });
      }
      // Backed off: not due at `now`, but still present as a failed job.
      const due = await listDueEmbeddingJobs(database, CLOCK.now().toISOString(), 10);
      expect(due.ok && due.value).toEqual([]);
      const markers = await listOpenDirtyMarkers(database, seeded.repositoryId, "embedding_retry");
      expect(markers.ok && markers.value).toEqual([]);
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "dead-letters and records a dirty marker on a non-retryable failure",
    async () => {
      const { db: database, seeded } = await openSeeded();
      const fake = fakeProvider({
        error: new IrohaError("EMBEDDING_UNAVAILABLE", "bad request", { retryable: false }),
      });

      const result = await runEmbeddingSync(
        database,
        seeded.repositoryId,
        embeddingConfig(),
        CLOCK,
        new CryptoRandomSource(),
        { provider: fake.provider },
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatchObject({ processed: 0, failed: 0, dead: 1, skipped: null });
      }
      const markers = await listOpenDirtyMarkers(database, seeded.repositoryId, "embedding_retry");
      expect(markers.ok && markers.value.length).toBe(1);
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "skips all work when embedding is disabled",
    async () => {
      const { db: database, seeded } = await openSeeded();
      const fake = fakeProvider({});

      const result = await runEmbeddingSync(
        database,
        seeded.repositoryId,
        embeddingConfig({ enabled: false }),
        CLOCK,
        new CryptoRandomSource(),
        { provider: fake.provider },
      );

      expect(result.ok && result.value.skipped).toBe("disabled");
      expect(fake.calls()).toBe(0);
    },
    SEED_TIMEOUT_MS,
  );

  it(
    "skips when enabled but the API key env var is unset",
    async () => {
      const { db: database, seeded } = await openSeeded();

      const result = await runEmbeddingSync(
        database,
        seeded.repositoryId,
        embeddingConfig({ api_key_env: "IROHA_TEST_DEFINITELY_UNSET_KEY" }),
        CLOCK,
        new CryptoRandomSource(),
        // No provider injected: forces the config+env resolution path.
      );

      expect(result.ok && result.value.skipped).toBe("missing_key");
    },
    SEED_TIMEOUT_MS,
  );
});
