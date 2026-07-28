import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import { runGit } from "@iroha/git";
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
      "SELECT start_source, git_branch, head_sha_start, head_sha_end, status FROM session_runs ORDER BY started_at",
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

/** A temp dir holding an executable `git` that hangs, to exercise the resolution timeout. */
async function makeHangingGitBin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iroha-hanggit-"));
  const bin = join(dir, "git");
  await writeFile(bin, "#!/bin/sh\nexec sleep 30\n");
  await chmod(bin, 0o755);
  return dir;
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

  it("fails open (does not throw) on a prototype-key hook_event_name", async () => {
    repoDir = await initedRepo();
    // A budget lookup that resolved a prototype key to an inherited non-number
    // would pass an invalid timeout to `git`, throwing out of runHook's fail-open.
    const result = await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "__proto__",
    });
    expect(result.stdout).toBeUndefined();
  });

  // Windows is out of CI (compatibility.md §6) and the hanging-git stub is a POSIX shell script.
  it.skipIf(process.platform === "win32")(
    "fails open within the event budget when git hangs during repository resolution",
    async () => {
      repoDir = await initedRepo(); // resolves with the real git
      const hangingGitDir = await makeHangingGitBin();
      const originalPath = process.env.PATH;
      process.env.PATH = `${hangingGitDir}${delimiter}${originalPath ?? ""}`;
      try {
        const start = performance.now();
        const result = await hook(repoDir, "claude_code", {
          session_id: "s1",
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          tool_input: { file_path: "a.ts", old_string: "a", new_string: "b" },
          tool_use_id: "t1",
        });
        const elapsedMs = performance.now() - start;
        // Fail-open: a resolution that times out yields no output.
        expect(result.stdout).toBeUndefined();
        // Bounded to ~the PreToolUse budget, not runGit's 10s default. Without
        // the threaded timeout the first hung `git rev-parse` waits 10s and this
        // assertion goes red.
        expect(elapsedMs).toBeLessThan(3000);
      } finally {
        process.env.PATH = originalPath;
        await rm(hangingGitDir, { recursive: true, force: true });
      }
    },
    15000,
  );

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

  // §6.6 conditions a Checkpoint on success for a *mutation tool* only; a
  // build/test/migration command qualifies because it **ran**. Gating both on
  // success dropped exactly the turn worth recording — a failed validation and the
  // unresolved work behind it.
  it("requests a checkpoint after a validation command that failed", async () => {
    repoDir = await initedRepo();
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt: "run the tests",
      prompt_id: "p1",
    });
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_use_id: "t1",
    });

    const stop = await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
    });
    expect(parse(stop.stdout)).toStrictEqual({
      decision: "block",
      reason: expect.stringContaining("create_checkpoint"),
    });
  });

  // A successful command cannot be told apart from a read-only poll here, so it
  // suggests rather than blocks: the Turn ends and the agent decides.
  it("suggests a checkpoint at Stop after a command that succeeded, without blocking", async () => {
    repoDir = await initedRepo();
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt: "check the build",
      prompt_id: "p1",
    });
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status" },
      tool_response: { success: true },
      tool_use_id: "t1",
    });

    const stop = await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
    });

    const parsed = parse(stop.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
      decision?: string;
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("create_checkpoint");
    // Suggestion only: it must not block, and the Turn must not stay open.
    expect(parsed.decision).toBeUndefined();
    expect(await turnStatuses(repoDir)).toStrictEqual(["completed"]);
  });

  // Codex reports every settled tool as succeeded (§4 defers TOOL_FAILED to P1),
  // so the success split cannot be applied there without reading a failed
  // `pnpm test` as a success. Every Codex command keeps the required path.
  it("still requires a checkpoint for a Codex command, where failure is not observable", async () => {
    repoDir = await initedRepo();
    await hook(repoDir, "codex", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    await hook(repoDir, "codex", {
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt: "run the tests",
      turn_id: "p1",
    });
    await hook(repoDir, "codex", {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      tool_response: { ok: false },
      tool_use_id: "t1",
    });

    const stop = await hook(repoDir, "codex", {
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
    });
    expect(parse(stop.stdout)).toStrictEqual({
      decision: "block",
      reason: expect.stringContaining("create_checkpoint"),
    });
  });

  // A command that never settled leaves a `started` row behind. Suggesting on it
  // would reintroduce the empty reminders the split exists to remove.
  it("does not suggest a checkpoint for a command that never completed", async () => {
    repoDir = await initedRepo();
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt: "maybe run something",
      prompt_id: "p1",
    });
    // PreToolUse only — the user never approved it, so no PostToolUse arrives.
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /tmp/x" },
      tool_use_id: "t1",
    });

    const stop = await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
    });
    expect(stop.stdout).toBeUndefined();
  });

  // §6.6 step 4 promises the suggestion never repeats because the Turn ends.
  it("suggests only once when Stop is delivered twice", async () => {
    repoDir = await initedRepo();
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt: "check the build",
      prompt_id: "p1",
    });
    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "git status" },
      tool_response: { success: true },
      tool_use_id: "t1",
    });

    const first = await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
    });
    expect(first.stdout).toBeDefined();

    const second = await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "Stop",
      stop_hook_active: false,
    });
    expect(second.stdout).toBeUndefined();
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

  it("creates a Run for a fork SessionStart, recorded as startup", async () => {
    repoDir = await initedRepo();
    await commitFile(repoDir, "a.txt", "a");

    const result = await hook(repoDir, "claude_code", {
      session_id: "forked-1",
      hook_event_name: "SessionStart",
      source: "fork",
    });
    // Not rejected: the fork session gets its bounded context and a Run.
    expect(parse(result.stdout).hookSpecificOutput).toBeDefined();

    const runs = await sessionRuns(repoDir);
    expect(runs).toHaveLength(1);
    // A fork begins a new session, so its Run records as `startup` (the DB
    // start_source CHECK allows only startup/resume/clear).
    expect(runs[0]?.start_source).toBe("startup");
  });

  it("bounds a hostile branch name before it reaches the record", async () => {
    // `git clone` names the local branch after the remote's HEAD, so a hostile
    // repository controls this string; Git permits several KB of it.
    repoDir = await initedRepo();
    await commitFile(repoDir, "a.txt", "a");
    const long = "b".repeat(250);
    const checkout = await runGit(["checkout", "-b", long], { cwd: repoDir });
    expect(checkout.ok).toBe(true);

    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });

    const runs = await sessionRuns(repoDir);
    expect(runs[0]?.git_branch).toBe("b".repeat(200));
  });

  it.each([
    ["a bare token", `ist_${"a".repeat(43)}`],
    // The token followed by a suffix passes the shared scanner's exact-43
    // boundary, so a branch-specific check has to catch it.
    ["a token with a suffix", `fix-ist_${"a".repeat(43)}-work`],
  ])("drops a branch carrying %s, keeping the sha", async (_label, branchName) => {
    repoDir = await initedRepo();
    await commitFile(repoDir, "a.txt", "a");
    const checkout = await runGit(["checkout", "-b", branchName], { cwd: repoDir });
    expect(checkout.ok).toBe(true);

    await hook(repoDir, "claude_code", {
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });

    const runs = await sessionRuns(repoDir);
    expect(runs[0]?.git_branch).toBe(null);
    expect(String(runs[0]?.head_sha_start)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("records no branch or sha when HEAD cannot be read, without failing the hook", async () => {
    // A repository with no commits yet: `rev-parse HEAD` fails, and the Run is
    // still recorded (contracts/hooks.md §2 fail-open).
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
    // Documented scope (contracts/hooks.md §6.7): `handlePromptSubmitted` opens a
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
