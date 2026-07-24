import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { err, ok } from "@iroha/domain";
import { listApprovedRulesForRepository } from "@iroha/storage";
import { pathMatches } from "./ranking.js";
import { withMcpRepository } from "./with-repository.js";

export interface McpRuleScope {
  paths: string[];
  symbols: string[];
  languages: string[];
}

export interface McpActiveRule {
  id: string;
  enforcement: "advisory" | "guardrail";
  severity: "info" | "warning" | "error" | null;
  scope: McpRuleScope;
  explanation: string;
}

export interface McpActiveRulesData {
  rules: McpActiveRule[];
}

export interface McpGetActiveRulesInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  repositoryPath?: string | undefined;
  paths?: string[] | undefined;
  symbols?: string[] | undefined;
  includeAdvisory?: boolean | undefined;
  includeGuardrails?: boolean | undefined;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseScope(scopeJson: string): McpRuleScope {
  try {
    const parsed = JSON.parse(scopeJson) as Record<string, unknown>;
    return {
      paths: toStringArray(parsed.paths),
      symbols: toStringArray(parsed.symbols),
      languages: toStringArray(parsed.languages),
    };
  } catch {
    return { paths: [], symbols: [], languages: [] };
  }
}

function applies(scope: McpRuleScope, paths: string[], symbols: string[]): boolean {
  if (paths.length === 0 && symbols.length === 0) {
    return true;
  }
  if (scope.paths.length === 0) {
    return true; // a rule with no path scope applies repository-wide
  }
  const pathHit = paths.some((p) => scope.paths.some((rp) => pathMatches(rp, p)));
  const symbolHit = symbols.some((s) => scope.symbols.includes(s));
  return pathHit || symbolHit;
}

/**
 * Returns the approved Rules/Guardrails applicable to the requested targets
 * (mcp-contract.md §6.3), distinguishing advisory from guardrail enforcement.
 * Raw guard specs are not returned (they are only for the local Hook adapter),
 * and guardrail *evaluation* is deferred until a guard-spec schema exists
 * (decision-log ID-024(6)/ID-028(l)). Scope matching uses simplified prefix
 * globbing — surfaced as a tool warning when paths/symbols are supplied.
 */
export async function mcpGetActiveRules(
  input: McpGetActiveRulesInput,
): Promise<Result<McpActiveRulesData, IrohaError>> {
  return withMcpRepository(
    { cwd: input.repositoryPath ?? input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const listed = await listApprovedRulesForRepository(ctx.db, ctx.repo.repositoryId);
      if (!listed.ok) {
        return err(listed.error);
      }

      const paths = input.paths ?? [];
      const symbols = input.symbols ?? [];
      const includeAdvisory = input.includeAdvisory ?? true;
      const includeGuardrails = input.includeGuardrails ?? true;

      const rules: McpActiveRule[] = [];
      for (const row of listed.value) {
        if (row.enforcement === "advisory" && !includeAdvisory) {
          continue;
        }
        if (row.enforcement === "guardrail" && !includeGuardrails) {
          continue;
        }
        const scope = parseScope(row.scopeJson);
        if (!applies(scope, paths, symbols)) {
          continue;
        }
        rules.push({
          id: row.id,
          enforcement: row.enforcement,
          severity: row.severity,
          scope,
          explanation: row.summary ?? row.title,
        });
      }

      return ok({ rules });
    },
  );
}
