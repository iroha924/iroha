import { toRepoRelativePath } from "@iroha/git";
import type { ToolTarget } from "@iroha/platform";

/**
 * Resolve a tool event's targets to repository-relative form. `file`/`path`
 * targets are rewritten to a POSIX repo-relative value via a symlink-safe check
 * (`@iroha/git`); a target that resolves outside the repository — `..`
 * traversal or a symlink escaping the root — is dropped rather than persisted
 * with an absolute or out-of-repo path (hooks-contract.md §8 and the privacy
 * rules forbid storing absolute paths). `command`/`mcp`/`other` targets carry
 * no filesystem path and pass through unchanged.
 */
export async function resolveTargets(
  targets: readonly ToolTarget[],
  repoRoot: string,
): Promise<ToolTarget[]> {
  const resolved: ToolTarget[] = [];
  for (const target of targets) {
    if (target.kind !== "file" && target.kind !== "path") {
      resolved.push(target);
      continue;
    }
    const rel = await toRepoRelativePath(repoRoot, target.value);
    if (rel.ok && rel.value.length > 0) {
      resolved.push({ ...target, value: rel.value });
    }
  }
  return resolved;
}
