import type { IdPrefix, TypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database } from "../connection.js";
import { openMigratedTestDb, removeTempDir } from "../test-helpers/tmp-db.js";
import { countPendingReviewLearnings, getDenialFacts } from "./denials.js";
import { insertEntity, insertRepository } from "./identity.js";
import { insertCandidate, upsertKnowledgeItem } from "./knowledge.js";
import { insertAgentSession, insertSessionRun, insertToolEvent, insertTurn } from "./sessions.js";

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
    createdAt: WINDOW.start,
    updatedAt: WINDOW.start,
  });
  await insertAgentSession(db, {
    id: sessionId,
    repositoryId,
    platform: "claude_code",
    platformSessionId: `plat-${suffix}`,
    startedAt: WINDOW.start,
    lastSeenAt: WINDOW.start,
  });
  const runId = id("run", suffix);
  await insertSessionRun(db, {
    id: runId,
    sessionId,
    startSource: "startup",
    cwdFingerprint: "fp",
    startedAt: WINDOW.start,
  });
  const turnId = id("trn", suffix);
  await insertTurn(db, { id: turnId, runId, startedAt: WINDOW.start });
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

/** An approved Rule, so a denial has something to be attributed to. */
async function seedRule(db: Database, suffix: string, title: string): Promise<string> {
  const entityId = id("rul", suffix);
  await insertEntity(db, {
    id: entityId,
    repositoryId: REPO,
    entityType: "rule",
    title,
    status: "approved",
    authority: 100,
    sourceKind: "canonical",
    createdAt: WINDOW.start,
    updatedAt: WINDOW.start,
  });
  const upserted = await upsertKnowledgeItem(db, {
    id: entityId,
    knowledgeType: "rule",
    body: "body",
    scopeJson: "{}",
    approvedAt: WINDOW.start,
    enforcement: "guardrail",
    guardSpecJson: '{"tools":["Write"],"paths":["x/**"]}',
  });
  if (!upserted.ok) throw new Error(`seed rule failed: ${upserted.error.message}`);
  return entityId;
}

describe("getDenialFacts", () => {
  let db: Database | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    if (db) await closeDatabase(db);
    if (dir) await removeTempDir(dir);
    db = undefined;
    dir = undefined;
  });

  async function open(): Promise<Database> {
    const opened = await openMigratedTestDb();
    db = opened.db;
    dir = opened.dir;
    await seedRepo(opened.db, REPO, "main");
    return opened.db;
  }

  it("counts only this repository's denials inside the half-open window", async () => {
    const database = await open();
    await seedRepo(database, OTHER_REPO, "other");
    const turn = await seedSession(database, "a", REPO);
    const otherTurn = await seedSession(database, "b", OTHER_REPO);

    await seedDenial(database, "in", turn, INSIDE, { path: "packages/git/run.ts" });
    // The window is `[start, end)`: the start instant counts, the end instant does not.
    await seedDenial(database, "atstart", turn, WINDOW.start, { path: "packages/git/a.ts" });
    await seedDenial(database, "before", turn, BEFORE, { path: "packages/git/b.ts" });
    await seedDenial(database, "atend", turn, AT_END, { path: "packages/git/c.ts" });
    await seedDenial(database, "other", otherTurn, INSIDE, { path: "packages/git/d.ts" });

    const facts = await getDenialFacts(database, REPO, WINDOW);

    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.value.total).toBe(2);
    expect(facts.value.targets.map((t) => t.path).sort()).toEqual([
      "packages/git/a.ts",
      "packages/git/run.ts",
    ]);
  });

  it("attributes a denial to the Rule that produced it", async () => {
    const database = await open();
    const turn = await seedSession(database, "a", REPO);
    const ruleId = await seedRule(database, "r1", "No writes outside x/");
    await seedDenial(database, "1", turn, INSIDE, { ruleId, path: "x/a.ts" });
    await seedDenial(database, "2", turn, INSIDE, { ruleId, path: "x/b.ts" });

    const facts = await getDenialFacts(database, REPO, WINDOW);

    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    expect(facts.value.byRule).toEqual([{ ruleId, ruleTitle: "No writes outside x/", count: 2 }]);
  });

  it("reports a denial with no stored attribution as unattributed rather than dropping it", async () => {
    const database = await open();
    const turn = await seedSession(database, "a", REPO);
    await seedDenial(database, "1", turn, INSIDE, { path: "x/a.ts" });

    const facts = await getDenialFacts(database, REPO, WINDOW);

    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    // The count is right and the attribution is honestly unknown — losing the row
    // would understate how often the agent was stopped.
    expect(facts.value.byRule).toEqual([{ ruleId: null, ruleTitle: null, count: 1 }]);
    expect(facts.value.total).toBe(1);
  });

  it("degrades to unattributed denials on a database from before the attribution column", async () => {
    const database = await open();
    const turn = await seedSession(database, "a", REPO);
    await seedDenial(database, "1", turn, INSIDE, { path: "x/a.ts" });
    // The hook, the MCP server and the dashboard all open the database without
    // migrating, so between a package upgrade and the next sync these reads run
    // against the older schema. Dropping the column reproduces exactly that.
    await database.execute("DROP INDEX idx_tool_events_denied");
    await database.execute("ALTER TABLE tool_events DROP COLUMN denied_by_rule_id");

    const facts = await getDenialFacts(database, REPO, WINDOW);

    expect(facts.ok, "a pre-005 schema must not fail the read").toBe(true);
    if (!facts.ok) return;
    expect(facts.value.byRule).toEqual([{ ruleId: null, ruleTitle: null, count: 1 }]);
  });
});

describe("countPendingReviewLearnings", () => {
  let db: Database | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    if (db) await closeDatabase(db);
    if (dir) await removeTempDir(dir);
    db = undefined;
    dir = undefined;
  });

  it("counts only pending review_learning candidates for this repository", async () => {
    const opened = await openMigratedTestDb();
    db = opened.db;
    dir = opened.dir;
    await seedRepo(opened.db, REPO, "main");
    await seedRepo(opened.db, OTHER_REPO, "other");

    for (const [suffix, repositoryId, candidateType] of [
      ["a", REPO, "review_learning"],
      ["b", REPO, "review_learning"],
      ["c", REPO, "rule"],
      ["d", OTHER_REPO, "review_learning"],
    ] as const) {
      const inserted = await insertCandidate(opened.db, {
        id: id("cand", suffix),
        repositoryId,
        candidateType,
        payloadJson: "{}",
        revisionToken: `tok-${suffix}`,
        createdAt: INSIDE,
      });
      if (!inserted.ok) throw new Error(`seed candidate failed: ${inserted.error.message}`);
    }
    // `insertCandidate` always writes `pending`; a human's decision is what moves it
    // on, so the already-decided case is set up directly.
    await opened.db.execute({
      sql: "UPDATE candidates SET status = 'approved' WHERE id = ?",
      args: [id("cand", "b")],
    });

    const count = await countPendingReviewLearnings(opened.db, REPO);

    expect(count.ok).toBe(true);
    if (!count.ok) return;
    expect(count.value).toBe(1);
  });
});
