import { fileURLToPath } from "node:url";
import { CryptoRandomSource, FixedClock } from "@iroha/domain";
import { closeDatabase, openDatabase } from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { initRepository } from "../init-repository.js";
import { resolveInitializedRepository } from "../resolve-repository.js";
import { createTempGitRepo, removeTempDir } from "../test-helpers/tmp-repo.js";
import { MAX_STDIN_BYTES, runHookEntry, toHookPlatform } from "./hook-entry.js";
import { runHook } from "./run-hook.js";

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

async function claudePreToolUse(cwd: string, sessionId: string, tool: Record<string, unknown>) {
  await runHook(
    {
      platform: "claude_code",
      raw: { cwd, session_id: sessionId, hook_event_name: "SessionStart", source: "startup" },
      cwd,
    },
    DEPS,
  );
  await runHook(
    {
      platform: "claude_code",
      raw: {
        cwd,
        session_id: sessionId,
        hook_event_name: "UserPromptSubmit",
        prompt: "go",
        prompt_id: "p1",
      },
      cwd,
    },
    DEPS,
  );
  await runHook(
    {
      platform: "claude_code",
      raw: { cwd, session_id: sessionId, hook_event_name: "PreToolUse", ...tool },
      cwd,
    },
    DEPS,
  );
}

async function toolEventCells(cwd: string): Promise<string[]> {
  const repo = await resolveInitializedRepository(cwd);
  if (!repo.ok) throw new Error("repo not resolved");
  const opened = await openDatabase(repo.value.dbPath);
  if (!opened.ok) throw new Error("db not opened");
  try {
    const result = await opened.value.execute(
      "SELECT tool_name, target_kind, target_summary, input_digest, response_digest FROM tool_events",
    );
    return result.rows.flatMap((row) =>
      Object.values(row).map((v) => (v === null ? "" : String(v))),
    );
  } finally {
    await closeDatabase(opened.value);
  }
}

describe("toHookPlatform", () => {
  it("maps the entrypoint argument to a platform", () => {
    expect(toHookPlatform("claude")).toBe("claude_code");
    expect(toHookPlatform("codex")).toBe("codex");
    expect(toHookPlatform("gemini")).toBeNull();
    expect(toHookPlatform(undefined)).toBeNull();
  });
});

describe("runHookEntry — fail-open input handling", () => {
  it("returns no output for an unknown platform argument", async () => {
    const out = await runHookEntry({ arg: "gemini", stdin: "{}", cwd: "/" });
    expect(out).toBeUndefined();
  });

  it("returns no output for malformed JSON", async () => {
    const out = await runHookEntry({ arg: "claude", stdin: "{ not json", cwd: "/", deps: DEPS });
    expect(out).toBeUndefined();
  });

  it("returns no output for input larger than 1 MiB", async () => {
    const oversize = JSON.stringify({
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
      pad: "x".repeat(MAX_STDIN_BYTES),
    });
    const out = await runHookEntry({ arg: "claude", stdin: oversize, cwd: "/", deps: DEPS });
    expect(out).toBeUndefined();
  });
});

describe("runHookEntry — end to end", () => {
  let repoDir: string | undefined;

  afterEach(async () => {
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
  });

  it("runs a valid SessionStart and returns a token-bearing context", async () => {
    repoDir = await initedRepo();
    const stdin = JSON.stringify({
      cwd: repoDir,
      session_id: "s1",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    const out = await runHookEntry({ arg: "claude", stdin, cwd: repoDir, deps: DEPS });
    expect(out).toBeDefined();
    expect(out).toContain("session_token: ist_");
  });
});

describe("hook contract corpus", () => {
  let repoDir: string | undefined;

  afterEach(async () => {
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
  });

  it("never persists a command body (only its leading-token classification and digest)", async () => {
    repoDir = await initedRepo();
    // A benign, unique marker stands in for a secret-bearing header value; it is
    // deliberately not shaped like a real credential so the secret scanner does
    // not flag this fixture, while still proving the command body is not stored.
    const marker = "DO-NOT-PERSIST-COMMAND-BODY-MARKER";
    await claudePreToolUse(repoDir, "s1", {
      tool_name: "Bash",
      tool_input: { command: `curl -H 'X-Trace: ${marker}' https://api.example` },
      tool_use_id: "t1",
    });
    const cells = await toolEventCells(repoDir);
    expect(cells).toContain("curl"); // classified to the leading token
    expect(cells.some((c) => c.includes(marker))).toBe(false);
    expect(cells.some((c) => c.includes("X-Trace"))).toBe(false);
  });

  it("resolves a non-ASCII (Japanese) path to a repo-relative target", async () => {
    repoDir = await initedRepo();
    await claudePreToolUse(repoDir, "s1", {
      tool_name: "Edit",
      tool_input: { file_path: "src/決済/サービス.ts", old_string: "a", new_string: "b" },
      tool_use_id: "t1",
    });
    const cells = await toolEventCells(repoDir);
    expect(cells).toContain("src/決済/サービス.ts");
  });
});
