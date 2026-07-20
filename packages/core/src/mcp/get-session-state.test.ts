import { fileURLToPath } from "node:url";
import { CryptoRandomSource, FixedClock, makeTypedId } from "@iroha/domain";
import { ensureRepositorySalt } from "@iroha/git";
import {
  closeDatabase,
  insertAgentSession,
  insertEntity,
  insertSessionRun,
  openDatabase,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../commands.js";
import { issueSessionToken } from "../hooks/session-token.js";
import { resolveInitializedRepository } from "../resolve-repository.js";
import { createTempGitRepo, removeTempDir } from "../test-helpers/tmp-repo.js";
import { mcpGetSessionState } from "./get-session-state.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const T0 = new Date("2026-01-01T00:00:00.000Z");

describe("mcpGetSessionState", () => {
  const clock = new FixedClock(T0);
  const random = new CryptoRandomSource();
  let repoDir: string | undefined;

  afterEach(async () => {
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
  });

  it("returns the verified session's lifecycle state", async () => {
    repoDir = await createTempGitRepo();
    const init = await runInit(repoDir, MIGRATIONS_DIR);
    expect(init.ok).toBe(true);

    const resolved = await resolveInitializedRepository(repoDir);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const { repositoryId, irohaStateDir, dbPath } = resolved.value;

    const saltResult = await ensureRepositorySalt(irohaStateDir, random);
    expect(saltResult.ok).toBe(true);
    if (!saltResult.ok) return;

    const opened = await openDatabase(dbPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const sessionId = makeTypedId("ses", clock, random);
    const runId = makeTypedId("run", clock, random);
    const iso = T0.toISOString();
    expect(
      (
        await insertEntity(opened.value, {
          id: sessionId,
          repositoryId,
          entityType: "session",
          title: "Agent session",
          status: "active",
          authority: 60,
          sourceKind: "hook",
          createdAt: iso,
          updatedAt: iso,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await insertAgentSession(opened.value, {
          id: sessionId,
          repositoryId,
          platform: "claude_code",
          startedAt: iso,
          lastSeenAt: iso,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await insertSessionRun(opened.value, {
          id: runId,
          sessionId,
          startSource: "startup",
          cwdFingerprint: "cwd-fp",
          gitBranch: "main",
          headShaStart: "abc1234",
          startedAt: iso,
        })
      ).ok,
    ).toBe(true);
    const issued = await issueSessionToken({
      db: opened.value,
      salt: saltResult.value,
      clock,
      random,
      repositoryId,
      sessionId,
      runId,
      platform: "claude_code",
    });
    expect(issued.ok).toBe(true);
    await closeDatabase(opened.value);
    if (!issued.ok) return;

    const state = await mcpGetSessionState({
      cwd: repoDir,
      clock,
      random,
      sessionToken: issued.value,
    });

    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.sessionId).toBe(sessionId);
    expect(state.value.runId).toBe(runId);
    expect(state.value.branch).toBe("main");
    expect(state.value.startSha).toBe("abc1234");
    expect(state.value.turnId).toBeNull();
    expect(state.value.pendingCheckpoint).toBe(false);
    expect(state.value.lastCheckpoint).toBeNull();
    expect(state.value.unresolved).toEqual([]);
    expect(state.value.issueRefs).toEqual([]);
    expect(state.value.prRefs).toEqual([]);
  }, 15000);

  it("returns NOT_INITIALIZED for a repository without .iroha/", async () => {
    repoDir = await createTempGitRepo();
    const state = await mcpGetSessionState({
      cwd: repoDir,
      clock,
      random,
      sessionToken: `ist_${"A".repeat(43)}`,
    });
    expect(state.ok).toBe(false);
    if (!state.ok) {
      expect(state.error.code).toBe("NOT_INITIALIZED");
    }
  });
});
