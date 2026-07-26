import type { TypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database } from "../connection.js";
import { openMigratedTestDb, removeTempDir } from "../test-helpers/tmp-db.js";
import { insertEntity, insertRepository, upsertCanonicalDocument } from "./identity.js";
import { insertCandidate } from "./knowledge.js";
import { insertEventLog } from "./operations.js";
import {
  countLocalEventData,
  listPrunableSessions,
  pruneEventLog,
  pruneSession,
} from "./retention.js";
import {
  closeSessionRun,
  getAgentSessionById,
  getCheckpointById,
  insertAgentSession,
  insertCheckpoint,
  insertSessionRun,
  insertToolEvent,
  insertTurn,
} from "./sessions.js";

const OLD = "2026-01-01T00:00:00.000Z";
const CUTOFF = "2026-06-01T00:00:00.000Z";
const RECENT = "2026-07-01T00:00:00.000Z";

const REPO = "repo_00000000000000000000000000" as TypedId<"repo">;

function pad(suffix: string): string {
  return suffix.padEnd(26, "0");
}
function sesId(s: string): TypedId<"ses"> {
  return `ses_${pad(s)}` as TypedId<"ses">;
}
function runIdOf(s: string): TypedId<"run"> {
  return `run_${pad(s)}` as TypedId<"run">;
}
function trnId(s: string): TypedId<"trn"> {
  return `trn_${pad(s)}` as TypedId<"trn">;
}
function evtId(s: string): TypedId<"evt"> {
  return `evt_${pad(s)}` as TypedId<"evt">;
}
function chkId(s: string): TypedId<"chk"> {
  return `chk_${pad(s)}` as TypedId<"chk">;
}
function candId(s: string): TypedId<"cand"> {
  return `cand_${pad(s)}` as TypedId<"cand">;
}
function logId(s: string): TypedId<"log"> {
  return `log_${pad(s)}` as TypedId<"log">;
}

/** A session with a full run/turn/tool-event chain, last seen at `lastSeenAt`. */
async function seedSession(
  db: Database,
  suffix: string,
  lastSeenAt: string,
): Promise<{ sessionId: TypedId<"ses">; turnId: TypedId<"trn"> }> {
  const sessionId = sesId(suffix);
  await insertEntity(db, {
    id: sessionId,
    repositoryId: REPO,
    entityType: "session",
    title: "Session",
    status: "active",
    authority: 60,
    sourceKind: "hook",
    createdAt: OLD,
    updatedAt: lastSeenAt,
  });
  await insertAgentSession(db, {
    id: sessionId,
    repositoryId: REPO,
    platform: "claude_code",
    platformSessionId: `plat-${suffix}`,
    startedAt: OLD,
    lastSeenAt,
  });
  const runId = runIdOf(suffix);
  await insertSessionRun(db, {
    id: runId,
    sessionId,
    startSource: "startup",
    cwdFingerprint: "fp",
    startedAt: OLD,
  });
  const closed = await closeSessionRun(db, runId, {
    from: "active",
    to: "completed",
    endedAt: OLD,
    endReason: "normal",
  });
  if (!closed.ok) {
    throw new Error(`seed run close failed: ${closed.error.message}`);
  }
  const turnId = trnId(suffix);
  await insertTurn(db, { id: turnId, runId, startedAt: OLD });
  await insertToolEvent(db, {
    id: evtId(suffix),
    turnId,
    toolName: "Read",
    phase: "post",
    status: "succeeded",
    occurredAt: OLD,
  });
  return { sessionId, turnId };
}

async function seedCheckpoint(
  db: Database,
  suffix: string,
  sessionId: TypedId<"ses">,
): Promise<TypedId<"chk">> {
  const checkpointId = chkId(suffix);
  await insertEntity(db, {
    id: checkpointId,
    repositoryId: REPO,
    entityType: "checkpoint",
    title: "Checkpoint",
    status: "draft",
    authority: 40,
    sourceKind: "mcp",
    createdAt: OLD,
    updatedAt: OLD,
  });
  await insertCheckpoint(db, {
    id: checkpointId,
    sessionId,
    outcome: "completed",
    objective: "o",
    summary: "s",
    implementationJson: "[]",
    validationJson: "[]",
    unresolvedJson: "[]",
    referencesJson: "[]",
    labelsJson: "[]",
    createdAt: OLD,
  });
  return checkpointId;
}

