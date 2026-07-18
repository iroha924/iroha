import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { err, IrohaError, ok, type Result } from "@iroha/domain";

/** Matches the SYMLOOP_MAX most platforms enforce for genuine symlink chains. */
const MAX_SYMLINK_DEPTH = 40;

/**
 * Resolves symlinks like `fs.realpath`, but tolerates a target that does not
 * exist yet (e.g. a file about to be written, or a `git rev-parse --git-path`
 * output for a namespace directory Git has not created). Walks up to the
 * nearest existing ancestor, resolves that, then rejoins the remaining
 * segments verbatim.
 *
 * A path component that fails to resolve is *itself* checked for being a
 * dangling symlink (exists, but its target does not). Such a link is still
 * followed via `readlink` rather than treated as a literal missing path —
 * otherwise a symlink pointing outside the repository to a not-yet-created
 * file would resolve as if it were an ordinary in-repo path, silently
 * defeating symlink-escape checks in `toRepoRelativePath`.
 */
export async function safeRealpath(targetPath: string, depth = 0): Promise<string> {
  const resolved = resolve(targetPath);
  try {
    return await realpath(resolved);
  } catch {
    const stat = await lstat(resolved).catch(() => undefined);
    if (stat?.isSymbolicLink()) {
      if (depth >= MAX_SYMLINK_DEPTH) {
        throw new Error(`Too many levels of symbolic links resolving ${targetPath}`);
      }
      const linkTarget = await readlink(resolved);
      const absoluteLinkTarget = isAbsolute(linkTarget)
        ? linkTarget
        : resolve(dirname(resolved), linkTarget);
      return safeRealpath(absoluteLinkTarget, depth + 1);
    }

    const parent = dirname(resolved);
    if (parent === resolved) {
      return resolved;
    }
    const realParent = await safeRealpath(parent, depth);
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
  const absoluteTarget = isAbsolute(targetPath) ? targetPath : resolve(root, targetPath);
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await safeRealpath(root);
    realTarget = await safeRealpath(absoluteTarget);
  } catch (cause) {
    return err(
      new IrohaError("INVALID_INPUT", `Failed to resolve path: ${targetPath}`, {
        cause,
        details: { root, targetPath },
      }),
    );
  }

  const rel = relative(realRoot, realTarget);
  if (rel === "") {
    return ok("");
  }
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return err(
      new IrohaError("INVALID_INPUT", `Path escapes repository root: ${targetPath}`, {
        details: { root, targetPath },
      }),
    );
  }
  return ok(rel.split(sep).join("/"));
}
