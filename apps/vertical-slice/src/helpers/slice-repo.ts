import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInitializedRepository, runInit } from "@iroha/core";
import { type Clock, CryptoRandomSource, type RandomSource, SystemClock } from "@iroha/domain";
import { ensureRepositorySalt, runGit } from "@iroha/git";

/** Committed synthetic project the harness drives (never installed by pnpm). */
const FIXTURE_DIR = fileURLToPath(
  new URL("../../../../tests/fixtures/repo-basic", import.meta.url),
);
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations", import.meta.url));

/** Resolved repository identity — the `.value` of `resolveInitializedRepository`. */
type ResolvedRepository = Extract<
  Awaited<ReturnType<typeof resolveInitializedRepository>>,
  { ok: true }
>["value"];

export interface SliceRepo {
  repoDir: string;
  resolved: ResolvedRepository;
  /** Repository-keyed HMAC salt, shared by hook and MCP paths. */
  salt: Uint8Array;
  clock: Clock;
  random: RandomSource;
  /** Number of local candidates created by the `--scan` import. */
  candidatesCreated: number;
}

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
  label: string,
): T {
  if (!result.ok) {
    throw new Error(`${label} failed: ${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/**
 * Copies the `repo-basic` fixture into a fresh temp Git repository, commits it,
 * and runs `iroha init --scan`. Returns the resolved identity plus a live
 * clock/random/salt the subsequent slice steps use to drive hooks and MCP.
 * Clean up with {@link cleanupSliceRepo}.
 */
export async function buildSliceRepo(): Promise<SliceRepo> {
  const repoDir = await mkdtemp(join(tmpdir(), "iroha-slice-"));
  await cp(FIXTURE_DIR, repoDir, { recursive: true });

  unwrap(await runGit(["init", "--initial-branch=main"], { cwd: repoDir }), "git init");
  await runGit(["config", "user.email", "dev@example.com"], { cwd: repoDir });
  await runGit(["config", "user.name", "Example Developer"], { cwd: repoDir });
  unwrap(await runGit(["add", "-A"], { cwd: repoDir }), "git add");
  unwrap(
    await runGit(["commit", "-m", "chore: initial repo-basic fixture"], { cwd: repoDir }),
    "git commit",
  );

  const clock = new SystemClock();
  const random = new CryptoRandomSource();

  const init = unwrap(await runInit(repoDir, MIGRATIONS_DIR, { scan: true }), "iroha init");
  const resolved = unwrap(await resolveInitializedRepository(repoDir), "resolve repository");
  const salt = unwrap(
    await ensureRepositorySalt(resolved.irohaStateDir, random),
    "repository salt",
  );

  return {
    repoDir,
    resolved,
    salt,
    clock,
    random,
    candidatesCreated: init.init.candidatesCreated,
  };
}

/**
 * Best-effort recursive removal with a bounded retry for the Windows
 * post-close libSQL file-lock lag (see `.claude/rules/windows-ci-compat.md`).
 */
export async function cleanupSliceRepo(repoDir: string): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rm(repoDir, { recursive: true, force: true });
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") {
        throw cause;
      }
      if (attempt === maxAttempts) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
}
