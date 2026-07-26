import type { IdPrefix, TypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database } from "../connection.js";
import { openMigratedTestDb, removeTempDir } from "../test-helpers/tmp-db.js";
import { countPendingReviewLearnings, getDigestWindowFacts } from "./digest.js";
import { insertEntity, insertRepository } from "./identity.js";
import { insertCandidate, upsertKnowledgeItem } from "./knowledge.js";
import {
  insertAgentSession,
  insertCheckpoint,
  insertSessionRun,
  insertToolEvent,
  insertTurn,
} from "./sessions.js";

/** The window under test, and instants just inside and just outside it. */
const WINDOW = { start: "2026-07-20T00:00:00.000Z", end: "2026-07-27T00:00:00.000Z" };
const INSIDE = "2026-07-22T00:00:00.000Z";
const BEFORE = "2026-07-19T23:59:59.999Z";
/** Exactly `WINDOW.end` — excluded, because the window is half-open `[start, end)`. */
const AT_END = WINDOW.end;

const REPO = "repo_00000000000000000000000000" as TypedId<"repo">;
const OTHER_REPO = "repo_11111111111111111111111111" as TypedId<"repo">;

function id<P extends IdPrefix>(prefix: P, suffix: string): TypedId<P> {
  return `${prefix}_${suffix.padEnd(26, "0")}` as TypedId<P>;
}

/** The id prefix a knowledge entity of this type carries (`ids/entity-id.ts`). */
const KNOWLEDGE_PREFIX = { rule: "rul", insight: "ins", review_learning: "rev" } as const;

async function seedRepo(db: Database, repositoryId: TypedId<"repo">, slug: string): Promise<void> {
  const inserted = await insertRepository(db, {
    id: repositoryId,
    rootFingerprint: `fp-${slug}`,
    defaultBranch: "main",
    createdAt: WINDOW.start,
    updatedAt: WINDOW.start,
  });
  if (!inserted.ok) throw new Error(`seed repository failed: ${inserted.error.message}`);
}

/** A session with one run and one turn, so tool events have somewhere to hang. */
async function seedSession(
  db: Database,
  suffix: string,
  repositoryId: TypedId<"repo">,
  runStartedAt: string,
): Promise<TypedId<"trn">> {
  const sessionId = id("ses", suffix);
  await insertEntity(db, {
    id: sessionId,
    repositoryId,
    entityType: "session",
    title: "Session",
    status: "active",
    authority: 60,
    sourceKind: "hook",
    createdAt: runStartedAt,
    updatedAt: runStartedAt,
  });
  await insertAgentSession(db, {
    id: sessionId,
    repositoryId,
    platform: "claude_code",
    platformSessionId: `plat-${suffix}`,
    startedAt: runStartedAt,
    lastSeenAt: runStartedAt,
  });
  const runId = id("run", suffix);
  await insertSessionRun(db, {
    id: runId,
    sessionId,
    startSource: "startup",
    cwdFingerprint: "fp",
    startedAt: runStartedAt,
  });
  const turnId = id("trn", suffix);
  await insertTurn(db, { id: turnId, runId, startedAt: runStartedAt });
  return turnId;
}

