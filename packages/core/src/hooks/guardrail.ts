import type { TypedId } from "@iroha/domain";
import type { ToolTarget } from "@iroha/platform";
import { type ActiveRuleRow, type Database, listApprovedRulesForRepository } from "@iroha/storage";
import { pathMatches } from "../mcp/ranking.js";

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
    const paths = toStringArray(parsed.paths);
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
        isProtectedMutation(target) && guard.paths.some((glob) => pathMatches(glob, target.value)),
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
      if (guard.paths.some((glob) => pathMatches(glob, path))) {
        violations.push({ ruleId: rule.id, path });
      }
    }
  }
  return violations;
}
