import type { TypedId } from "@iroha/domain";
import type { ToolTarget } from "@iroha/platform";
import { type ActiveRuleRow, type Database, listApprovedRulesForRepository } from "@iroha/storage";
import picomatch from "picomatch";

const GUARD_MATCH_OPTIONS = { dot: true, windows: false } as const;

/**
 * Match a guard-protected `guard.paths` glob against an already-canonicalized,
 * repo-relative POSIX target path (the Hook feeds realpath-resolved paths via
 * `resolveTargets`; CI callers pass normalized diff paths). Full glob semantics
 * via `picomatch` — a pure, ReDoS-resistant, string-only matcher that never
 * touches the filesystem, so it does not re-introduce the "fold `..` before
 * resolving symlinks" hazard (path-and-symlink-safety.md).
 *
 * A guard path protects the path itself AND its whole subtree, so a
 * bare-directory or single-star entry still protects the files under it — the
 * safe, least-surprising semantics for a protect-from-writes matcher, and it
 * preserves the pre-picomatch behavior (a bare `src/generated` guard covered
 * `src/generated/client.ts`). That is the `glob` OR `glob/**` test below.
 *
 * Options: `dot: true` is mandatory for a security matcher — without it a
 * globstar would skip dotfiles (a root `.env`, anything under `.github` or
 * `.iroha`). `windows: false` keeps matching POSIX-deterministic regardless of
 * host OS, since targets and guard paths are always repo-relative POSIX strings.
 * Unlike the simplified prefix matcher in `ranking.ts` (search scope only), this
 * correctly handles a leading globstar, a mid-path globstar, and an extension
 * glob — the shapes whose silent no-op was the enforcement bypass this fixes.
 */
function guardPathMatches(glob: string, target: string): boolean {
  const subtree = `${glob.replace(/\/+$/, "")}/**`;
  return (
    picomatch.isMatch(target, glob, GUARD_MATCH_OPTIONS) ||
    picomatch.isMatch(target, subtree, GUARD_MATCH_OPTIONS)
  );
}

export interface GuardrailDenial {
  ruleId: string;
  reason: string;
  /** The target that triggered the denial — recorded on the denied Tool Event. */
  target: ToolTarget;
}

interface GuardSpec {
  tools: string[];
  paths: string[];
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Parse a stored guard spec (`knowledge_items.guard_spec_json`, written from the
 * Zod-validated canonical `rule.guard`). Returns null on any malformed shape or
 * empty `tools` (canonical `guard.tools` is min 1) so a corrupt spec is skipped
 * rather than blocking a tool — the per-rule half of the fail-open guarantee
 * (hooks-contract.md §6.3 / §7).
 */
function parseGuardSpec(json: string): GuardSpec | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const tools = toStringArray(parsed.tools);
    // Drop blank/whitespace-only path entries: they match nothing, so a guard
    // whose only paths are blank protects nothing — it must not read as
    // `enforceable` in `iroha doctor` (that was the false-healthy signal).
    const paths = toStringArray(parsed.paths).filter((path) => path.trim().length > 0);
    return tools.length > 0 ? { tools, paths } : null;
  } catch {
    return null;
  }
}

/**
 * A target the hook can gate: a write/delete to a file/path. The adapters
 * classify every file-write tool (Claude Edit/Write/MultiEdit/NotebookEdit,
 * Codex apply_patch) to `operation: "write"`/`"delete"`, and reads to
 * `"read"` — so keying on the normalized operation, not the tool name, is what
 * "normalize tool name" (hooks-contract.md §6.3 step 1) means here and closes
 * the bypass where a write tool the guard did not enumerate slips through.
 */
function isProtectedMutation(target: ToolTarget): boolean {
  return (
    (target.kind === "file" || target.kind === "path") &&
    (target.operation === "write" || target.operation === "delete")
  );
}

