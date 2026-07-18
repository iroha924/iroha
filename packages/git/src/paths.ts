import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import { err, IrohaError, ok, type Result } from "@iroha/domain";

/** Matches the SYMLOOP_MAX most platforms enforce for genuine symlink chains. */
const MAX_SYMLINK_DEPTH = 40;

/**
 * Resolves symlinks, tolerating a target that does not exist yet (e.g. a
 * file about to be written, or a `git rev-parse --git-path` output for a
 * namespace directory Git has not created).
 *
 * Delegates to `fs.realpath()` as the fast path rather than re-implementing
 * path resolution: POSIX `realpath(3)` (and Node's own implementation,
 * confirmed against `lib/fs.js`) already resolves symlinks component by
 * component *before* applying `..`, so it correctly handles `..` embedded
 * anywhere in `targetPath` — including after a symlink — as long as the
 * raw, uncollapsed string reaches it. `fs.realpath()` also canonicalizes
 * Windows 8.3 short filenames, which a from-scratch reimplementation must
 * remember to do and previously didn't (confirmed by an actual windows-2025
 * CI failure).
 *
 * `fs.realpath()` only requires the *whole* path to resolve, so the sole
 * case handled here by hand is a target that doesn't fully exist yet: walk
 * up to the nearest ancestor that does resolve (recursively, since an
 * ancestor can itself be missing or a dangling symlink), then rejoin the
 * unresolved tail literally. A component that fails to resolve is checked
 * for being a dangling symlink (exists, but its target does not) and, if
 * so, is still followed via `readlink` rather than treated as literal —
 * otherwise a symlink pointing outside the repository to a not-yet-created
 * file would resolve as an ordinary in-repo path, defeating the
 * symlink-escape checks in `toRepoRelativePath`.
 */
export async function safeRealpath(targetPath: string, depth = 0): Promise<string> {
  if (depth > MAX_SYMLINK_DEPTH) {
    throw new Error(`Too many levels of symbolic links resolving ${targetPath}`);
  }

  // Concatenation, not `path.resolve`/`path.join`: both lexically collapse
  // ".." before any symlink in the string is considered. The raw string
  // must reach `fs.realpath()`/`fs.lstat()` unmodified so the kernel (not
  // JS string logic) resolves ".." against the real, symlink-dereferenced
  // location — see the docstring above.
  const absolute = isAbsolute(targetPath) ? targetPath : `${process.cwd()}${sep}${targetPath}`;

  try {
    return await realpath(absolute);
  } catch {
    const stat = await lstat(absolute).catch(() => undefined);
    if (stat?.isSymbolicLink()) {
      if (depth >= MAX_SYMLINK_DEPTH) {
        throw new Error(`Too many levels of symbolic links resolving ${targetPath}`);
      }
      const linkTarget = await readlink(absolute);
      const absoluteLinkTarget = isAbsolute(linkTarget)
        ? linkTarget
        : `${dirname(absolute)}${sep}${linkTarget}`;
      return safeRealpath(absoluteLinkTarget, depth + 1);
    }

    const parent = dirname(absolute);
    if (parent === absolute) {
      return absolute;
    }
    const realParent = await safeRealpath(parent, depth);
    return `${realParent}${sep}${basename(absolute)}`;
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
  // Plain concatenation, not `path.join`/`path.resolve`: both of those
  // lexically collapse `..` before `safeRealpath` ever sees it, which is
  // exactly the bug this function exists to avoid (see `safeRealpath`'s
  // docstring) — the raw, uncollapsed string must reach `safeRealpath` so
  // it can walk `..` symlink-aware, one segment at a time.
  const absoluteTarget = isAbsolute(targetPath) ? targetPath : `${root}${sep}${targetPath}`;
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await safeRealpath(root);
    realTarget = await safeRealpath(absoluteTarget);
  } catch (cause) {
    // No `root`/`targetPath` in message or details: mcp-contract.md §8
    // forbids returning filesystem absolute paths to the model, and this
    // error can reach an MCP response as-is.
    return err(new IrohaError("INVALID_INPUT", "Failed to resolve path", { cause }));
  }

  const rel = relative(realRoot, realTarget);
  if (rel === "") {
    return ok("");
  }
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return err(new IrohaError("INVALID_INPUT", "Path escapes repository root"));
  }
  return ok(rel.split(sep).join("/"));
}
