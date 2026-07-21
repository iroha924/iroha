import { writeCanonicalDocument } from "@iroha/canonical";
import { runSync } from "@iroha/core";
import { makeTypedId } from "@iroha/domain";
import { MIGRATIONS_DIR, type SliceRepo } from "./slice-repo.js";

export interface SeededRule {
  id: string;
  title: string;
}

interface SeedRuleOptions {
  /** When true, an enforceable Guardrail (guard over Edit/Write × src/generated/**). */
  guardrail?: boolean;
}

const FIXED_TS = "2026-01-01T00:00:00.000Z";
const GENERATED_GLOB = "src/generated/**";

/**
 * Writes an approved "do not edit generated files" Rule into the repo's
 * canonical `.iroha/rules/` directory (as a teammate would have committed it)
 * and syncs it into the local index, so it appears as approved knowledge at
 * SessionStart and — when `guardrail` — as an enforceable Guardrail.
 */
export async function seedApprovedGeneratedFilesRule(
  repo: SliceRepo,
  options: SeedRuleOptions = {},
): Promise<SeededRule> {
  const id = makeTypedId("rul", repo.clock, repo.random);
  const title = "Do not edit generated files";
  const rule = options.guardrail
    ? {
        enforcement: "guardrail" as const,
        severity: "error" as const,
        guard: { tools: ["Edit", "Write"], paths: [GENERATED_GLOB] },
      }
    : { enforcement: "advisory" as const, severity: "warning" as const };

  const candidate = {
    frontmatter: {
      schema_version: 1,
      id,
      type: "rule",
      title,
      status: "approved",
      revision: 1,
      created_at: FIXED_TS,
      updated_at: FIXED_TS,
      created_by: { provider: "git", display_name: "Example Reviewer" },
      approved_by: { provider: "git", display_name: "Example Reviewer" },
      approved_at: FIXED_TS,
      labels: [],
      scope: { repository: repo.resolved.repositoryId, paths: [GENERATED_GLOB], symbols: [] },
      sources: [{ type: "url", ref: "https://example.com/conventions" }],
      relations: [],
      rule,
    },
    body: [
      `# ${title}`,
      "## Rule",
      "",
      "Do not edit files under src/generated/** by hand.",
      "## Scope",
      "",
      "Applies to generated client code.",
      "## Rationale",
      "",
      "Generated files are overwritten on the next build.",
      "## Examples",
      "",
      "Regenerate instead of editing.",
      "## Exceptions",
      "",
      "None.",
    ].join("\n\n"),
  };

  const written = await writeCanonicalDocument(
    candidate,
    repo.resolved.irohaCanonicalDir,
    repo.random,
  );
  if (!written.ok) {
    throw new Error(`seed rule write failed: ${written.error.code}: ${written.error.message}`);
  }
  const synced = await runSync(repo.repoDir, MIGRATIONS_DIR);
  if (!synced.ok) {
    throw new Error(`seed rule sync failed: ${synced.error.code}: ${synced.error.message}`);
  }
  return { id, title };
}
