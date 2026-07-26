import { ENTITY_TYPES, runSearch } from "@iroha/core";
import { define } from "gunshi";
import { printError, printSuccess } from "../output.js";
import { definition, labelColumn, muted, sanitize, sectionLabel, title } from "../render.js";

const SEARCH_MODES = ["hybrid", "lexical", "vector", "graph"] as const;

interface DisplayHit {
  id: string;
  type: string;
  title: string;
  authority: number;
  score: number;
}

/**
 * Titles come from approved canonical documents, so they are both untrusted and
 * frequently CJK: sanitized because `.iroha/` is git-tracked and an escape sequence
 * in a title would otherwise run in the reader's terminal, and rendered through
 * `definition` so the column is measured in cells and a long title wraps under its
 * own indent instead of breaking the alignment.
 */
function formatSearch(data: { effectiveMode: string; hits: DisplayHit[] }): string {
  const heading = title("iroha search");
  const mode = `  ${muted(`mode ${data.effectiveMode}`)}`;
  if (data.hits.length === 0) {
    return [heading, "", `  ${muted("No results.")}`, "", mode].join("\n");
  }
  const terms = data.hits.map((hit) => `[${hit.type}]`);
  const width = labelColumn(terms);
  // The metadata line is styled as a whole and never wraps, so it is placed at the
  // detail column directly rather than passed through `definition` — `wrapCell`
  // splits on raw space indices and would break inside the dim span.
  const detailIndent = " ".repeat(width + 6);
  const rows = data.hits.flatMap((hit, index) => [
    definition(muted(terms[index] as string), sanitize(hit.title), width),
    `${detailIndent}${muted(`${hit.id} · authority ${hit.authority} · score ${hit.score.toFixed(3)}`)}`,
  ]);
  return [heading, "", sectionLabel(`${data.hits.length} result(s)`), ...rows, "", mode].join("\n");
}

export const searchCommand = define({
  name: "search",
  description: "Search approved knowledge (hybrid retrieval: lexical + vector + graph)",
  rendering: { header: null },
  args: {
    json: { type: "boolean", description: "Output JSON" },
    mode: {
      type: "enum",
      choices: [...SEARCH_MODES],
      description: "Retrieval mode (default hybrid; degrades to lexical without embedding)",
    },
    limit: { type: "number", description: "Maximum number of results" },
    type: {
      type: "enum",
      choices: [...ENTITY_TYPES],
      multiple: true,
      description: "Filter to entity type(s); repeatable",
    },
    query: { type: "positional", description: "Search query" },
  },
  run: async (ctx) => {
    const json = ctx.values.json ?? false;
    const types = ctx.values.type;
    const result = await runSearch(process.cwd(), ctx.values.query, {
      ...(ctx.values.mode !== undefined ? { mode: ctx.values.mode } : {}),
      ...(ctx.values.limit !== undefined ? { limit: ctx.values.limit } : {}),
      ...(types !== undefined && types.length > 0 ? { filters: { entityTypes: types } } : {}),
    });
    if (!result.ok) {
      printError(json, result.error);
      return;
    }
    const hits: DisplayHit[] = result.value.results.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      authority: r.authority,
      score: r.score,
    }));
    printSuccess(json, { effectiveMode: result.value.effectiveMode, hits }, formatSearch);
  },
});
