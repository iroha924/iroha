import { CryptoRandomSource, FixedClock, type TypedId } from "@iroha/domain";
import {
  closeDatabase,
  type Database,
  insertEntity,
  insertToolEvent,
  openDatabase,
  upsertKnowledgeItem,
  upsertLocalSetting,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { type McpTestRepo, seedSessionWithToken, setupMcpRepo } from "../test-helpers/mcp-repo.js";
import { removeTempDir } from "../test-helpers/tmp-repo.js";
import { DIGEST_PERIOD_SETTING_KEY, getDigest } from "./digest.js";

/** Inside the ISO week starting Monday 2026-07-20, in UTC. */
const NOW = "2026-07-23T12:00:00.000Z";
const IN_WINDOW = "2026-07-22T09:00:00.000Z";
const IN_PRIOR_WINDOW = "2026-07-15T09:00:00.000Z";

const clock = new FixedClock(new Date(NOW));
const random = new CryptoRandomSource();

const ORIGINAL_TZ = process.env.TZ;

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
  options: { ruleId?: string; path?: string } = {},
): Promise<void> {
  const inserted = await insertToolEvent(db, {
    id: `evt_${suffix.padEnd(26, "0")}` as TypedId<"evt">,
    turnId,
    toolName: "Write",
    phase: "denied",
    status: "denied",
    targetKind: "file",
    occurredAt,
    ...(options.path === undefined ? {} : { targetSummary: options.path }),
    ...(options.ruleId === undefined ? {} : { deniedByRuleId: options.ruleId }),
  });
  if (!inserted.ok) throw new Error(`seed denial failed: ${inserted.error.message}`);
}

async function seedGuardrail(
  db: Database,
  repositoryId: TypedId<"repo">,
  suffix: string,
  guardSpecJson: string,
  approvedAt: string,
): Promise<string> {
  const id = `rul_${suffix.padEnd(26, "0")}`;
  await insertEntity(db, {
    id,
    repositoryId,
    entityType: "rule",
    title: `Rule ${suffix}`,
    summary: `Summary ${suffix}`,
    status: "approved",
    authority: 80,
    sourceKind: "canonical",
    createdAt: approvedAt,
    updatedAt: approvedAt,
  });
  const upserted = await upsertKnowledgeItem(db, {
    id,
    knowledgeType: "rule",
    body: "body",
    scopeJson: "{}",
    enforcement: "guardrail",
    guardSpecJson,
    approvedAt,
  });
  if (!upserted.ok) throw new Error(`seed guardrail failed: ${upserted.error.message}`);
  return id;
}

/**
 * A session/run/turn chain for tool events to hang off. The run's `started_at`
 * is the fixed clock's `NOW`, which is inside the default window — so the session
 * count reflects it.
 */
async function seedTurn(repo: McpTestRepo): Promise<TypedId<"trn">> {
  const db = await openRepoDb(repo);
  try {
    const seeded = await seedSessionWithToken(db, repo, clock, random);
    return seeded.turnId;
  } finally {
    await closeDatabase(db);
  }
}

