import { type CheckpointInput, runHook } from "@iroha/core";
import type { TypedId } from "@iroha/domain";
import { dispatchTool, type McpEnvelope } from "@iroha/mcp";
import {
  closeDatabase,
  getActiveSessionRunForSession,
  getAgentSessionByPlatformIdentity,
  getSessionRunById,
  openDatabase,
} from "@iroha/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claudePostTool,
  claudePreTool,
  claudePrompt,
  claudeSessionStart,
  contextFromSessionStart,
  tokenFromSessionStart,
} from "./helpers/hook-events.js";
import { buildSliceRepo, cleanupSliceRepo, type SliceRepo } from "./helpers/slice-repo.js";

const SESSION = "recovery-sess-1";
const UNRESOLVED = "Wire the PaymentRepository into the composition root";
const EDIT_INPUT = { file_path: "src/payments/service.ts", old_string: "a", new_string: "b" };

let repo: SliceRepo;

beforeAll(async () => {
  repo = await buildSliceRepo();
}, 30_000);

afterAll(async () => {
  if (repo) {
    await cleanupSliceRepo(repo.repoDir);
  }
});

describe("Interruption and recovery (vertical-slice.md §5)", () => {
  it("interrupts the stale run, keeps the session, and injects the last checkpoint + unresolved", async () => {
    const deps = { clock: repo.clock, random: repo.random };
    const ctx = { cwd: repo.repoDir, clock: repo.clock, random: repo.random };
    const raw = (payload: unknown) => ({
      platform: "claude_code" as const,
      raw: payload,
      cwd: repo.repoDir,
    });

    // Run 1: start, prompt, edit, then save a checkpoint with an unresolved item.
    const started1 = await runHook(raw(claudeSessionStart(repo.repoDir, SESSION)), deps);
    const token = tokenFromSessionStart(started1.stdout);
    expect(token).toBeDefined();

    await runHook(raw(claudePrompt(repo.repoDir, SESSION, "Start GH-42", "p1")), deps);
    await runHook(raw(claudePreTool(repo.repoDir, SESSION, "Edit", EDIT_INPUT, "t1")), deps);
    await runHook(
      raw(claudePostTool(repo.repoDir, SESSION, "Edit", EDIT_INPUT, { success: true }, "t1", 10)),
      deps,
    );

    const checkpoint: CheckpointInput = {
      schemaVersion: 1,
      sessionToken: token as string,
      idempotencyKey: "recovery-checkpoint-0001",
      outcome: "partial",
      objective: "Begin the repository-pattern refactor",
      summary: "Extracted the port; wiring still pending",
      implementation: [
        { file: "src/payments/service.ts", change: "added the PaymentRepository port" },
      ],
      validation: [{ command: "pnpm test payments", result: "not_run" }],
      unresolved: [UNRESOLVED],
      references: [],
      labels: [],
      proposals: [],
    };
    const cp = await dispatchTool("create_checkpoint", checkpoint, ctx);
    const cpEnv = cp.structuredContent as unknown as McpEnvelope<{ checkpointId: string }>;
    expect(cpEnv.ok).toBe(true);
    if (!cpEnv.ok) throw new Error(`checkpoint failed: ${cpEnv.error.code}`);
    const checkpointId = cpEnv.data.checkpointId;

    // A new in-progress (pending) Turn, then abrupt termination — no Stop/SessionEnd.
    await runHook(raw(claudePrompt(repo.repoDir, SESSION, "Continue GH-42", "p2")), deps);
    await runHook(raw(claudePreTool(repo.repoDir, SESSION, "Edit", EDIT_INPUT, "t2")), deps);
    await runHook(
      raw(claudePostTool(repo.repoDir, SESSION, "Edit", EDIT_INPUT, { success: true }, "t2", 10)),
      deps,
    );

    const run1Id = await activeRunId();

    // Resume: the next SessionStart with the same platform session id.
    const started2 = await runHook(raw(claudeSessionStart(repo.repoDir, SESSION, "resume")), deps);
    const context2 = contextFromSessionStart(started2.stdout);

    // The last saved checkpoint and its unresolved item are injected; nothing is
    // fabricated (only the structured checkpoint appears).
    expect(context2).toContain(checkpointId);
    expect(context2).toContain(UNRESOLVED);

    const db = await openDatabase(repo.resolved.dbPath);
    if (!db.ok) throw new Error("db open failed");
    try {
      // Session identity is stable across the interruption.
      const session = await getAgentSessionByPlatformIdentity(
        db.value,
        repo.resolved.repositoryId,
        "claude_code",
        SESSION,
      );
      expect(session.ok && session.value !== null).toBe(true);
      if (!session.ok || !session.value) return;

      // Run 1 is now interrupted; a new active run resumes the session.
      const run1 = await getSessionRunById(db.value, run1Id);
      expect(run1.ok && run1.value?.status).toBe("interrupted");
      const active = await getActiveSessionRunForSession(db.value, session.value.id);
      expect(active.ok && active.value !== null).toBe(true);
      if (active.ok && active.value) {
        expect(active.value.id).not.toBe(run1Id);
      }
    } finally {
      await closeDatabase(db.value);
    }
  }, 30_000);
});

/** The id of the session's currently-active run (fails the test on any gap). */
async function activeRunId(): Promise<TypedId<"run">> {
  const db = await openDatabase(repo.resolved.dbPath);
  if (!db.ok) throw new Error("db open failed");
  try {
    const session = await getAgentSessionByPlatformIdentity(
      db.value,
      repo.resolved.repositoryId,
      "claude_code",
      SESSION,
    );
    if (!session.ok || !session.value) throw new Error("session missing");
    const run = await getActiveSessionRunForSession(db.value, session.value.id);
    if (!run.ok || !run.value) throw new Error("active run missing");
    return run.value.id;
  } finally {
    await closeDatabase(db.value);
  }
}
