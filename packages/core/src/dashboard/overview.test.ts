import { CryptoRandomSource, FixedClock, type TypedId } from "@iroha/domain";
import {
  closeDatabase,
  type Database,
  insertEntity,
  insertToolEvent,
  openDatabase,
  upsertKnowledgeItem,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { type McpTestRepo, seedSessionWithToken, setupMcpRepo } from "../test-helpers/mcp-repo.js";
import { removeTempDir } from "../test-helpers/tmp-repo.js";
import { getOverview } from "./overview.js";

const NOW = "2026-07-23T12:00:00.000Z";
/** Comfortably inside the 30-day denial window. */
const RECENT = "2026-07-22T09:00:00.000Z";
/** Older than 30 days before NOW, so outside it. */
const OLD = "2026-06-01T09:00:00.000Z";

const clock = new FixedClock(new Date(NOW));
const random = new CryptoRandomSource();

async function openRepoDb(repo: McpTestRepo): Promise<Database> {
  const opened = await openDatabase(repo.dbPath);
  if (!opened.ok) throw new Error(`db open failed: ${opened.error.message}`);
  return opened.value;
}

/** A denied tool event on an existing turn, as `handleToolStarted` writes it. */
async function seedDenial(
  db: Database,
  suffix: string,
  turnId: TypedId<"trn">,
  occurredAt: string,
  path: string,
): Promise<void> {
  const inserted = await insertToolEvent(db, {
    id: `evt_${suffix.padEnd(26, "0")}` as TypedId<"evt">,
    turnId,
    toolName: "Write",
    phase: "denied",
    status: "denied",
    targetKind: "file",
    targetSummary: path,
    occurredAt,
  });
  if (!inserted.ok) throw new Error(`seed denial failed: ${inserted.error.message}`);
}

/** An approved Guardrail whose spec decides which adequacy bucket it lands in. */
async function seedGuardrail(
  db: Database,
  repositoryId: TypedId<"repo">,
  suffix: string,
  guardSpecJson: string,
): Promise<void> {
  const entityId = `rul_${suffix.padEnd(26, "0")}` as TypedId<"rul">;
  await insertEntity(db, {
    id: entityId,
    repositoryId,
    entityType: "rule",
    title: `Rule ${suffix}`,
    status: "approved",
    authority: 100,
    sourceKind: "canonical",
    createdAt: RECENT,
    updatedAt: RECENT,
  });
  const upserted = await upsertKnowledgeItem(db, {
    id: entityId,
    knowledgeType: "rule",
    body: "body",
    scopeJson: "{}",
    approvedAt: RECENT,
    enforcement: "guardrail",
    guardSpecJson,
  });
  if (!upserted.ok) throw new Error(`seed guardrail failed: ${upserted.error.message}`);
}

describe("getOverview", () => {
  let repo: McpTestRepo | undefined;

  afterEach(async () => {
    if (repo) {
      await removeTempDir(repo.repoDir);
      repo = undefined;
    }
  });

  it("reports no activity volumes, so nothing on the page is a number to skip", async () => {
    repo = await setupMcpRepo(random);

    const overview = await getOverview({ cwd: repo.repoDir, clock, random });

    expect(overview.ok).toBe(true);
    if (!overview.ok) return;
    // The page's own contract (database.md §16): a fact earns a place only if a
    // reader can act on it. A session or checkpoint count is neither.
    const keys = Object.keys(overview.value);
    expect(keys).not.toContain("sessions");
    expect(keys).not.toContain("recentSessions");
    expect(keys).not.toContain("checkpoints");
  });

  it("windows denials to the last 30 days and clusters them by leading path segments", async () => {
    repo = await setupMcpRepo(random);
    const db = await openRepoDb(repo);
    try {
      const seeded = await seedSessionWithToken(db, repo, clock, random);
      // Two in one directory make a cluster; one elsewhere does not reach
      // MIN_CLUSTER_COUNT and must still be counted in the total.
      await seedDenial(db, "a", seeded.turnId, RECENT, "packages/git/run.ts");
      await seedDenial(db, "b", seeded.turnId, RECENT, "packages/git/paths.ts");
      await seedDenial(db, "c", seeded.turnId, RECENT, "apps/dashboard/App.tsx");
      await seedDenial(db, "d", seeded.turnId, OLD, "packages/git/old.ts");
    } finally {
      await closeDatabase(db);
    }

    const overview = await getOverview({ cwd: repo.repoDir, clock, random });

    expect(overview.ok).toBe(true);
    if (!overview.ok) return;
    expect(overview.value.denials.windowDays).toBe(30);
    // The denial older than the window is excluded from the total, not just the clusters.
    expect(overview.value.denials.total).toBe(3);
    expect(overview.value.denials.clusters.items).toEqual([
      {
        key: "packages/git",
        paths: ["packages/git/paths.ts", "packages/git/run.ts"],
        count: 2,
      },
    ]);
    expect(overview.value.denials.clusters.total).toBe(1);
    expect(overview.value.denials.clusters.truncated).toBe(false);
  });

  it("classifies the approved Guardrail set into the three adequacy buckets", async () => {
    repo = await setupMcpRepo(random);
    const db = await openRepoDb(repo);
    try {
      await seedGuardrail(db, repo.repositoryId, "ok", '{"tools":["Write"],"paths":["x/**"]}');
      // No paths: nothing for the hook to match on, so CI is the only enforcement layer.
      await seedGuardrail(db, repo.repositoryId, "nopath", '{"tools":["Write"]}');
      // Valid JSON (the column CHECKs that) but not a valid guard spec, which is
      // the shape a malformed rule actually reaches the database in.
      await seedGuardrail(db, repo.repositoryId, "bad", '{"paths":"x/**"}');
    } finally {
      await closeDatabase(db);
    }

    const overview = await getOverview({ cwd: repo.repoDir, clock, random });

    expect(overview.ok).toBe(true);
    if (!overview.ok) return;
    expect(overview.value.rulesetAdequacy).toEqual({
      enforceable: 1,
      not_hook_enforceable: 1,
      invalid: 1,
    });
  });
});
