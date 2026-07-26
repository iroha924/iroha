import { ENTITY_TYPES, runSearch } from "@iroha/core";
import { define } from "gunshi";
import { printError, printSuccess } from "../output.js";
import { labelColumn, muted, padCell, sectionLabel, spread, title } from "../render.js";

const SEARCH_MODES = ["hybrid", "lexical", "vector", "graph"] as const;

interface DisplayHit {
  id: string;
  type: string;
  title: string;
  authority: number;
  score: number;
}

/**
 * Titles come from approved canonical documents, which in a repository with
 * `default_language: ja` are Japanese — so the type column is padded by terminal
 * cells. Padding by `.length` would leave every row after a CJK title misaligned.
 */
function formatSearch(data: { effectiveMode: string; hits: DisplayHit[] }): string {
  const heading = title("iroha search");
  if (data.hits.length === 0) {
    return [heading, "", spread(muted(`mode ${data.effectiveMode}`), muted("no results"))].join(
      "\n",
    );
  }
  const typeWidth = labelColumn(data.hits.map((hit) => hit.type));
  const rows = data.hits.map(
    (hit) =>
      `    ${muted(padCell(`[${hit.type}]`, typeWidth + 2))}  ${hit.title}\n` +
      `    ${" ".repeat(typeWidth + 2)}  ${muted(`${hit.id} · authority ${hit.authority} · score ${hit.score.toFixed(3)}`)}`,
  );
  return [
    heading,
    "",
    sectionLabel(`${data.hits.length} result(s)`),
    ...rows,
    "",
    spread(muted(`mode ${data.effectiveMode}`), ""),
  ].join("\n");
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
