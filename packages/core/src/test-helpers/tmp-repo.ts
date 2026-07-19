import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "@iroha/git";

export async function createTempGitRepo(prefix = "iroha-core-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const init = await runGit(["init", "--initial-branch=main"], { cwd: dir });
  if (!init.ok) {
    throw new Error(`git init failed in test helper: ${init.error.message}`);
  }
  await runGit(["config", "user.email", "iroha-test@example.com"], { cwd: dir });
  await runGit(["config", "user.name", "iroha test"], { cwd: dir });
  return dir;
}

export async function commitFile(
  repoDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await writeFile(join(repoDir, relativePath), content, "utf8");
  const add = await runGit(["add", relativePath], { cwd: repoDir });
  if (!add.ok) {
    throw new Error(`git add failed in test helper: ${add.error.message}`);
  }
  const commit = await runGit(["commit", "-m", `add ${relativePath}`], { cwd: repoDir });
  if (!commit.ok) {
    throw new Error(`git commit failed in test helper: ${commit.error.message}`);
  }
}

/**
 * Windows file-handle teardown lag — see `@iroha/storage`'s
 * `test-helpers/tmp-db.ts` for the reproduction. Tests in this package open
 * and close real libSQL connections (via `initRepository`/`runInit`/etc.)
 * inside the directory this removes, so it needs the same bounded retry.
 */
export async function removeTempDir(dir: string): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
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
