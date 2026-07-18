import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { err, IrohaError, ok, type Result } from "@iroha/domain";

/**
 * Resolves symlinks like `fs.realpath`, but tolerates a target that does not
 * exist yet (e.g. a file about to be written, or a `git rev-parse --git-path`
 * output for a namespace directory Git has not created). Walks up to the
 * nearest existing ancestor, resolves that, then rejoins the remaining
 * segments verbatim.
 */
export async function safeRealpath(targetPath: string): Promise<string> {
  const resolved = resolve(targetPath);
  try {
    return await realpath(resolved);
  } catch {
    const parent = dirname(resolved);
    if (parent === resolved) {
      return resolved;
    }
    const realParent = await safeRealpath(parent);
    return resolve(realParent, basename(resolved));
  }
}

/**
 * Resolves `targetPath` to a path relative to `root`, rejecting anything that
 * escapes `root` after symlinks are resolved on both sides — this catches
 * both `../..`-style traversal and a symlink inside the repository that
 * points outside it.
 */
export async function toRepoRelativePath(
  root: string,
  targetPath: string,
): Promise<Result<string, IrohaError>> {
  const realRoot = await safeRealpath(root);
  const absoluteTarget = isAbsolute(targetPath) ? targetPath : resolve(root, targetPath);
  const realTarget = await safeRealpath(absoluteTarget);

  const rel = relative(realRoot, realTarget);
  if (rel === "") {
    return ok("");
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return err(
      new IrohaError("INVALID_INPUT", `Path escapes repository root: ${targetPath}`, {
        details: { root, targetPath },
      }),
    );
  }
  return ok(rel.split(sep).join("/"));
}
