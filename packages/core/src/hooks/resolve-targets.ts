import { isAbsolute, sep } from "node:path";
import { toRepoRelativePath } from "@iroha/git";
import type { ToolTarget } from "@iroha/platform";

/**
 * Resolve a tool event's targets to repository-relative form.
 *
 * A relative `file`/`path` value is interpreted relative to the agent's `cwd`
 * (which may be a subdirectory of the repository), not the repository root —
 * an `apply_patch` or `Glob`/`Grep` path an agent emits from a subdirectory is
 * cwd-relative, so resolving it against the root would name the wrong file. The
 * value is then rewritten to a POSIX repo-relative path via a symlink-safe check
 * (`@iroha/git`); a target that resolves outside the repository (`..` traversal
 * or a symlink escaping the root) is dropped rather than persisted with an
 * absolute or out-of-repo path (hooks-contract.md §8 / privacy rules).
 * `command`/`mcp`/`other` targets carry no filesystem path and pass through
 * unchanged.
 *
 * The relative value is joined to `cwd` by plain string concatenation, never
 * `path.join`/`resolve`/`normalize` — those fold `..` lexically before symlinks
 * are resolved. `toRepoRelativePath` (via `safeRealpath`) resolves segment by
 * segment, so any `..` in the value is applied *after* symlinks, preserving the
 * path-safety invariant (.claude/rules/path-and-symlink-safety.md).
 */
export async function resolveTargets(
  targets: readonly ToolTarget[],
  repoRoot: string,
  cwd: string,
): Promise<ToolTarget[]> {
  const resolved: ToolTarget[] = [];
  for (const target of targets) {
    if (target.kind !== "file" && target.kind !== "path") {
      resolved.push(target);
      continue;
    }
    const absolute = isAbsolute(target.value) ? target.value : `${cwd}${sep}${target.value}`;
    const rel = await toRepoRelativePath(repoRoot, absolute);
    if (rel.ok && rel.value.length > 0) {
      resolved.push({ ...target, value: rel.value });
    }
  }
  return resolved;
}
