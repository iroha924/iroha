import { type RunInitResult, runInit } from "@iroha/core";
import { define } from "gunshi";
import { MIGRATIONS_DIR } from "../context.js";
import { printError, printSuccess } from "../output.js";
import { definition, labelColumn, muted, row, sanitize, statusGlyph, title } from "../render.js";

function formatInit(data: RunInitResult): string {
  const { init, sync } = data;
  // Separators are plain, not `muted(" · ")`: these strings are wrapped by
  // `definition`, and `wrapCell` splits on raw space indices, so a break inside a
  // dim span would leave the style open across the wrap.
  const facts: [string, string][] = [
    ["repository", init.repositoryId],
    [
      "docs imported",
      `${init.docsImported.map(sanitize).join(", ") || "none"} · ${init.entitiesWritten} updated`,
    ],
    [
      "canonical sync",
      [
        `+${sync.added} added`,
        `${sync.changed} changed`,
        `${sync.unchanged} unchanged`,
        `${sync.deleted} deleted`,
      ].join(" · "),
    ],
  ];
  const width = labelColumn(facts.map(([term]) => term));
  return [
    title("iroha init"),
    "",
    `    ${statusGlyph("ok")}  ${init.freshInit ? "Initialized this repository" : "Already initialized"}`,
    "",
    ...facts.map(([term, detail]) => definition(muted(term), detail, width)),
    // This run deleted these keys from config.yaml, which is also the only thing
    // `iroha doctor` could have noticed them by. Removing the value from HEAD
    // does not remove it from the history that already carries it, so this is the
    // last moment anyone can be told to rotate it.
    ...(init.pastedSecrets.length > 0
      ? [
          "",
          row(
            statusGlyph("warning"),
            "",
            `${init.pastedSecrets.join(", ")} held a value that is not an environment variable name. It has been removed from config.yaml, but if that was an API key it is still in this repository's Git history — rotate it.`,
            0,
          ),
        ]
      : []),
  ].join("\n");
}

export const initCommand = define({
  name: "init",
  description: "Initialize .iroha/ and the local database for this repository",
  rendering: { header: null },
  args: {
    json: { type: "boolean", description: "Output JSON" },
  },
  run: async (ctx) => {
    const json = ctx.values.json ?? false;
    const result = await runInit(process.cwd(), MIGRATIONS_DIR);
    if (!result.ok) {
      printError(json, result.error);
      return;
    }
    printSuccess(json, result.value, formatInit);
  },
});
