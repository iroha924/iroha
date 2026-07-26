import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixedClock, type TypedId } from "@iroha/domain";
import {
  closeDatabase,
  type Database,
  insertRepository,
  openDatabase,
  runMigrations,
} from "@iroha/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DOCS } from "./fixture.js";
import { runEval } from "./run-eval.js";
import { seedFixture } from "./seed.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const RECORDED_PATH = fileURLToPath(new URL("./embeddings.recorded.json", import.meta.url));
// The gate runs only once the recorded vectors exist. They are generated once
// with a real Voyage key (see record-embeddings.test.ts); the hybrid path — and
// the cross-lingual JA↔EN and relationship queries in particular — cannot be
// evaluated on lexical FTS alone, so without the recording the gate is skipped
// rather than run against a partial pipeline.
const RECORDED_EXISTS = existsSync(RECORDED_PATH);
const FIXED_AT = "2026-01-01T00:00:00.000Z";
const REPOSITORY_ID = "repo_eval0000000000000000000000" as TypedId<"repo">;

interface Recorded {
  corpus: Record<string, number[]>;
  queries: Record<string, number[]>;
}

// contracts/database.md §14 initial-release thresholds (absolute floors).
const RECALL_AT_10 = 0.85;
const NDCG_AT_10 = 0.7;
const MRR_AT_10 = 0.7;

// Regression gate: the metrics actually achieved with the committed
// embeddings.recorded.json. A drop below (baseline - BASELINE_TOLERANCE) is a
// ranking regression the loose absolute floors above (0.85/0.70) would miss.
// Tolerance exceeds one Recall@10 quantum (1/60 ≈ 0.0167): the vector arm is
// libSQL's native ANN (vector_top_k), whose top-k membership for a doc sitting
// on the rank-10 boundary is not guaranteed bit-identical across the x64/arm64
// CI matrix, so one boundary doc flipping must not red CI — while a real
// regression moves many queries and drops far more than this. When a fixture or
// ranking change legitimately moves these, re-record and update BASELINE to the
// values printed in the "eval metrics" CI log line. ruleRecallAt10 is gated
// separately by the exact `toBe(1)` assertion (spec §14), not here.
const BASELINE = {
  recallAt10: 0.975,
  ndcgAt10: 0.967,
  mrrAt10: 0.975,
};
const BASELINE_TOLERANCE = 0.03;

describe("search evaluation gate", () => {
  let dir: string | undefined;
  let db: Database | undefined;
  let recorded: Recorded;

  beforeAll(async () => {
    if (!RECORDED_EXISTS) {
      return;
    }
    recorded = JSON.parse(await readFile(RECORDED_PATH, "utf8")) as Recorded;

    dir = await mkdtemp(join(tmpdir(), "iroha-eval-"));
    const dbPath = join(dir, "index.db");
    const opened = await openDatabase(dbPath);
    if (!opened.ok) {
      throw new Error(`open failed: ${opened.error.message}`);
    }
    db = opened.value;
    const migrated = await runMigrations(
      db,
      MIGRATIONS_DIR,
      dbPath,
      new FixedClock(new Date(FIXED_AT)),
    );
    if (!migrated.ok) {
      throw new Error(`migrate failed: ${migrated.error.message}`);
    }
    const repo = await insertRepository(db, {
      id: REPOSITORY_ID,
      rootFingerprint: "fp-eval",
      createdAt: FIXED_AT,
      updatedAt: FIXED_AT,
    });
    if (!repo.ok) {
      throw new Error(`insertRepository failed: ${repo.error.message}`);
    }
    await seedFixture(db, REPOSITORY_ID, recorded.corpus);
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await closeDatabase(db);
    }
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!RECORDED_EXISTS)(
    "meets the initial-release ranking thresholds",
    async () => {
      if (db === undefined) {
        throw new Error("db not initialized");
      }
      const report = await runEval(db, REPOSITORY_ID, recorded.queries);
      // Surfaced so a threshold regression shows the actual numbers in CI logs.
      // biome-ignore lint/suspicious/noConsole: eval metrics are the point of this test's output.
      console.log(`eval metrics: ${JSON.stringify(report, null, 2)}`);

      expect(report.queryCount).toBeGreaterThanOrEqual(60);
      // Distractors keep top-10 a small fraction of the corpus so Recall@10 is
      // not structurally inflated; guard that they stay seeded.
      expect(DOCS.length).toBeGreaterThanOrEqual(60);

      // Absolute floors (spec §14).
      expect(report.overall.recallAt10).toBeGreaterThanOrEqual(RECALL_AT_10);
      expect(report.overall.ndcgAt10).toBeGreaterThanOrEqual(NDCG_AT_10);
      expect(report.overall.mrrAt10).toBeGreaterThanOrEqual(MRR_AT_10);
      expect(report.ruleRecallAt10).toBe(1);

      // Regression gate against the recorded baseline.
      expect(report.overall.recallAt10).toBeGreaterThanOrEqual(
        BASELINE.recallAt10 - BASELINE_TOLERANCE,
      );
      expect(report.overall.ndcgAt10).toBeGreaterThanOrEqual(
        BASELINE.ndcgAt10 - BASELINE_TOLERANCE,
      );
      expect(report.overall.mrrAt10).toBeGreaterThanOrEqual(BASELINE.mrrAt10 - BASELINE_TOLERANCE);
    },
    30_000,
  );
});
