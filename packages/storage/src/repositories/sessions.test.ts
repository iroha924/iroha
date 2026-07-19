import type { TypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database } from "../connection.js";
import { openMigratedTestDb, removeTempDir } from "../test-helpers/tmp-db.js";
import { insertEntity, insertRepository } from "./identity.js";
import {
  closeSessionRun,
  closeTurn,
  getActiveSessionRunForSession,
  getAgentSessionById,
  getAgentSessionByPlatformIdentity,
  getCheckpointById,
  getSessionRunById,
  getTurnByExternalId,
  getTurnById,
  insertAgentSession,
  insertCheckpoint,
  insertSessionRun,
  insertToolEvent,
  insertTurn,
  listCheckpointsBySession,
  listToolEventsByTurn,
  touchAgentSessionLastSeen,
  updateTurnCheckpointState,
} from "./sessions.js";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T01:00:00.000Z";

function repoId(suffix: string): TypedId<"repo"> {
  return `repo_${suffix.padEnd(26, "0")}` as TypedId<"repo">;
}
function sesId(suffix: string): TypedId<"ses"> {
  return `ses_${suffix.padEnd(26, "0")}` as TypedId<"ses">;
}
function runId(suffix: string): TypedId<"run"> {
  return `run_${suffix.padEnd(26, "0")}` as TypedId<"run">;
}
function trnId(suffix: string): TypedId<"trn"> {
  return `trn_${suffix.padEnd(26, "0")}` as TypedId<"trn">;
}
function chkId(suffix: string): TypedId<"chk"> {
  return `chk_${suffix.padEnd(26, "0")}` as TypedId<"chk">;
}
function evtId(suffix: string): TypedId<"evt"> {
  return `evt_${suffix.padEnd(26, "0")}` as TypedId<"evt">;
}