describe("getDigest", () => {
  let repo: McpTestRepo | undefined;

  afterEach(async () => {
    if (repo) {
      await removeTempDir(repo.repoDir);
      repo = undefined;
    }
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
  });

  it("defaults to the calendar week containing now", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);

    const digest = await getDigest({ cwd: repo.repoDir, clock, random });

    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    expect(digest.value.period).toMatchObject({
      unit: "week",
      key: "2026-07-20",
      start: "2026-07-20T00:00:00.000Z",
      end: "2026-07-27T00:00:00.000Z",
      offset: 0,
    });
    expect(digest.value.hasNewer).toBe(false);
  });

  it("honours the stored window preference", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);
    const db = await openRepoDb(repo);
    try {
      await upsertLocalSetting(db, {
        repositoryId: repo.repositoryId,
        key: DIGEST_PERIOD_SETTING_KEY,
        valueJson: JSON.stringify({ unit: "month" }),
        updatedAt: NOW,
      });
    } finally {
      await closeDatabase(db);
    }

    const digest = await getDigest({ cwd: repo.repoDir, clock, random });

    expect(digest.ok && digest.value.period.unit).toBe("month");
    expect(digest.ok && digest.value.period.key).toBe("2026-07");
  });

  it("falls back to the default window rather than failing on a corrupt preference", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);
    const db = await openRepoDb(repo);
    try {
      await upsertLocalSetting(db, {
        repositoryId: repo.repositoryId,
        key: DIGEST_PERIOD_SETTING_KEY,
        valueJson: JSON.stringify({ unit: "fortnight" }),
        updatedAt: NOW,
      });
    } finally {
      await closeDatabase(db);
    }

    const digest = await getDigest({ cwd: repo.repoDir, clock, random });

    expect(digest.ok).toBe(true);
    expect(digest.ok && digest.value.period.unit).toBe("week");
  });

  it("marks a back issue as having a newer one and windows to that period", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);

    const digest = await getDigest({ cwd: repo.repoDir, clock, random, offset: 1 });

    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    expect(digest.value.period.key).toBe("2026-07-13");
    expect(digest.value.hasNewer).toBe(true);
  });

  it("compares denials against the previous period", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);
    const turnId = await seedTurn(repo);
    const db = await openRepoDb(repo);
    try {
      const ruleId = await seedGuardrail(
        db,
        repo.repositoryId,
        "r1",
        '{"tools":["Write"],"paths":["packages/git/**"]}',
        IN_WINDOW,
      );
      await seedDenial(db, "d1", turnId, IN_WINDOW, { ruleId, path: "packages/git/a.ts" });
      await seedDenial(db, "d2", turnId, IN_WINDOW, { ruleId, path: "packages/git/b.ts" });
      await seedDenial(db, "d3", turnId, IN_PRIOR_WINDOW, { ruleId, path: "packages/git/c.ts" });
    } finally {
      await closeDatabase(db);
    }

    const digest = await getDigest({ cwd: repo.repoDir, clock, random });

    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    expect(digest.value.local.denials.value).toBe(2);
    expect(digest.value.local.denials.priorValue).toBe(1);
  });

  it("clusters denied paths by their leading segments", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);
    const turnId = await seedTurn(repo);
    const db = await openRepoDb(repo);
    try {
      await seedDenial(db, "d1", turnId, IN_WINDOW, { path: "packages/git/a.ts" });
      await seedDenial(db, "d2", turnId, IN_WINDOW, { path: "packages/git/b.ts" });
      await seedDenial(db, "d3", turnId, IN_WINDOW, { path: "packages/git/b.ts" });
      // A single denial elsewhere is not a cluster.
      await seedDenial(db, "d4", turnId, IN_WINDOW, { path: "apps/dashboard/x.tsx" });
    } finally {
      await closeDatabase(db);
    }

    const digest = await getDigest({ cwd: repo.repoDir, clock, random });

    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    expect(digest.value.local.correlations).toEqual([
      { kind: "denial_cluster", paths: ["packages/git/b.ts", "packages/git/a.ts"], count: 3 },
    ]);
  });

  it("classifies the approved Guardrail set so an unenforceable rule is visible", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);
    const db = await openRepoDb(repo);
    try {
      await seedGuardrail(
        db,
        repo.repositoryId,
        "g1",
        '{"tools":["Write"],"paths":["packages/git/**"]}',
        IN_WINDOW,
      );
      // Parses, but names no paths — the hook cannot enforce it.
      await seedGuardrail(db, repo.repositoryId, "g2", '{"tools":["Bash"],"paths":[]}', IN_WINDOW);
      // Malformed — skipped outright by the hook.
      await seedGuardrail(db, repo.repositoryId, "g3", '{"tools":[]}', IN_WINDOW);
    } finally {
      await closeDatabase(db);
    }

    const digest = await getDigest({ cwd: repo.repoDir, clock, random });

    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    expect(digest.value.team.rulesetAdequacy).toEqual({
      enforceable: 1,
      not_hook_enforceable: 1,
      invalid: 1,
    });
  });

  it("issues a fact for every number, with ids stable across reads", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);
    const turnId = await seedTurn(repo);
    const db = await openRepoDb(repo);
    let ruleId = "";
    try {
      ruleId = await seedGuardrail(
        db,
        repo.repositoryId,
        "r1",
        '{"tools":["Write"],"paths":["packages/git/**"]}',
        IN_WINDOW,
      );
      await seedDenial(db, "d1", turnId, IN_WINDOW, { ruleId, path: "packages/git/a.ts" });
    } finally {
      await closeDatabase(db);
    }

    const first = await getDigest({ cwd: repo.repoDir, clock, random });
    const second = await getDigest({ cwd: repo.repoDir, clock, random });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const ids = first.value.facts.map((fact) => fact.id);
    expect(ids).toEqual(second.value.facts.map((fact) => fact.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("local.denials.total");
    expect(ids).toContain(`local.denials.byRule.${ruleId}`);
    expect(ids).toContain("team.rulesetAdequacy.not_hook_enforceable");
    expect(first.value.facts.find((fact) => fact.id === "local.denials.total")?.value).toBe(1);
  });

  it("carries no actor, author, or session-owner field anywhere in the payload", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);
    await seedTurn(repo);

    const digest = await getDigest({ cwd: repo.repoDir, clock, random });

    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    // Anti-surveillance is structural: the agent that composes prose receives
    // this payload verbatim, so per-person narration must be impossible because
    // the person data never arrives — not merely discouraged by a prompt.
    const serialized = JSON.stringify(digest.value);
    for (const forbidden of ["actor", "author", "email", "owner", "user"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("has no prose until an issue is composed", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);

    const digest = await getDigest({ cwd: repo.repoDir, clock, random });

    expect(digest.ok && digest.value.prose).toBeNull();
  });

  it("renders a period with no activity as zeros rather than failing", async () => {
    process.env.TZ = "UTC";
    repo = await setupMcpRepo(random);

    const digest = await getDigest({ cwd: repo.repoDir, clock, random, offset: 40 });

    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    expect(digest.value.local.denials.value).toBe(0);
    expect(digest.value.local.correlations).toEqual([]);
    expect(digest.value.team.knowledge.value).toBe(0);
    expect(digest.value.facts.length).toBeGreaterThan(0);
  });
});
