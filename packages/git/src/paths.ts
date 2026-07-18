import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, sep } from "node:path";
import { err, IrohaError, ok, type Result } from "@iroha/domain";

/** Matches the SYMLOOP_MAX most platforms enforce for genuine symlink chains. */
const MAX_SYMLINK_DEPTH = 40;

const IS_WINDOWS = process.platform === "win32";
// POSIX allows a literal backslash in a filename (round-6 finding: a naive
// splitter must not treat `\` as a separator there), but Windows accepts
// both `/` and `\` as separators — so which characters split a path is
// itself platform-dependent, matching `node:path`'s own platform-native
// behavior used everywhere else in this module.
const SEGMENT_SPLIT = IS_WINDOWS ? /[\\/]+/ : /\//;

function splitSegments(pathWithoutRoot: string): string[] {
  return pathWithoutRoot.split(SEGMENT_SPLIT).filter((segment) => segment.length > 0);
}

/**
 * Walks `segments` one at a time starting from `base` (an already-resolved,
 * symlink-free absolute path), applying each in turn:
 *
 * - `..` moves up via `dirname()` on our own already-resolved `current` —
 *   pure JS bookkeeping, no filesystem call.
 * - an ordinary name that resolves to a symlink is dereferenced (via
 *   `readlink`, recursing on the link's own target — which may itself embed
 *   further `..` or symlinks) instead of being appended literally.
 * - an ordinary name that exists and is not a symlink is canonicalized via
 *   `fs.realpath()` on the single-segment-extended path (safe: by this
 *   point the string has no unresolved symlink or ".." left in it), which
 *   also normalizes Windows 8.3 short filenames and drive-letter/path
 *   casing (confirmed by an actual windows-2025 CI failure when an earlier
 *   version of this function skipped that step).
 * - a name that doesn't exist yet is appended literally, tolerating a
 *   target that isn't on disk yet (e.g. a file about to be written, or a
 *   `git rev-parse --git-path` output for a namespace directory Git hasn't
 *   created).
 *
 * Never hands the OS a single string containing both `..` and a
 * not-yet-resolved symlink: confirmed by an actual windows-2025 CI failure
 * that Windows path canonicalization collapses `..` lexically *before* the
 * filesystem driver resolves a reparse point (symlink) earlier in the same
 * string — the reverse of POSIX `realpath(3)`, which resolves symlinks
 * component by component *before* applying `..`. Resolving one segment at a
 * time and applying `..` ourselves (rather than delegating a
 * multi-segment string to a single `fs.realpath()` call) sidesteps that
 * platform difference instead of relying on it.
 */
async function resolveFrom(
  base: string,
  segments: readonly string[],
  depth: number,
): Promise<string> {
  if (depth > MAX_SYMLINK_DEPTH) {
    throw new Error("Too many levels of symbolic links");
  }

  let current = base;
  for (const segment of segments) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      current = dirname(current);
      continue;
    }

    const candidate = `${current}${sep}${segment}`;
    const stat = await lstat(candidate).catch(() => undefined);
    if (stat === undefined) {
      current = candidate;
      continue;
    }
    if (stat.isSymbolicLink()) {
      const linkTarget = await readlink(candidate);
      if (isAbsolute(linkTarget)) {
        const linkRoot = parse(linkTarget).root;
        current = await resolveFrom(
          await realpath(linkRoot),
          splitSegments(linkTarget.slice(linkRoot.length)),
          depth + 1,
        );
      } else {
        current = await resolveFrom(current, splitSegments(linkTarget), depth + 1);
      }
      continue;
    }
    current = await realpath(candidate);
  }
  return current;
}

/**
 * Resolves symlinks and `..` in `targetPath`, tolerating a target that does
 * not exist yet. See `resolveFrom` for why this walks one segment at a time
 * instead of delegating to a single `fs.realpath()` call.
 */
export async function safeRealpath(targetPath: string): Promise<string> {
  const absolute = isAbsolute(targetPath) ? targetPath : `${process.cwd()}${sep}${targetPath}`;
  const root = parse(absolute).root;
  const realRoot = await realpath(root);
  return resolveFrom(realRoot, splitSegments(absolute.slice(root.length)), 0);
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
