import { ENTITY_TYPES, runSearch } from "@iroha/core";
import { define } from "gunshi";
import { printError, printSuccess } from "../output.js";

const SEARCH_MODES = ["hybrid", "lexical", "vector", "graph"] as const;

interface DisplayHit {
  id: string;
  type: string;
  title: string;
  authority: number;
  score: number;
}

function formatSearch(data: { effectiveMode: string; hits: DisplayHit[] }): string {
  if (data.hits.length === 0) {
    return `No results (mode: ${data.effectiveMode}).`;
  }
  const rows = data.hits.map(
    (hit) =>
      `${hit.id}  [${hit.type}]  ${hit.title}  (authority ${hit.authority}, score ${hit.score.toFixed(3)})`,
  );
  return [`Mode: ${data.effectiveMode}`, ...rows].join("\n");
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
