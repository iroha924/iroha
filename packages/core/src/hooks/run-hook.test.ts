import { fileURLToPath } from "node:url";
import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import { closeDatabase, openDatabase } from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { initRepository } from "../init-repository.js";
import { resolveInitializedRepository } from "../resolve-repository.js";
import { commitFile, createTempGitRepo, removeTempDir } from "../test-helpers/tmp-repo.js";
import { type HookPlatform, runHook } from "./run-hook.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations", import.meta.url));
const CLOCK = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const DEPS = { clock: CLOCK, random: new CryptoRandomSource() };

async function initedRepo(): Promise<string> {
  const dir = await createTempGitRepo();
  const result = await initRepository(dir, CLOCK, new CryptoRandomSource(), MIGRATIONS_DIR);
  if (!result.ok) {
    throw new Error(`init failed: ${result.error.code}`);
  }
  return dir;
}

function hook(cwd: string, platform: HookPlatform, raw: Record<string, unknown>) {
  return runHook({ platform, raw: { cwd, ...raw }, cwd }, DEPS);
}

function parse(stdout: string | undefined): Record<string, unknown> {
  if (stdout === undefined) throw new Error("expected stdout");
  return JSON.parse(stdout);
}

async function countSessionTokens(cwd: string): Promise<number> {
  const repo = await resolveInitializedRepository(cwd);
  if (!repo.ok) throw new Error("repo not resolved");
  const opened = await openDatabase(repo.value.dbPath);
  if (!opened.ok) throw new Error("db not opened");
  try {
    const result = await opened.value.execute("SELECT count(*) AS n FROM session_tokens");
    return Number(result.rows[0]?.n ?? 0);
  } finally {
    await closeDatabase(opened.value);
  }
}

async function sessionRuns(cwd: string): Promise<Record<string, unknown>[]> {
  const repo = await resolveInitializedRepository(cwd);
  if (!repo.ok) throw new Error("repo not resolved");
  const opened = await openDatabase(repo.value.dbPath);
  if (!opened.ok) throw new Error("db not opened");
  try {
    const result = await opened.value.execute(
      "SELECT git_branch, head_sha_start, head_sha_end, status FROM session_runs ORDER BY started_at",
    );
    return result.rows.map((row) => ({ ...row }));
  } finally {
    await closeDatabase(opened.value);
  }
}

async function turnStatuses(cwd: string): Promise<string[]> {
  const repo = await resolveInitializedRepository(cwd);
  if (!repo.ok) throw new Error("repo not resolved");
  const opened = await openDatabase(repo.value.dbPath);
  if (!opened.ok) throw new Error("db not opened");
  try {
    const result = await opened.value.execute("SELECT status FROM turns");
    return result.rows.map((row) => String(row.status));
  } finally {
    await closeDatabase(opened.value);
  }
}