/**
 * Evaluate approved Guardrails against a tool use (hooks-contract.md §6.3): deny
 * the first Guardrail whose protected `guard.paths` glob covers a written/deleted
 * file target. Tool-agnostic by design (decision-log ID-036): `guard.tools` is
 * retained as author intent but path protection keys on the target operation, so
 * no write tool can bypass it. Pure and deterministic; a rule whose spec fails to
 * parse, or which protects no paths, is skipped (fail-open).
 */
export function evaluateGuardrails(
  rules: readonly ActiveRuleRow[],
  targets: readonly ToolTarget[],
): GuardrailDenial | null {
  for (const rule of rules) {
    if (rule.enforcement !== "guardrail" || rule.guardSpecJson === null) {
      continue;
    }
    const guard = parseGuardSpec(rule.guardSpecJson);
    if (guard === null || guard.paths.length === 0) {
      continue;
    }
    const match = targets.find(
      (target) =>
        isProtectedMutation(target) &&
        guard.paths.some((glob) => guardPathMatches(glob, target.value)),
    );
    if (match !== undefined) {
      return { ruleId: rule.id, reason: rule.summary ?? rule.title, target: match };
    }
  }
  return null;
}

/**
 * Fetch approved Guardrails and evaluate them on the Hook path. Fail-open on a
 * query error (returns no denial): an internal failure never blocks the agent
 * (hooks-contract.md §7 — CI is the hard enforcement layer).
 */
export async function evaluateActiveGuardrails(
  db: Database,
  repositoryId: TypedId<"repo">,
  targets: readonly ToolTarget[],
): Promise<GuardrailDenial | null> {
  const listed = await listApprovedRulesForRepository(db, repositoryId);
  if (!listed.ok) {
    return null;
  }
  return evaluateGuardrails(listed.value, targets);
}

export type GuardEnforceability = "enforceable" | "not_hook_enforceable" | "invalid";

/**
 * Classify a stored guard spec for `iroha doctor` (vertical-slice.md §4):
 * `enforceable` (parses and protects at least one path), `not_hook_enforceable`
 * (parses but names no paths — a command/`deny_commands`-scoped Guardrail the
 * Hook cannot enforce, since the raw command is not available post-classification
 * per hooks-contract.md §8; CI is the hard enforcement layer), or `invalid`
 * (missing / malformed / empty `tools`). Reporting `not_hook_enforceable` and
 * `invalid` as warnings prevents a silent no-op Guardrail from reading as healthy.
 */
export function classifyGuardSpec(guardSpecJson: string | null): GuardEnforceability {
  if (guardSpecJson === null) {
    return "invalid";
  }
  const guard = parseGuardSpec(guardSpecJson);
  if (guard === null) {
    return "invalid";
  }
  return guard.paths.length > 0 ? "enforceable" : "not_hook_enforceable";
}

export interface GuardrailPathViolation {
  ruleId: string;
  path: string;
}

/**
 * Evaluate approved Guardrails against a set of changed paths, independent of any
 * tool — the deterministic check a CI job runs over a PR diff (vertical-slice.md
 * §4: "CI fixture independently enforces the generated-file rule"). Any changed
 * path under a Guardrail's protected `guard.paths` is a violation. Shares the
 * spec parsing and glob matching with the Hook path; the two can still differ on
 * their inputs (the Hook feeds realpath-resolved, repo-relative POSIX paths,
 * while a caller here supplies raw diff paths), so callers must pass normalized
 * repo-relative paths. `deny_commands` is not evaluated (ID-036).
 */
export function guardrailPathViolations(
  rules: readonly ActiveRuleRow[],
  changedPaths: readonly string[],
): GuardrailPathViolation[] {
  const violations: GuardrailPathViolation[] = [];
  for (const rule of rules) {
    if (rule.enforcement !== "guardrail" || rule.guardSpecJson === null) {
      continue;
    }
    const guard = parseGuardSpec(rule.guardSpecJson);
    if (guard === null) {
      continue;
    }
    for (const path of changedPaths) {
      if (guard.paths.some((glob) => guardPathMatches(glob, path))) {
        violations.push({ ruleId: rule.id, path });
      }
    }
  }
  return violations;
}
