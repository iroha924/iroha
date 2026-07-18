import { lstat, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { err, IrohaError, ok, type Result } from "@iroha/domain";

/** Matches the SYMLOOP_MAX most platforms enforce for genuine symlink chains. */
const MAX_SYMLINK_DEPTH = 40;

/**
 * Resolves symlinks component by component, tolerating a target that does
 * not exist yet (e.g. a file about to be written, or a `git rev-parse
 * --git-path` output for a namespace directory Git has not created).
 *
 * Deliberately does *not* use `path.resolve`/`path.normalize` internally:
 * those lexically collapse `..` segments before consulting the filesystem,
 * so a path like `link/../secret.txt` — where `link` is a symlink to
 * `/tmp/out` — would cancel down to the literal parent directory instead of
 * going up from `/tmp/out`, silently defeating symlink-escape checks in
 * `toRepoRelativePath` for any caller that walks up out of a symlinked
 * directory. Each segment is checked against the filesystem in order: a
 * symlink is dereferenced (recursively, since its target can itself contain
 * more symlinks or need further resolution) before the *next* segment —
 * including `..` — is applied, so `..` always walks up from the real
 * location a symlink pointed to, never from its nominal one.
 */
export async function safeRealpath(targetPath: string, depth = 0): Promise<string> {
  if (depth > MAX_SYMLINK_DEPTH) {
    throw new Error(`Too many levels of symbolic links resolving ${targetPath}`);
  }

  // Concatenation, not `path.join` (which would collapse ".." here too):
  // see the class-level docstring above.
  const absolute = isAbsolute(targetPath) ? targetPath : `${process.cwd()}${sep}${targetPath}`;
  const { root } = parse(absolute);
  const segments = absolute
    .slice(root.length)
    .split(/[/\\]/)
    .filter((segment) => segment.length > 0 && segment !== ".");

  let current = root;
  for (const segment of segments) {
    if (segment === "..") {
      current = dirname(current);
      continue;
    }

    const candidate = join(current, segment);
    const stat = await lstat(candidate).catch(() => undefined);
    if (stat === undefined) {
      // Does not exist yet — keep it (and everything after it) literal.
      current = candidate;
      continue;
    }
    if (stat.isSymbolicLink()) {
      const linkTarget = await readlink(candidate);
      const absoluteLinkTarget = isAbsolute(linkTarget)
        ? linkTarget
        : join(dirname(candidate), linkTarget);
      current = await safeRealpath(absoluteLinkTarget, depth + 1);
    } else {
      current = candidate;
    }
  }
  return current;
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