async function seedRepositoryAndSession(
  db: Database,
  repoSuffix: string,
  sesSuffix: string,
): Promise<{ repositoryId: TypedId<"repo">; sessionId: TypedId<"ses"> }> {
  const repositoryId = repoId(repoSuffix);
  await insertRepository(db, {
    id: repositoryId,
    rootFingerprint: `fp-${repoSuffix}`,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const sessionId = sesId(sesSuffix);
  await insertEntity(db, {
    id: sessionId,
    repositoryId,
    entityType: "session",
    title: "Session",
    status: "active",
    authority: 60,
    sourceKind: "hook",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await insertAgentSession(db, {
    id: sessionId,
    repositoryId,
    platform: "claude_code",
    platformSessionId: `plat-${sesSuffix}`,
    startedAt: NOW,
    lastSeenAt: NOW,
  });
  return { repositoryId, sessionId };
}

describe("session repositories", () => {
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

  it("inserts an agent session and reads it back by id and platform identity", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const { repositoryId, sessionId } = await seedRepositoryAndSession(db, "a", "a");

    const byId = await getAgentSessionById(db, sessionId);
    expect(byId.ok).toBe(true);
    if (byId.ok) {
      expect(byId.value?.platform).toBe("claude_code");
      expect(byId.value?.summaryStatus).toBe("none");
    }

    const byPlatform = await getAgentSessionByPlatformIdentity(
      db,
      repositoryId,
      "claude_code",
      "plat-a",
    );
    expect(byPlatform.ok).toBe(true);
    if (byPlatform.ok) {
      expect(byPlatform.value?.id).toBe(sessionId);
    }
  });

  it("updates last_seen_at on touch", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const { sessionId } = await seedRepositoryAndSession(db, "b", "b");

    await touchAgentSessionLastSeen(db, sessionId, LATER);

    const result = await getAgentSessionById(db, sessionId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value?.lastSeenAt).toBe(LATER);
    }
  });

  it("inserts a session run active, then closes it through the domain transition validator", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const { sessionId } = await seedRepositoryAndSession(db, "c", "c");
    const id = runId("c");

    const inserted = await insertSessionRun(db, {
      id,
      sessionId,
      startSource: "startup",
      cwdFingerprint: "cwd-c",
      startedAt: NOW,
    });
    expect(inserted.ok).toBe(true);

    const active = await getActiveSessionRunForSession(db, sessionId);
    expect(active.ok).toBe(true);
    if (active.ok) {
      expect(active.value?.id).toBe(id);
      expect(active.value?.status).toBe("active");
      expect(active.value?.endedAt).toBeNull();
    }

    const closed = await closeSessionRun(db, id, {
      from: "active",
      to: "completed",
      endedAt: LATER,
      endReason: "normal",
    });
    expect(closed.ok).toBe(true);

    const read = await getSessionRunById(db, id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.status).toBe("completed");
      expect(read.value?.endedAt).toBe(LATER);
    }
  });

  it("fails with CONFLICT when closeSessionRun races against a status that already changed", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const { sessionId } = await seedRepositoryAndSession(db, "c2", "c2");
    const id = runId("c2");
    await insertSessionRun(db, {
      id,
      sessionId,
      startSource: "startup",
      cwdFingerprint: "cwd-c2",
      startedAt: NOW,
    });

    // First caller closes the run "completed" ...
    const first = await closeSessionRun(db, id, {
      from: "active",
      to: "completed",
      endedAt: LATER,
      endReason: "normal",
    });
    expect(first.ok).toBe(true);

    // ... a second, racing caller still believes the row was "active" and
    // tries to close it "interrupted" instead: without a status re-check in
    // the UPDATE's WHERE clause, this would silently overwrite the first
    // caller's write with no error (confirmed by reproduction).
    const second = await closeSessionRun(db, id, {
      from: "active",
      to: "interrupted",
      endedAt: LATER,
      endReason: "interrupted",
    });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("CONFLICT");
    }
    const read = await getSessionRunById(db, id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.status).toBe("completed");
    }
  });

  it("rejects an illegal session run transition before touching the database", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const { sessionId } = await seedRepositoryAndSession(db, "d", "d");
    const id = runId("d");
    await insertSessionRun(db, {
      id,
      sessionId,
      startSource: "startup",
      cwdFingerprint: "cwd-d",
      startedAt: NOW,
    });
    await closeSessionRun(db, id, {
      from: "active",
      to: "completed",
      endedAt: LATER,
      endReason: "normal",
    });

    // "completed" -> "active" is not in the domain's allowed transition set.
    const result = await closeSessionRun(db, id, {
      from: "completed",
      to: "active",
      endedAt: NOW,
      endReason: "normal",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
    const read = await getSessionRunById(db, id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.status).toBe("completed");
    }
  });

  it("inserts a turn active, reads it by external id, and closes it", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const { sessionId } = await seedRepositoryAndSession(db, "e", "e");
    const runIdValue = runId("e");
    await insertSessionRun(db, {
      id: runIdValue,
      sessionId,
      startSource: "startup",
      cwdFingerprint: "cwd-e",
      startedAt: NOW,
    });
    const id = trnId("e");

    await insertTurn(db, { id, runId: runIdValue, externalTurnId: "ext-e", startedAt: NOW });

    const byExternal = await getTurnByExternalId(db, runIdValue, "ext-e");
    expect(byExternal.ok).toBe(true);
    if (byExternal.ok) {
      expect(byExternal.value?.id).toBe(id);
      expect(byExternal.value?.status).toBe("active");
      expect(byExternal.value?.checkpointState).toBe("not_required");
    }

    await updateTurnCheckpointState(db, id, "pending");
    const closed = await closeTurn(db, id, { from: "active", to: "completed", stoppedAt: LATER });
    expect(closed.ok).toBe(true);

    const read = await getTurnById(db, id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.status).toBe("completed");
      expect(read.value?.checkpointState).toBe("pending");
      expect(read.value?.stoppedAt).toBe(LATER);
    }
  });

  it("fails with CONFLICT when closeTurn races against a status that already changed", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const { sessionId } = await seedRepositoryAndSession(db, "e2", "e2");
    const runIdValue = runId("e2");
    await insertSessionRun(db, {
      id: runIdValue,
      sessionId,
      startSource: "startup",
      cwdFingerprint: "cwd-e2",
      startedAt: NOW,
    });
    const id = trnId("e2");
    await insertTurn(db, { id, runId: runIdValue, startedAt: NOW });

    const first = await closeTurn(db, id, { from: "active", to: "completed", stoppedAt: LATER });
    expect(first.ok).toBe(true);

    const second = await closeTurn(db, id, { from: "active", to: "failed", stoppedAt: LATER });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("CONFLICT");
    }
    const read = await getTurnById(db, id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.status).toBe("completed");
    }
  });

  it("inserts and lists tool events for a turn in occurred_at order", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const { sessionId } = await seedRepositoryAndSession(db, "f", "f");
    const runIdValue = runId("f");
    await insertSessionRun(db, {
      id: runIdValue,
      sessionId,
      startSource: "startup",
      cwdFingerprint: "cwd-f",
      startedAt: NOW,
    });
    const turnIdValue = trnId("f");
    await insertTurn(db, { id: turnIdValue, runId: runIdValue, startedAt: NOW });

    await insertToolEvent(db, {
      id: evtId("f1"),
      turnId: turnIdValue,
      toolName: "Read",
      phase: "post",
      status: "succeeded",
      occurredAt: NOW,
    });
    await insertToolEvent(db, {
      id: evtId("f2"),
      turnId: turnIdValue,
      toolName: "Edit",
      phase: "post",
      status: "succeeded",
      occurredAt: LATER,
    });

    const events = await listToolEventsByTurn(db, turnIdValue);
    expect(events.ok).toBe(true);
    if (events.ok) {
      expect(events.value.map((e) => e.toolName)).toEqual(["Read", "Edit"]);
    }
  });

  it("inserts a checkpoint and lists checkpoints for a session", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    const { sessionId } = await seedRepositoryAndSession(db, "g", "g");
    const id = chkId("g");
    await insertEntity(db, {
      id,
      repositoryId: repoId("g"),
      entityType: "checkpoint",
      title: "Checkpoint",
      status: "recorded",
      authority: 60,
      sourceKind: "mcp",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const inserted = await insertCheckpoint(db, {
      id,
      sessionId,
      outcome: "completed",
      objective: "Implement WP-03",
      summary: "Added storage repositories",
      implementationJson: "[]",
      validationJson: "[]",
      unresolvedJson: "[]",
      referencesJson: "[]",
      labelsJson: "[]",
      createdAt: NOW,
    });
    expect(inserted.ok).toBe(true);

    const read = await getCheckpointById(db, id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value?.objective).toBe("Implement WP-03");
    }

    const list = await listCheckpointsBySession(db, sessionId);
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value.map((c) => c.id)).toEqual([id]);
    }
  });
});
