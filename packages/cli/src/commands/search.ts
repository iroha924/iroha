import { runSearch } from "@iroha/core";
import { define } from "gunshi";
import { printError, printSuccess } from "../output.js";

interface DisplayHit {
  entityId: string;
  title: string;
  authority: number;
  score: number;
}

function formatSearch(data: { hits: DisplayHit[] }): string {
  if (data.hits.length === 0) {
    return "No results.";
  }
  return data.hits
    .map(
      (hit) =>
        `${hit.entityId}  ${hit.title}  (authority ${hit.authority}, score ${hit.score.toFixed(3)})`,
    )
    .join("\n");
}

export const searchCommand = define({
  name: "search",
  description: "Search approved knowledge offline via FTS (Unicode + trigram)",
  rendering: { header: null },
  args: {
    json: { type: "boolean", description: "Output JSON" },
    query: { type: "positional", description: "Search query" },
  },
  run: async (ctx) => {
    const json = ctx.values.json ?? false;

    const result = await runSearch(process.cwd(), ctx.values.query);
    if (!result.ok) {
      printError(json, result.error);
      return;
    }
    printSuccess(json, { hits: result.value }, formatSearch);
  },
});