async function seedDenial(
  db: Database,
  suffix: string,
  turnId: TypedId<"trn">,
  occurredAt: string,
  options: { ruleId?: string; path?: string } = {},
): Promise<void> {
  const inserted = await insertToolEvent(db, {
    id: id("evt", suffix),
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

/** An approved knowledge entity, the shape the team-scope aggregates read. */
async function seedApprovedKnowledge(
  db: Database,
  suffix: string,
  type: "rule" | "insight" | "review_learning",
  approvedAt: string,
  options: { repositoryId?: TypedId<"repo">; guardrail?: boolean; title?: string } = {},
): Promise<string> {
  const entityId = id(KNOWLEDGE_PREFIX[type], suffix);
  await insertEntity(db, {
    id: entityId,
    repositoryId: options.repositoryId ?? REPO,
    entityType: type,
    title: options.title ?? `Knowledge ${suffix}`,
    summary: `Summary ${suffix}`,
    status: "approved",
    authority: 80,
    sourceKind: "canonical",
    createdAt: approvedAt,
    updatedAt: approvedAt,
  });
  const upserted = await upsertKnowledgeItem(db, {
    id: entityId,
    knowledgeType: type,
    body: "body",
    scopeJson: "{}",
    approvedAt,
    ...(options.guardrail === true
      ? { enforcement: "guardrail" as const, guardSpecJson: '{"tools":["Write"],"paths":["x/**"]}' }
      : { enforcement: "advisory" as const }),
  });
  if (!upserted.ok) throw new Error(`seed knowledge failed: ${upserted.error.message}`);
  return entityId;
}

describe("getDigestWindowFacts", () => {
  const cleanups: (() => Promise<void>)[] = [];

  async function openDb(): Promise<Database> {
    const opened = await openMigratedTestDb();
    cleanups.push(async () => {
      await closeDatabase(opened.db);
      await removeTempDir(opened.dir);
    });
    await seedRepo(opened.db, REPO, "main");
    return opened.db;
  }

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("attributes denials to the Rule that denied them", async () => {
    const db = await openDb();
    const turnId = await seedSession(db, "a", REPO, INSIDE);
    const ruleId = await seedApprovedKnowledge(db, "r1", "rule", INSIDE, {
      guardrail: true,
      title: "Never touch generated files",
    });

    await seedDenial(db, "d1", turnId, INSIDE, { ruleId, path: "packages/git/a.ts" });
    await seedDenial(db, "d2", turnId, INSIDE, { ruleId, path: "packages/git/b.ts" });

    const facts = await getDigestWindowFacts(db, REPO, WINDOW);

    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.value.denials.total).toBe(2);
    expect(facts.value.denials.byRule).toEqual([
      { ruleId, ruleTitle: "Never touch generated files", count: 2 },
    ]);
  });

  it("reports a denial with no stored attribution as unattributed rather than dropping it", async () => {
    const db = await openDb();
    const turnId = await seedSession(db, "a", REPO, INSIDE);

    await seedDenial(db, "d1", turnId, INSIDE, { path: "packages/git/a.ts" });

    const facts = await getDigestWindowFacts(db, REPO, WINDOW);

    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.value.denials.total).toBe(1);
    expect(facts.value.denials.byRule).toEqual([{ ruleId: null, ruleTitle: null, count: 1 }]);
  });

  it("resolves no title for an id whose Rule entity is gone, keeping the count", async () => {
    const db = await openDb();
    const turnId = await seedSession(db, "a", REPO, INSIDE);

    await seedDenial(db, "d1", turnId, INSIDE, { ruleId: "rul_vanished", path: "a.ts" });

    const facts = await getDigestWindowFacts(db, REPO, WINDOW);

    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.value.denials.byRule).toEqual([
      { ruleId: "rul_vanished", ruleTitle: null, count: 1 },
    ]);
  });

  it("excludes events outside the half-open window", async () => {
    const db = await openDb();
    const turnId = await seedSession(db, "a", REPO, INSIDE);

    await seedDenial(db, "d1", turnId, BEFORE, { path: "before.ts" });
    await seedDenial(db, "d2", turnId, AT_END, { path: "at-end.ts" });
    await seedDenial(db, "d3", turnId, INSIDE, { path: "inside.ts" });

    const facts = await getDigestWindowFacts(db, REPO, WINDOW);

    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.value.denials.total).toBe(1);
    expect(facts.value.denials.targets.items).toEqual([{ path: "inside.ts", count: 1 }]);
  });

  it("excludes another repository's sessions and knowledge", async () => {
    const db = await openDb();
    await seedRepo(db, OTHER_REPO, "other");
    const otherTurn = await seedSession(db, "b", OTHER_REPO, INSIDE);

    await seedDenial(db, "d1", otherTurn, INSIDE, { path: "other.ts" });
    await seedApprovedKnowledge(db, "k1", "insight", INSIDE, { repositoryId: OTHER_REPO });

    const facts = await getDigestWindowFacts(db, REPO, WINDOW);

    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.value.denials.total).toBe(0);
    expect(facts.value.sessions).toBe(0);
    expect(facts.value.approvedKnowledge.total).toBe(0);
  });

  it("counts distinct sessions that started a run in the window", async () => {
    const db = await openDb();
    await seedSession(db, "a", REPO, INSIDE);
    await seedSession(db, "b", REPO, INSIDE);
    await seedSession(db, "c", REPO, BEFORE);

    const facts = await getDigestWindowFacts(db, REPO, WINDOW);

    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.value.sessions).toBe(2);
  });

  it("breaks checkpoints down by outcome, reporting every outcome", async () => {
    const db = await openDb();
    const turnId = await seedSession(db, "a", REPO, INSIDE);
    const sessionId = id("ses", "a");

    for (const [suffix, outcome] of [
      ["c1", "completed"],
      ["c2", "completed"],
      ["c3", "blocked"],
    ] as const) {
      const chkId = id("chk", suffix);
      await insertEntity(db, {
        id: chkId,
        repositoryId: REPO,
        entityType: "checkpoint",
        title: "Checkpoint",
        status: "active",
        authority: 60,
        sourceKind: "mcp",
        createdAt: INSIDE,
        updatedAt: INSIDE,
      });
      await insertCheckpoint(db, {
        id: chkId,
        sessionId,
        turnId,
        outcome,
        objective: "o",
        summary: "s",
        implementationJson: "[]",
        validationJson: "[]",
        unresolvedJson: "[]",
        referencesJson: "[]",
        labelsJson: "[]",
        createdAt: INSIDE,
      });
    }

    const facts = await getDigestWindowFacts(db, REPO, WINDOW);

    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.value.checkpoints).toEqual({
      total: 3,
      byOutcome: { completed: 2, partial: 0, blocked: 1, no_change: 0 },
    });
  });

  it("windows team facts by approved_at and separates guardrails from review learnings", async () => {
    const db = await openDb();
    const guardrailId = await seedApprovedKnowledge(db, "g1", "rule", INSIDE, {
      guardrail: true,
      title: "Guarded rule",
    });
    const learningId = await seedApprovedKnowledge(db, "l1", "review_learning", INSIDE, {
      title: "Recurring review lesson",
    });
    await seedApprovedKnowledge(db, "a1", "rule", INSIDE, { title: "Advisory rule" });
    await seedApprovedKnowledge(db, "o1", "insight", BEFORE);

    const facts = await getDigestWindowFacts(db, REPO, WINDOW);

    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.value.approvedKnowledge.total).toBe(3);
    expect(facts.value.approvedKnowledge.byType.rule).toBe(2);
    expect(facts.value.approvedKnowledge.byType.review_learning).toBe(1);
    expect(facts.value.approvedKnowledge.byType.insight).toBe(0);
    expect(facts.value.guardrailsChanged.items.map((r) => r.id)).toEqual([guardrailId]);
    expect(facts.value.promotedReviewLearnings.items.map((r) => r.id)).toEqual([learningId]);
  });

  it("excludes a tombstoned document whose approved_at is still in the window", async () => {
    const db = await openDb();
    const entityId = await seedApprovedKnowledge(db, "t1", "rule", INSIDE);
    await db.execute({
      sql: "UPDATE entities SET status = 'tombstoned' WHERE id = ?",
      args: [entityId],
    });

    const facts = await getDigestWindowFacts(db, REPO, WINDOW);

    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.value.approvedKnowledge.total).toBe(0);
  });

  it("flags a truncated list instead of silently returning only the cap", async () => {
    const db = await openDb();
    const turnId = await seedSession(db, "a", REPO, INSIDE);
    for (let i = 0; i < 25; i++) {
      await seedDenial(db, `d${String(i).padStart(3, "0")}`, turnId, INSIDE, {
        path: `packages/p${String(i).padStart(3, "0")}/a.ts`,
      });
    }

    const facts = await getDigestWindowFacts(db, REPO, WINDOW);

    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.value.denials.total).toBe(25);
    expect(facts.value.denials.targets.items).toHaveLength(20);
    expect(facts.value.denials.targets.truncated).toBe(true);
  });

  it("returns zeroed facts for a period with no activity", async () => {
    const db = await openDb();

    const facts = await getDigestWindowFacts(db, REPO, WINDOW);

    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.value.denials).toEqual({
      total: 0,
      byRule: [],
      targets: { items: [], truncated: false },
    });
    expect(facts.value.sessions).toBe(0);
    expect(facts.value.guardrailsChanged).toEqual({ items: [], truncated: false });
  });
});

describe("countPendingReviewLearnings", () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("counts only pending review_learning candidates of this repository", async () => {
    const opened = await openMigratedTestDb();
    cleanups.push(async () => {
      await closeDatabase(opened.db);
      await removeTempDir(opened.dir);
    });
    const db = opened.db;
    await seedRepo(db, REPO, "main");
    await seedRepo(db, OTHER_REPO, "other");

    for (const [suffix, type, repositoryId] of [
      ["c1", "review_learning", REPO],
      ["c2", "review_learning", REPO],
      ["c3", "insight", REPO],
      ["c4", "review_learning", OTHER_REPO],
    ] as const) {
      await insertCandidate(db, {
        id: id("cand", suffix),
        repositoryId,
        candidateType: type,
        payloadJson: "{}",
        revisionToken: `rev-${suffix}`,
        createdAt: INSIDE,
      });
    }
    await db.execute({
      sql: "UPDATE candidates SET status = 'approved' WHERE id = ?",
      args: [id("cand", "c2")],
    });

    const count = await countPendingReviewLearnings(db, REPO);

    expect(count.ok).toBe(true);
    if (!count.ok) return;
    expect(count.value).toBe(1);
  });
});