async function seedCanonicalDocument(db: Database, entityId: string, path: string): Promise<void> {
  const result = await upsertCanonicalDocument(db, {
    entityId,
    canonicalPath: path,
    revision: 1,
    frontmatterJson: "{}",
    body: "body",
    fileHash: `sha256:${"a".repeat(64)}`,
    approvedAt: OLD,
    importedAt: OLD,
  });
  if (!result.ok) {
    throw new Error(`seed canonical document failed: ${result.error.message}`);
  }
}

/** The whole sweep: list candidates, delete each, then prune diagnostics rows. */
async function pruneAll(
  db: Database,
  cutoff: string,
): Promise<{ sessions: number; checkpoints: number; eventLogRows: number }> {
  const candidates = await listPrunableSessions(db, REPO, cutoff);
  if (!candidates.ok) {
    throw new Error(`list failed: ${candidates.error.message}`);
  }
  let sessions = 0;
  let checkpoints = 0;
  for (const id of candidates.value) {
    const result = await pruneSession(db, REPO, cutoff, id, {
      key: "retention.local_events",
      expectedValueJson: null,
    });
    if (!result.ok) {
      throw new Error(`prune failed: ${result.error.message}`);
    }
    if (result.value !== null) {
      sessions += 1;
      checkpoints += result.value.checkpoints;
    }
  }
  const events = await pruneEventLog(db, REPO, cutoff);
  if (!events.ok) {
    throw new Error(`event log prune failed: ${events.error.message}`);
  }
  return { sessions, checkpoints, eventLogRows: events.value };
}