describe("runHook", () => {
  let repoDir: string | undefined;

  afterEach(async () => {
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
  });

  it("is a silent no-op outside an initialized repository", async () => {
    repoDir = await createTempGitRepo(); // git repo, but no `iroha init`
    const result = await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    expect(result.stdout).toBeUndefined();
  });

  it("SessionStart returns a bounded context with a token, and persists the token", async () => {
    repoDir = await initedRepo();
    const result = await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    const output = parse(result.stdout);
    const specific = output.hookSpecificOutput as {
      hookEventName: string;
      additionalContext: string;
    };
    expect(specific.hookEventName).toBe("SessionStart");
    expect(specific.additionalContext).toContain("session_token: ist_");
    expect(specific.additionalContext).toContain("session: ses_");
    expect(specific.additionalContext).toContain("run: run_");
    expect(specific.additionalContext.length).toBeLessThanOrEqual(8000);

    expect(await countSessionTokens(repoDir)).toBe(1);
  });

  it("requests one checkpoint at Stop after a file-mutating turn, but never twice", async () => {
    repoDir = await initedRepo();
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt: "edit the payment service",
      prompt_id: "p1",
    });
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "src/payments/service.ts", old_string: "a", new_string: "b" },
      tool_use_id: "t1",
    });
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "src/payments/service.ts" },
      tool_response: { success: true },
      tool_use_id: "t1",
    });

    const firstStop = await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
    });
    expect(parse(firstStop.stdout)).toStrictEqual({
      decision: "block",
      reason: expect.stringContaining("create_checkpoint"),
    });

    // Already continuing from a stop hook → never block again.
    const secondStop = await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: true,
    });
    expect(secondStop.stdout).toBeUndefined();
  });

  it("does not request a checkpoint at Stop when the turn made no meaningful change", async () => {
    repoDir = await initedRepo();
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt: "just a question",
      prompt_id: "p1",
    });
    const stop = await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
    });
    expect(stop.stdout).toBeUndefined();
    // The Turn completes on Stop (hooks-contract §6.6 step 1), not left active.
    expect(await turnStatuses(repoDir)).toStrictEqual(["completed"]);
  });

  it("records the branch and HEAD sha the Run starts on", async () => {
    repoDir = await initedRepo();
    await commitFile(repoDir, "a.txt", "a");

    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });

    const runs = await sessionRuns(repoDir);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.git_branch).toBe("main");
    expect(String(runs[0]?.head_sha_start)).toMatch(/^[0-9a-f]{40}$/);
    expect(runs[0]?.head_sha_end).toBe(null);
  });

  it("records no branch or sha when HEAD cannot be read, without failing the hook", async () => {
    // A repository with no commits yet: `rev-parse HEAD` fails, and the Run is
    // still recorded (hooks-contract.md §2 fail-open).
    repoDir = await initedRepo();

    const result = await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });

    expect(parse(result.stdout).hookSpecificOutput).toBeDefined();
    const runs = await sessionRuns(repoDir);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.git_branch).toBe(null);
    expect(runs[0]?.head_sha_start).toBe(null);
  });

  it("closes the Run's open Turn as interrupted at SessionEnd, and records the end sha", async () => {
    repoDir = await initedRepo();
    await commitFile(repoDir, "a.txt", "a");
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt: "start something and quit",
      prompt_id: "p1",
    });

    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionEnd",
      reason: "clear",
    });

    // The Turn never reached its own Stop, so it is interrupted — not
    // completed, and never left active under a closed Run.
    expect(await turnStatuses(repoDir)).toStrictEqual(["interrupted"]);
    const runs = await sessionRuns(repoDir);
    expect(runs[0]?.status).toBe("completed");
    expect(String(runs[0]?.head_sha_end)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("leaves a Turn that already completed at Stop alone when the session ends", async () => {
    repoDir = await initedRepo();
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt: "just a question",
      prompt_id: "p1",
    });
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
    });

    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionEnd",
      reason: "other",
    });

    expect(await turnStatuses(repoDir)).toStrictEqual(["completed"]);
  });

  it("closes the open Turn of a stale Run when a new Run starts", async () => {
    repoDir = await initedRepo();
    await commitFile(repoDir, "a.txt", "a");
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt: "interrupted by a crash",
      prompt_id: "p1",
    });

    // No SessionEnd: the previous Run is repaired on the next SessionStart.
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "resume",
    });

    expect(await turnStatuses(repoDir)).toStrictEqual(["interrupted"]);
    const runs = await sessionRuns(repoDir);
    expect(runs.map((run) => run.status)).toStrictEqual(["interrupted", "active"]);
    // No end sha on the repaired Run: HEAD now is where the *new* invocation
    // starts, not where the abandoned Run stopped.
    expect(runs[0]?.head_sha_end).toBe(null);
  });

  it("repairs only the most recent Turn, leaving an earlier one open", async () => {
    // Documented scope (hooks-contract.md §6.7): `handlePromptSubmitted` opens a
    // Turn per prompt without closing the previous one, so two prompts with no
    // Stop between them leave an earlier Turn open — that gap belongs to the
    // prompt path, and this test pins the boundary rather than hiding it.
    repoDir = await initedRepo();
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    for (const promptId of ["p1", "p2"]) {
      await hook(repoDir, "claude_code", {
        session_id: "s1",
        hook_event_name: "UserPromptSubmit",
        prompt: `prompt ${promptId}`,
        prompt_id: promptId,
      });
    }

    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionEnd",
      reason: "other",
    });

    expect((await turnStatuses(repoDir)).sort()).toStrictEqual(["active", "interrupted"]);
  });

  it("works identically for Codex (parity)", async () => {
    repoDir = await initedRepo();
    const result = await hook(repoDir, "codex", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    const output = parse(result.stdout);
    const specific = output.hookSpecificOutput as {
      hookEventName: string;
      additionalContext: string;
    };
    expect(specific.hookEventName).toBe("SessionStart");
    expect(specific.additionalContext).toContain("session_token: ist_");
    expect(await countSessionTokens(repoDir)).toBe(1);
  });

  it("repairs an interrupted Codex Run and its Turn, which has no SessionEnd to rely on", async () => {
    repoDir = await initedRepo();
    await hook(repoDir, "codex", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    await hook(repoDir, "codex", {
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt: "interrupted",
      prompt_id: "p1",
    });

    await hook(repoDir, "codex", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "resume",
    });

    expect(await turnStatuses(repoDir)).toStrictEqual(["interrupted"]);
  });
});
