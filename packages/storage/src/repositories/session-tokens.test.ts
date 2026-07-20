import type { TypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database } from "../connection.js";
import { openMigratedTestDb, removeTempDir } from "../test-helpers/tmp-db.js";
import { insertEntity, insertRepository } from "./identity.js";
import { getSessionToken, insertSessionToken } from "./session-tokens.js";
import { insertAgentSession, insertSessionRun } from "./sessions.js";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const HMAC = `hmac-sha256:${"a".repeat(64)}`;

const repositoryId = "repo_00000000000000000000000000" as TypedId<"repo">;
const sessionId = "ses_00000000000000000000000000" as TypedId<"ses">;
const runId = "run_00000000000000000000000000" as TypedId<"run">;

async function seed(db: Database): Promise<void> {
  await insertRepository(db, {
    id: repositoryId,
    rootFingerprint: "fp-a",
    createdAt: NOW,
    updatedAt: NOW,
  });
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
    platformSessionId: "plat-a",
    startedAt: NOW,
    lastSeenAt: NOW,
  });
  await insertSessionRun(db, {
    id: runId,
    sessionId,
    startSource: "startup",
    cwdFingerprint: `hmac-sha256:${"b".repeat(64)}`,
    startedAt: NOW,
  });
}

describe("session token repository", () => {
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

  it("stores only the HMAC digest and reads it back by digest", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    await seed(db);

    const inserted = await insertSessionToken(db, {
      tokenHmac: HMAC,
      repositoryId,
      sessionId,
      runId,
      platform: "claude_code",
      issuedAt: NOW,
      lastUsedAt: NOW,
      expiresAt: LATER,
    });
    expect(inserted.ok).toBe(true);

    const found = await getSessionToken(db, HMAC);
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.value).toStrictEqual({
        tokenHmac: HMAC,
        repositoryId,
        sessionId,
        runId,
        platform: "claude_code",
        issuedAt: NOW,
        lastUsedAt: NOW,
        expiresAt: LATER,
      });
    }
  });

  it("returns null for an unknown token digest", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    await seed(db);

    const found = await getSessionToken(db, `hmac-sha256:${"c".repeat(64)}`);
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.value).toBeNull();
    }
  });

  it("rejects a token bound to a non-existent run (foreign key)", async () => {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    await seed(db);

    const result = await insertSessionToken(db, {
      tokenHmac: HMAC,
      repositoryId,
      sessionId,
      runId: "run_ffffffffffffffffffffffffff" as TypedId<"run">,
      platform: "claude_code",
      issuedAt: NOW,
      lastUsedAt: NOW,
      expiresAt: LATER,
    });
    expect(result.ok).toBe(false);
  });
});