describe("retention pruning", () => {
  let tempDir: string | undefined;
  let db: Database | undefined;

  afterEach(async () => {
    if (db) {
      await closeDatabase(db);
      db = undefined;
    }
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  async function open(): Promise<Database> {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const inserted = await insertRepository(db, {
      id: REPO,
      rootFingerprint: "fp-retention",
      createdAt: OLD,
      updatedAt: OLD,
    });
    if (!inserted.ok) {
      throw new Error(`seed repository failed: ${inserted.error.message}`);
    }
    return db;
  }

  it("deletes an aged session with its runs, turns, and tool events", async () => {
    const database = await open();
    const { sessionId } = await seedSession(database, "aged", OLD);

    const pruned = await pruneAll(database, CUTOFF);
    expect(pruned.sessions).toBe(1);

    expect((await getAgentSessionById(database, sessionId)).ok).toBe(true);
    const gone = await getAgentSessionById(database, sessionId);
    expect(gone.ok && gone.value).toBeNull();
    // The cascade must reach the whole chain, and the session's own entity row
    // must go with it rather than being orphaned.
    const counts = await countLocalEventData(database, REPO, null);
    expect(counts.ok).toBe(true);
    if (!counts.ok) return;
    expect(counts.value).toMatchObject({ sessions: 0, runs: 0, turns: 0, toolEvents: 0 });
    const entities = await database.execute({
      sql: "SELECT COUNT(*) AS n FROM entities WHERE id = ?",
      args: [sessionId],
    });
    expect(Number(entities.rows[0]?.n)).toBe(0);
  });

  it("declines to delete when the policy no longer matches the guard", async () => {
    const database = await open();
    const { sessionId } = await seedSession(database, "guard", OLD);
    await database.execute({
      sql: `INSERT INTO local_settings (repository_id, key, value_json, updated_at)
            VALUES (?, 'retention.local_events', ?, ?)`,
      args: [REPO, JSON.stringify({ days: 90 }), OLD],
    });

    // The sweep planned against an absent row; the stored policy has since become
    // a 90-day window. The delete must decline rather than act on the superseded
    // plan — the guard is read inside the same transaction as the eligibility
    // check, so a change on another connection cannot slip between them.
    const declined = await pruneSession(database, REPO, CUTOFF, sessionId, {
      key: "retention.local_events",
      expectedValueJson: null,
    });
    expect(declined.ok && declined.value).toBeNull();
    const kept = await getAgentSessionById(database, sessionId);
    expect(kept.ok && kept.value).not.toBeNull();

    // With a guard matching what is stored, the same session is deleted.
    const accepted = await pruneSession(database, REPO, CUTOFF, sessionId, {
      key: "retention.local_events",
      expectedValueJson: JSON.stringify({ days: 90 }),
    });
    expect(accepted.ok && accepted.value).not.toBeNull();
  });

  it("keeps an aged parent while a child session still references it", async () => {
    const database = await open();
    const { sessionId: parentId } = await seedSession(database, "parent", OLD);
    const { sessionId: childId } = await seedSession(database, "child", RECENT);
    // `agent_sessions.parent_session_id` is ON DELETE SET NULL, so pruning the
    // parent would leave the child alive but permanently unparented.
    await database.execute({
      sql: "UPDATE agent_sessions SET parent_session_id = ? WHERE id = ?",
      args: [parentId, childId],
    });

    const pruned = await pruneAll(database, CUTOFF);
    expect(pruned.sessions).toBe(0);
    const rows = await database.execute({
      sql: "SELECT parent_session_id FROM agent_sessions WHERE id = ?",
      args: [childId],
    });
    expect(rows.rows[0]?.parent_session_id).toBe(parentId);
  });

  it("prunes a diagnostics backlog larger than one batch", async () => {
    const database = await open();
    // A single unbounded DELETE would hold the writer lock for the whole backlog,
    // which `hooks.md` §10 measures as long enough to get a PreToolUse hook killed
    // and lose its Guardrail deny. The batch bound is 500, so 1200 rows exercise
    // the loop across several statements.
    const values: string[] = [];
    const args: string[] = [];
    for (let i = 0; i < 1200; i += 1) {
      values.push("(?, ?, 'api.request', 'failure', ?)");
      // Zero-padded: `pad` right-fills with "0", so `b1` and `b10` would collide.
      args.push(logId(`b${String(i).padStart(4, "0")}`), REPO, OLD);
    }
    await database.execute({
      sql: `INSERT INTO event_log (id, repository_id, event_type, outcome, occurred_at)
            VALUES ${values.join(",")}`,
      args,
    });

    const pruned = await pruneEventLog(database, REPO, CUTOFF);
    expect(pruned.ok && pruned.value).toBe(1200);
    const counts = await countLocalEventData(database, REPO, null);
    expect(counts.ok && counts.value.eventLogRows).toBe(0);
  });

  it("keeps a session still inside the window", async () => {
    const database = await open();
    await seedSession(database, "recent", RECENT);

    const pruned = await pruneAll(database, CUTOFF);
    expect(pruned.sessions).toBe(0);
  });

  it("keeps an aged session whose summary is approved canonical", async () => {
    const database = await open();
    const { sessionId } = await seedSession(database, "canon", OLD);
    await seedCanonicalDocument(database, sessionId, "sessions/2026/canon.md");

    const pruned = await pruneAll(database, CUTOFF);
    expect(pruned.sessions).toBe(0);
    // `canonical_documents.entity_id` cascades from `entities`, so pruning this
    // session would delete the index row for Git-tracked team knowledge.
    const doc = await database.execute({
      sql: "SELECT COUNT(*) AS n FROM canonical_documents WHERE entity_id = ?",
      args: [sessionId],
    });
    expect(Number(doc.rows[0]?.n)).toBe(1);
  });

  it("keeps an aged session whose checkpoint is approved canonical", async () => {
    const database = await open();
    const { sessionId } = await seedSession(database, "chkcanon", OLD);
    const checkpointId = await seedCheckpoint(database, "chkcanon", sessionId);
    await seedCanonicalDocument(database, checkpointId, "checkpoints/2026/c.md");

    const pruned = await pruneAll(database, CUTOFF);
    expect(pruned.sessions).toBe(0);
    const kept = await getCheckpointById(database, checkpointId);
    expect(kept.ok && kept.value).not.toBeNull();
  });

  it("keeps an aged session that still has a pending candidate", async () => {
    const database = await open();
    const { sessionId } = await seedSession(database, "pending", OLD);
    const candidate = await insertCandidate(database, {
      id: candId("pending"),
      repositoryId: REPO,
      candidateType: "session_summary",
      payloadJson: "{}",
      sourceSessionId: sessionId,
      revisionToken: "tok",
      createdAt: OLD,
    });
    expect(candidate.ok).toBe(true);

    const pruned = await pruneAll(database, CUTOFF);
    expect(pruned.sessions).toBe(0);
    // `candidates.source_session_id` is ON DELETE SET NULL, so pruning would not
    // delete the candidate — it would silently strip its provenance.
    const rows = await database.execute({
      sql: "SELECT source_session_id FROM candidates WHERE id = ?",
      args: [candId("pending")],
    });
    expect(rows.rows[0]?.source_session_id).toBe(sessionId);
  });

  it("deletes an aged session's checkpoint entity rather than orphaning it", async () => {
    const database = await open();
    const { sessionId } = await seedSession(database, "chkplain", OLD);
    const checkpointId = await seedCheckpoint(database, "chkplain", sessionId);

    const pruned = await pruneAll(database, CUTOFF);
    expect(pruned).toMatchObject({ sessions: 1, checkpoints: 1 });
    const entities = await database.execute({
      sql: "SELECT COUNT(*) AS n FROM entities WHERE id IN (?, ?)",
      args: [sessionId, checkpointId],
    });
    expect(Number(entities.rows[0]?.n)).toBe(0);
  });

  it("keeps a session with recent activity even when last_seen_at is stale", async () => {
    const database = await open();
    const { sessionId, turnId } = await seedSession(database, "live", OLD);
    // `last_seen_at` advances only on SESSION_STARTED, so a session running
    // longer than the window keeps a stale value. Trusting it alone would delete
    // this session's runs, turns, and tool events — including the activity below,
    // from after the cutoff — on the first sync after the session closes.
    await database.execute({
      sql: "UPDATE tool_events SET occurred_at = ? WHERE turn_id = ?",
      args: [RECENT, turnId],
    });

    const pruned = await pruneAll(database, CUTOFF);
    expect(pruned.sessions).toBe(0);
    const kept = await getAgentSessionById(database, sessionId);
    expect(kept.ok && kept.value).not.toBeNull();
  });

  it("keeps an aged session whose checkpoint a pending candidate references", async () => {
    const database = await open();
    const { sessionId } = await seedSession(database, "chkcand", OLD);
    const checkpointId = await seedCheckpoint(database, "chkcand", sessionId);
    // `propose_knowledge` accepts any existing `sourceCheckpointId`, so a pending
    // candidate can point at this session's checkpoint while its own
    // `source_session_id` is null. `source_checkpoint_id` is ON DELETE SET NULL,
    // so pruning would strip provenance from something awaiting review.
    const candidate = await insertCandidate(database, {
      id: candId("chkcand"),
      repositoryId: REPO,
      candidateType: "session_summary",
      payloadJson: "{}",
      sourceCheckpointId: checkpointId,
      revisionToken: "tok",
      createdAt: OLD,
    });
    expect(candidate.ok).toBe(true);

    const pruned = await pruneAll(database, CUTOFF);
    expect(pruned.sessions).toBe(0);
    const rows = await database.execute({
      sql: "SELECT source_checkpoint_id FROM candidates WHERE id = ?",
      args: [candId("chkcand")],
    });
    expect(rows.rows[0]?.source_checkpoint_id).toBe(checkpointId);
  });

  it("keeps an aged session whose run is still active", async () => {
    const database = await open();
    const { sessionId } = await seedSession(database, "active", OLD);
    // `last_seen_at` advances on every prompt and tool event, so an agent at work
    // never ages out. This covers the remaining case: a session left open and
    // idle past a short window, whose active run the agent would resume into.
    await database.execute({
      sql: "UPDATE session_runs SET status = 'active', ended_at = NULL WHERE session_id = ?",
      args: [sessionId],
    });

    const pruned = await pruneAll(database, CUTOFF);
    expect(pruned.sessions).toBe(0);
    const kept = await getAgentSessionById(database, sessionId);
    expect(kept.ok && kept.value).not.toBeNull();
  });

  it("prunes event_log by its own timestamp, independently of any session", async () => {
    const database = await open();
    // event_log.session_id is ON DELETE SET NULL, so these rows survive a session
    // delete; without their own timestamp sweep they would be unbounded.
    for (const [suffix, occurredAt] of [
      ["old1", OLD],
      ["old2", OLD],
      ["new1", RECENT],
    ] as const) {
      const inserted = await insertEventLog(database, {
        id: logId(suffix),
        repositoryId: REPO,
        eventType: "api.request",
        outcome: "failure",
        occurredAt,
      });
      expect(inserted.ok).toBe(true);
    }

    const pruned = await pruneAll(database, CUTOFF);
    expect(pruned.eventLogRows).toBe(2);
    const counts = await countLocalEventData(database, REPO, null);
    expect(counts.ok && counts.value.eventLogRows).toBe(1);
  });
});

describe("countLocalEventData", () => {
  let tempDir: string | undefined;
  let db: Database | undefined;

  afterEach(async () => {
    if (db) {
      await closeDatabase(db);
      db = undefined;
    }
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  it("reports prunable sessions only when a cutoff is given", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    await insertRepository(db, {
      id: REPO,
      rootFingerprint: "fp-counts",
      createdAt: OLD,
      updatedAt: OLD,
    });
    await seedSession(db, "aged", OLD);

    const disabled = await countLocalEventData(db, REPO, null);
    expect(disabled.ok && disabled.value.prunableSessions).toBe(0);
    expect(disabled.ok && disabled.value.sessions).toBe(1);

    const enabled = await countLocalEventData(db, REPO, CUTOFF);
    expect(enabled.ok && enabled.value.prunableSessions).toBe(1);
  });
});
