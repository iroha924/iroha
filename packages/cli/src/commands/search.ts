import { resolveInitializedRepository } from "@iroha/core";
import { type SearchTextHit, searchText } from "@iroha/search";
import { closeDatabase, openDatabase } from "@iroha/storage";
import { define } from "gunshi";
import { printError, printSuccess } from "../output.js";

function formatSearch(data: { hits: SearchTextHit[] }): string {
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
    const cwd = process.cwd();

    const resolvedResult = await resolveInitializedRepository(cwd);
    if (!resolvedResult.ok) {
      printError(json, resolvedResult.error);
      return;
    }
    const opened = await openDatabase(resolvedResult.value.dbPath);
    if (!opened.ok) {
      printError(json, opened.error);
      return;
    }
    const searchResult = await searchText(opened.value, ctx.values.query);
    closeDatabase(opened.value);
    if (!searchResult.ok) {
      printError(json, searchResult.error);
      return;
    }
    printSuccess(json, { hits: searchResult.value }, formatSearch);
  },
});
