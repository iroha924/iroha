/** Hook context is capped well below Codex's ~2,500-token limit (hooks-contract.md §9, §12). */
const MAX_CONTEXT_CHARS = 8000;

export interface RecentCheckpoint {
  id: string;
  summary: string;
  unresolved?: string;
}

export interface SessionContextInput {
  token: string;
  sessionId: string;
  runId: string;
  recentCheckpoint?: RecentCheckpoint;
}

/**
 * Render the SessionStart context block (hooks-contract.md §9): the session
 * token and IDs, an optional recent checkpoint, and the MCP instruction. IDs and
 * provenance stay visible; the text states repository facts, never a
 * higher-priority command. The result is bounded to {@link MAX_CONTEXT_CHARS}.
 *
 * The "Applicable approved knowledge" section is intentionally not populated
 * here: approved-knowledge retrieval (relevance ranking, scope matching) is
 * WP-08's search layer, which this hook does not run. Until then the context
 * carries the session anchor and the checkpoint instruction only.
 */
export function formatSessionContext(input: SessionContextInput): string {
  const lines = [
    "[iroha]",
    `session_token: ${input.token}`,
    `session: ${input.sessionId}`,
    `run: ${input.runId}`,
  ];

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
