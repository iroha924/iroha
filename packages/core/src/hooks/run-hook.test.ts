import { fileURLToPath } from "node:url";
import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import { closeDatabase, openDatabase } from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { initRepository } from "../init-repository.js";
import { resolveInitializedRepository } from "../resolve-repository.js";
import { createTempGitRepo, removeTempDir } from "../test-helpers/tmp-repo.js";
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
});
