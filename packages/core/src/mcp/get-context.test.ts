import { CryptoRandomSource, FixedClock, makeTypedId } from "@iroha/domain";
import {
  closeDatabase,
  insertAgentSession,
  insertCheckpoint,
  insertEntity,
  insertSessionRun,
  openDatabase,
  upsertSearchDocument,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { issueSessionToken } from "../hooks/session-token.js";
import { setupMcpRepo } from "../test-helpers/mcp-repo.js";
import { removeTempDir } from "../test-helpers/tmp-repo.js";
import { mcpGetContext } from "./get-context.js";

const T0 = new Date("2026-01-01T00:00:00.000Z");

describe("mcpGetContext", () => {
  const clock = new FixedClock(T0);
  const random = new CryptoRandomSource();
  let repoDir: string | undefined;

  afterEach(async () => {
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
  });

  it("packs matching knowledge and the session's unresolved items", async () => {
    const repo = await setupMcpRepo(random);
    repoDir = repo.repoDir;
    const iso = T0.toISOString();
    const sessionId = makeTypedId("ses", clock, random);
    const runId = makeTypedId("run", clock, random);
    const decId = makeTypedId("dec", clock, random);
    const chkId = makeTypedId("chk", clock, random);

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) throw new Error("open failed");
    await insertEntity(db.value, {
      id: sessionId,
      repositoryId: repo.repositoryId,
      entityType: "session",
      title: "Agent session",
      status: "active",
      authority: 60,
      sourceKind: "hook",
      createdAt: iso,
      updatedAt: iso,
    });
    await insertAgentSession(db.value, {
      id: sessionId,
      repositoryId: repo.repositoryId,
      platform: "claude_code",
      startedAt: iso,
      lastSeenAt: iso,
    });
    await insertSessionRun(db.value, {
      id: runId,
      sessionId,
      startSource: "startup",
      cwdFingerprint: "fp",
      startedAt: iso,
    });
    await insertEntity(db.value, {
      id: decId,
      repositoryId: repo.repositoryId,
      entityType: "decision",
      title: "Use libSQL",
      summary: "chosen index",
      status: "approved",
      authority: 100,
      sourceKind: "canonical",
      createdAt: iso,
      updatedAt: iso,
    });
    await upsertSearchDocument(db.value, {
      id: makeTypedId("sdoc", clock, random),
      entityId: decId,
      documentKind: "decision",
      title: "Use libSQL",
      body: "we use libsql",
      authority: 100,
      contentHash: "sha256:h",
      indexedAt: iso,
    });
    await insertEntity(db.value, {
      id: chkId,
      repositoryId: repo.repositoryId,
      entityType: "checkpoint",
      title: "Checkpoint",
      status: "active",
      authority: 60,
      sourceKind: "mcp",
      createdAt: iso,
      updatedAt: iso,
    });
    expect(
      (
        await insertCheckpoint(db.value, {
          id: chkId,
          sessionId,
          outcome: "completed",
          objective: "o",
          summary: "s",
          implementationJson: "[]",
          validationJson: "[]",
          unresolvedJson: JSON.stringify(["open question"]),
          referencesJson: "[]",
          labelsJson: "[]",
          createdAt: iso,
        })
      ).ok,
    ).toBe(true);
    const token = await issueSessionToken({
      db: db.value,
      salt: repo.salt,
      clock,
      random,
      repositoryId: repo.repositoryId,
      sessionId,
      runId,
      platform: "claude_code",
    });
    expect(token.ok).toBe(true);
    await closeDatabase(db.value);
    if (!token.ok) return;

    const res = await mcpGetContext({
      cwd: repo.repoDir,
      clock,
      random,
      sessionToken: token.value,
      query: "libsql",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.sessionId).toBe(sessionId);
    expect(res.value.runId).toBe(runId);
    expect(res.value.items.map((i) => i.id)).toContain(decId);
    expect(res.value.unresolved).toContain("open question");
  }, 15000);
});
