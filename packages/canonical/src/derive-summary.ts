import { fromMarkdown } from "mdast-util-from-markdown";
import { toString as mdastToString } from "mdast-util-to-string";

/**
 * Sentence terminators worth cutting at, Latin and CJK. `。`/`！`/`？` are the
 * CJK forms; a document written in Japanese has no ASCII period to find.
 */
const SENTENCE_END = /[.!?。！？](?=\s|$)|[。！？]/gu;

/**
 * How long a derived summary may be. The value is the search and context tools'
 * own limit (contracts/database.md §9's 500-character summary maximum), so a
 * summary never arrives already too long for the envelope that carries it.
 */
const MAX_SUMMARY = 500;

/**
 * Cut at the last sentence end that fits, falling back to the last word break.
 * Truncating at a fixed offset lands mid-word as readily as mid-sentence, and a
 * summary is read as a statement — one that stops halfway reads as a defect in
 * the document rather than in the thing that shortened it.
 */
function truncateAtSentence(text: string): string {
  if (text.length <= MAX_SUMMARY) {
    return text;
  }
  const head = text.slice(0, MAX_SUMMARY);
  let lastEnd = -1;
  SENTENCE_END.lastIndex = 0;
  for (const match of head.matchAll(SENTENCE_END)) {
    lastEnd = match.index + match[0].length;
  }
  if (lastEnd > 0) {
    return head.slice(0, lastEnd).trimEnd();
  }
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace > 0) {
    return `${head.slice(0, lastSpace).trimEnd()}…`;
  }
  // No boundary anywhere — CJK prose with no terminator has neither a space nor a
  // period. The ellipsis has to come out of the budget rather than be added to
  // it, or the one branch with nothing to cut at is the one that overruns.
  return `${head.slice(0, MAX_SUMMARY - 1).trimEnd()}…`;
}

/**
 * The document's opening prose as plain text, for the one-line summary the search
 * and context tools show.
 *
 * Parsed rather than scanned line by line. A Markdown paragraph is routinely
 * hard-wrapped across several source lines, so "the first non-empty line" is a
 * cut at whatever column the author's editor happened to wrap at — which is how
 * `CLAUDE.md` came to be summarized as "…for Claude Code and Codex. It ships as".
 * The parser joins a paragraph's soft-wrapped lines the way every Markdown reader
 * does, and never mistakes a list item or a table row for prose.
 *
 * `mdastToString` also drops emphasis and link syntax, so the field holds prose
 * rather than `**markup**` — it is read by an agent through the MCP envelope and
 * by a human in the dashboard, and neither wants the asterisks.
 *
 * Returns `undefined` for a document with no prose at all (headings only, or
 * empty), which the caller stores as "no summary" rather than an empty string.
 */
export function deriveSummary(body: string): string | undefined {
  const tree = fromMarkdown(body);
  for (const node of tree.children) {
    if (node.type !== "paragraph") {
      continue;
    }
    const text = mdastToString(node).replace(/\s+/gu, " ").trim();
    if (text.length > 0) {
      return truncateAtSentence(text);
    }
  }
  return undefined;
}
