import type { RepositoryConfig } from "@iroha/config";

/** Hook context is capped well below Codex's ~2,500-token limit (contracts/hooks.md §9, §12). */
const MAX_CONTEXT_CHARS = 8000;

/**
 * Keyed by the config enum so adding a locale fails to compile here rather than
 * silently falling back to one of these.
 */
const KNOWLEDGE_LANGUAGE_NAMES: Record<RepositoryConfig["default_language"], string> = {
  ja: "Japanese",
  en: "English",
};

/**
 * Per-locale reminder to re-read drafted prose before writing it. A Checkpoint's
 * `summary` is stored with no approval step and is read back by a later session
 * (`mcp/get-session-state.ts`), so the write is the last point anything can
 * catch unnatural prose — and judging naturalness is something only the agent
 * re-reading it can do, not a check iroha could ship (a morphological
 * dictionary is 8-18x the whole published package, and no pattern set decides
 * whether a phrase is idiomatic).
 *
 * `ja` only: the class that motivated this is wrong-kanji substitution inside a
 * 漢語 compound, which yields a non-word with no English analogue. Keyed like
 * {@link KNOWLEDGE_LANGUAGE_NAMES} so a new locale has to decide rather than
 * inherit silently.
 */
const PROSE_REREAD_LINES: Record<RepositoryConfig["default_language"], string | null> = {
  ja: "Before saving, check that Japanese in separate reads — non-words, calques, unnatural collocation, invented terminology, padding — and fix what a native speaker would not write (see the `checkpoint` skill).",
  en: null,
};

export interface RecentCheckpoint {
  id: string;
  summary: string;
  unresolved?: string;
}

export interface ApprovedKnowledgeItem {
  id: string;
  title: string;
  summary: string;
  /** Short provenance shown in parentheses, e.g. "why: path src/payments/**". */
  provenance: string;
}

export interface SessionContextInput {
  token: string;
  sessionId: string;
  runId: string;
  /**
   * The repository's `default_language`. Candidate content follows it rather
   * than the session's own language (#164), and the agent only learns which one
   * from this block.
   */
  knowledgeLanguage: RepositoryConfig["default_language"];
  approvedKnowledge?: ApprovedKnowledgeItem[];
  recentCheckpoint?: RecentCheckpoint;
}

/**
 * Render the SessionStart context block (contracts/hooks.md §9): the session
 * token and IDs, the applicable approved knowledge, an optional recent
 * checkpoint, and the MCP instruction. IDs and provenance stay visible; the
 * text states repository facts, never a higher-priority command. The result is
 * bounded to {@link MAX_CONTEXT_CHARS}.
 *
 * The "Applicable approved knowledge" section is built from approved Rules only
 * — a direct, lexical listing with no remote embedding (a hook makes no remote
 * calls in hooks). Full query-driven vector retrieval stays in the MCP `search`/
 * `get_context` tools, which the agent calls explicitly.
 */
export function formatSessionContext(input: SessionContextInput): string {
  const lines = [
    "[iroha]",
    `session_token: ${input.token}`,
    `session: ${input.sessionId}`,
    `run: ${input.runId}`,
  ];

  if (input.approvedKnowledge !== undefined && input.approvedKnowledge.length > 0) {
    lines.push("", "Applicable approved knowledge:");
    for (const item of input.approvedKnowledge) {
      lines.push(`- ${item.id} ${item.title} — ${item.summary} (${item.provenance})`);
    }
  }

  if (input.recentCheckpoint) {
    lines.push("", "Recent checkpoint:");
    lines.push(`- ${input.recentCheckpoint.id} — ${input.recentCheckpoint.summary}`);
    if (input.recentCheckpoint.unresolved) {
      lines.push(`  unresolved: ${input.recentCheckpoint.unresolved}`);
    }
  }

  // The footer is reserved out of the budget and appended after truncation, not
  // pushed onto `lines`. Ten approved rules with 1,000-character summaries reach
  // the cap on their own, and trimming from the end took the closing tag and the
  // content-language line §9 requires on every SessionStart.
  const reread = PROSE_REREAD_LINES[input.knowledgeLanguage];
  const footer = [
    "",
    "Use the iroha MCP search tool for full sources. Create a checkpoint after meaningful work.",
    `Write checkpoint and proposal content in ${KNOWLEDGE_LANGUAGE_NAMES[input.knowledgeLanguage]} (config.default_language), whatever language this session is in.`,
    ...(reread === null ? [] : [reread]),
    "[/iroha]",
  ].join("\n");

  const body = lines.join("\n");
  const budget = MAX_CONTEXT_CHARS - footer.length;
  return (body.length > budget ? body.slice(0, budget) : body) + footer;
}
