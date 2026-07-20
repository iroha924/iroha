/** Hook context is capped well below Codex's ~2,500-token limit (hooks-contract.md §9, §12). */
const MAX_CONTEXT_CHARS = 8000;

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
  approvedKnowledge?: ApprovedKnowledgeItem[];
  recentCheckpoint?: RecentCheckpoint;
}

/**
 * Render the SessionStart context block (hooks-contract.md §9): the session
 * token and IDs, the applicable approved knowledge, an optional recent
 * checkpoint, and the MCP instruction. IDs and provenance stay visible; the
 * text states repository facts, never a higher-priority command. The result is
 * bounded to {@link MAX_CONTEXT_CHARS}.
 *
 * The "Applicable approved knowledge" section is built from approved Rules only
 * — a direct, lexical listing with no remote embedding (ID-014 forbids remote
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

  lines.push(
    "",
    "Use the iroha MCP search tool for full sources. Create a checkpoint after meaningful work.",
    "[/iroha]",
  );

  const text = lines.join("\n");
  return text.length > MAX_CONTEXT_CHARS ? text.slice(0, MAX_CONTEXT_CHARS) : text;
}
