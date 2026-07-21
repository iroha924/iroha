import { runHook, runSearch } from "@iroha/core";
import { type Clock, makeTypedId, type RandomSource } from "@iroha/domain";
import { closeDatabase, openDatabase } from "@iroha/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedApprovedGeneratedFilesRule } from "./helpers/canonical-seed.js";
import { claudePreTool, claudePrompt, claudeSessionStart } from "./helpers/hook-events.js";
import { buildSliceRepo, cleanupSliceRepo, type SliceRepo } from "./helpers/slice-repo.js";

// vertical-slice.md §7 performance budgets are "regression gates after a stable
// baseline is recorded". This fixture records the baseline and asserts generous
// ceilings (~10-30× the p95 targets) so a gross regression (an N+1, a full scan)
// fails while ordinary shared-runner variance does not.
const ENTITY_COUNT = 10_000;
const SEARCH_CEILING_MS = 3_000; // §7 target p95 300ms
const SESSION_START_CEILING_MS = 5_000; // §7 target p95 1,000ms
const GUARDRAIL_CEILING_MS = 2_000; // §7 target p95 100ms
const CONTENT_HASH = `sha256:${"0".repeat(64)}`;

const SESSION = "perf-sess-1";

let repo: SliceRepo;

async function seedSearchEntities(
  dbPath: string,
  repositoryId: string,
  now: string,
  clock: Clock,
  random: RandomSource,
): Promise<void> {
  const opened = await openDatabase(dbPath);
  if (!opened.ok) throw new Error(`db open failed: ${opened.error.code}`);
  const db = opened.value;
  try {
    const chunk = 500;
    for (let start = 0; start < ENTITY_COUNT; start += chunk) {
      const statements = [];
      for (let index = start; index < Math.min(start + chunk, ENTITY_COUNT); index += 1) {
        const entityId = makeTypedId("dec", clock, random);
        const sdocId = makeTypedId("sdoc", clock, random);
        const title = `Synthetic benchmark decision ${index}`;
        statements.push({
          sql: "INSERT INTO entities (id, repository_id, entity_type, title, status, authority, source_kind, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          args: [
            entityId,
            repositoryId,
            "decision",
            title,
            "approved",
            100,
            "canonical",
            CONTENT_HASH,
            now,
            now,
          ],
        });
        statements.push({
          sql: "INSERT INTO search_documents (id, entity_id, document_kind, title, body, authority, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          args: [
            sdocId,
            entityId,
            "decision",
            title,
            `This synthetic benchmark decision number ${index} concerns the repository pattern and payments.`,
            100,
            CONTENT_HASH,
            now,
          ],
        });
      }
      const result = await db.batch(statements, "write");
      expect(result.length).toBe(statements.length);
    }
  } finally {
    await closeDatabase(db);
  }
}

interface Latency {
  p50: number;
  p95: number;
  max: number;
}

async function measure(iterations: number, run: () => Promise<unknown>): Promise<Latency> {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const at = (quantile: number) =>
    samples[Math.min(samples.length - 1, Math.floor(quantile * samples.length))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), max: samples[samples.length - 1] ?? 0 };
}

beforeAll(async () => {
  repo = await buildSliceRepo();
  await seedApprovedGeneratedFilesRule(repo, { guardrail: true });
  await seedSearchEntities(
    repo.resolved.dbPath,
    repo.resolved.repositoryId,
    repo.clock.now().toISOString(),
    repo.clock,
    repo.random,
  );
  // Establish a session + Turn so PreToolUse has a current Turn to evaluate.
  const deps = { clock: repo.clock, random: repo.random };
  await runHook(
    { platform: "claude_code", raw: claudeSessionStart(repo.repoDir, SESSION), cwd: repo.repoDir },
    deps,
  );
  await runHook(
    {
      platform: "claude_code",
      raw: claudePrompt(repo.repoDir, SESSION, "benchmark", "p1"),
      cwd: repo.repoDir,
    },
    deps,
  );
}, 180_000);

afterAll(async () => {
  if (repo) {
    await cleanupSliceRepo(repo.repoDir);
  }
});

describe(`Performance budgets with ${ENTITY_COUNT} search entities (vertical-slice.md §7)`, () => {
  it("lexical search stays within the regression ceiling", async () => {
    const latency = await measure(20, () =>
      runSearch(repo.repoDir, "synthetic benchmark", { limit: 10 }),
    );
    // biome-ignore lint/suspicious/noConsole: the measured baseline is the point of this test's output.
    console.log(`[perf] search @${ENTITY_COUNT}: ${JSON.stringify(latency)}`);
    expect(latency.p95).toBeLessThan(SEARCH_CEILING_MS);
  }, 60_000);

  it("SessionStart context build stays within the regression ceiling", async () => {
    const deps = { clock: repo.clock, random: repo.random };
    const latency = await measure(15, () =>
      runHook(
        {
          platform: "claude_code",
          raw: claudeSessionStart(repo.repoDir, SESSION, "resume"),
          cwd: repo.repoDir,
        },
        deps,
      ),
    );
    // biome-ignore lint/suspicious/noConsole: the measured baseline is the point of this test's output.
    console.log(`[perf] SessionStart @${ENTITY_COUNT}: ${JSON.stringify(latency)}`);
    expect(latency.p95).toBeLessThan(SESSION_START_CEILING_MS);
  }, 60_000);

  it("PreToolUse guardrail evaluation stays within the regression ceiling", async () => {
    const deps = { clock: repo.clock, random: repo.random };
    // Establish a fresh active Run + Turn on its own session: the SessionStart
    // it-block's `resume`s leave a turn-less Run, and PreToolUse early-returns
    // without evaluating guardrails when there is no current Turn — so measuring
    // there would time a no-op (a false green). A startup + prompt gives a Turn.
    const guardSession = "perf-guard-sess";
    await runHook(
      {
        platform: "claude_code",
        raw: claudeSessionStart(repo.repoDir, guardSession),
        cwd: repo.repoDir,
      },
      deps,
    );
    await runHook(
      {
        platform: "claude_code",
        raw: claudePrompt(repo.repoDir, guardSession, "benchmark", "gp1"),
        cwd: repo.repoDir,
      },
      deps,
    );
    let counter = 0;
    const latency = await measure(20, () => {
      counter += 1;
      return runHook(
        {
          platform: "claude_code",
          raw: claudePreTool(
            repo.repoDir,
            guardSession,
            "Edit",
            { file_path: "src/generated/client.ts", old_string: "a", new_string: "b" },
            `perf-tool-${counter}`,
          ),
          cwd: repo.repoDir,
        },
        deps,
      );
    });
    // Prove guardrail evaluation was actually reached (not an early return): the
    // protected-path writes must have been recorded as denials.
    const opened = await openDatabase(repo.resolved.dbPath);
    if (!opened.ok) throw new Error("db open failed");
    try {
      const denied = await opened.value.execute(
        "SELECT count(*) AS n FROM tool_events WHERE status = 'denied'",
      );
      expect(Number(denied.rows[0]?.n)).toBeGreaterThan(0);
    } finally {
      await closeDatabase(opened.value);
    }
    // biome-ignore lint/suspicious/noConsole: the measured baseline is the point of this test's output.
    console.log(`[perf] PreToolUse guardrail @${ENTITY_COUNT}: ${JSON.stringify(latency)}`);
    expect(latency.p95).toBeLessThan(GUARDRAIL_CEILING_MS);
  }, 60_000);
});
