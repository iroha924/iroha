import { CryptoRandomSource, FixedClock, makeTypedId, type TypedId } from "@iroha/domain";
import {
  closeDatabase,
  closeSessionRun,
  type Database,
  getSessionToken,
  insertAgentSession,
  insertEntity,
  insertRepository,
  insertSessionRun,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { hashSessionToken, issueSessionToken } from "../hooks/session-token.js";
import { openMigratedTestDb, removeTempDir } from "../test-helpers/tmp-db.js";
import { verifySessionToken } from "./verify-session-token.js";

const SALT = new Uint8Array(32).fill(9);
const T0 = new Date("2026-01-01T00:00:00.000Z");
const random = new CryptoRandomSource();

interface Seeded {
  repositoryId: TypedId<"repo">;
  sessionId: TypedId<"ses">;
  runId: TypedId<"run">;
  token: string;
}

async function seed(db: Database, issuedAt: Date): Promise<Seeded> {
  const clock = new FixedClock(issuedAt);
  const repositoryId = makeTypedId("repo", clock, random);
  const sessionId = makeTypedId("ses", clock, random);
  const runId = makeTypedId("run", clock, random);
  const iso = issuedAt.toISOString();

  const repo = await insertRepository(db, {
    id: repositoryId,
    rootFingerprint: `sha256:${repositoryId}`,
    createdAt: iso,
    updatedAt: iso,
  });
  expect(repo.ok).toBe(true);
  const entity = await insertEntity(db, {
    id: sessionId,
    repositoryId,
    entityType: "session",
    title: "Agent session",
    status: "active",
    authority: 60,
    sourceKind: "hook",
    createdAt: iso,
    updatedAt: iso,
  });
  expect(entity.ok).toBe(true);
  const session = await insertAgentSession(db, {
    id: sessionId,
    repositoryId,
    platform: "claude_code",
    startedAt: iso,
    lastSeenAt: iso,
  });
  expect(session.ok).toBe(true);
  const run = await insertSessionRun(db, {
    id: runId,
    sessionId,
    startSource: "startup",
    cwdFingerprint: "cwd-fp",
    startedAt: iso,
  });
  expect(run.ok).toBe(true);
  const issued = await issueSessionToken({
    db,
    salt: SALT,
    clock,
    random,
    repositoryId,
    sessionId,
    runId,
    platform: "claude_code",
  });
  if (!issued.ok) {
    throw new Error(`failed to issue token: ${issued.error.code}: ${issued.error.message}`);
  }
  return { repositoryId, sessionId, runId, token: issued.value };
}

describe("verifySessionToken", () => {
  let dir: string | undefined;
  let db: Database | undefined;

  afterEach(async () => {
    if (db) {
      await closeDatabase(db);
      db = undefined;
    }
    if (dir) {
      await removeTempDir(dir);
      dir = undefined;
    }
  });

  it("accepts a valid token and slides the idle window forward", async () => {
    ({ dir, db } = await openMigratedTestDb());
    const seeded = await seed(db, T0);

    const verifyAt = new Date(T0.getTime() + 60 * 60 * 1000); // +1h
    const result = await verifySessionToken({
      db,
      salt: SALT,
      repositoryId: seeded.repositoryId,
      clock: new FixedClock(verifyAt),
      token: seeded.token,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.repositoryId).toBe(seeded.repositoryId);
      expect(result.value.sessionId).toBe(seeded.sessionId);
      expect(result.value.runId).toBe(seeded.runId);
      expect(result.value.platform).toBe("claude_code");
    }

    const stored = await getSessionToken(db, hashSessionToken(SALT, seeded.token));
    expect(stored.ok).toBe(true);
    if (stored.ok && stored.value) {
      expect(stored.value.lastUsedAt).toBe(verifyAt.toISOString());
      // new expiry = verifyAt + 24h, strictly later than the original issue+24h
      expect(new Date(stored.value.expiresAt).getTime()).toBeGreaterThan(
        T0.getTime() + 24 * 60 * 60 * 1000,
      );
    }
  });

  it("rejects a malformed token as INVALID_SESSION_TOKEN", async () => {
    ({ dir, db } = await openMigratedTestDb());
    const seeded = await seed(db, T0);

    const result = await verifySessionToken({
      db,
      salt: SALT,
      repositoryId: seeded.repositoryId,
      clock: new FixedClock(T0),
      token: "not-a-valid-token",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_SESSION_TOKEN");
    }
  });

  it("rejects a well-formed but unknown token as INVALID_SESSION_TOKEN", async () => {
    ({ dir, db } = await openMigratedTestDb());
    const seeded = await seed(db, T0);

    const result = await verifySessionToken({
      db,
      salt: SALT,
      repositoryId: seeded.repositoryId,
      clock: new FixedClock(T0),
      token: `ist_${"A".repeat(43)}`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_SESSION_TOKEN");
    }
  });

  it("rejects a token presented against the wrong repository", async () => {
    ({ dir, db } = await openMigratedTestDb());
    const seeded = await seed(db, T0);

    const result = await verifySessionToken({
      db,
      salt: SALT,
      repositoryId: makeTypedId("repo", new FixedClock(T0), random),
      clock: new FixedClock(T0),
      token: seeded.token,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_SESSION_TOKEN");
    }
  });

  it("rejects a token past its idle expiry as SESSION_EXPIRED", async () => {
    ({ dir, db } = await openMigratedTestDb());
    const seeded = await seed(db, T0);

    const result = await verifySessionToken({
      db,
      salt: SALT,
      repositoryId: seeded.repositoryId,
      clock: new FixedClock(new Date(T0.getTime() + 25 * 60 * 60 * 1000)), // +25h
      token: seeded.token,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SESSION_EXPIRED");
    }
  });

  it("rejects a token whose run has been completed as SESSION_EXPIRED", async () => {
    ({ dir, db } = await openMigratedTestDb());
    const seeded = await seed(db, T0);

    const closed = await closeSessionRun(db, seeded.runId, {
      from: "active",
      to: "completed",
      endedAt: new Date(T0.getTime() + 60 * 1000).toISOString(),
      endReason: "normal",
    });
    expect(closed.ok).toBe(true);

    const result = await verifySessionToken({
      db,
      salt: SALT,
      repositoryId: seeded.repositoryId,
      clock: new FixedClock(new Date(T0.getTime() + 60 * 60 * 1000)),
      token: seeded.token,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SESSION_EXPIRED");
    }
  });
});
