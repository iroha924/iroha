import { type RunInitResult, runInit } from "@iroha/core";
import { define } from "gunshi";
import { MIGRATIONS_DIR } from "../context.js";
import { printError, printSuccess } from "../output.js";
import { definition, labelColumn, muted, sanitize, statusGlyph, title } from "../render.js";

function formatInit(data: RunInitResult): string {
  const { init, sync } = data;
  // Separators are plain, not `muted(" · ")`: these strings are wrapped by
  // `definition`, and `wrapCell` splits on raw space indices, so a break inside a
  // dim span would leave the style open across the wrap.
  const facts: [string, string][] = [
    ["repository", init.repositoryId],
    [
      "docs scanned",
      `${init.docsScanned.map(sanitize).join(", ") || "none"} · ${init.candidatesCreated} new candidate(s)`,
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
  ].join("\n");
}

export const initCommand = define({
  name: "init",
  description: "Initialize .iroha/ and the local database for this repository",
  rendering: { header: null },
  args: {
    json: { type: "boolean", description: "Output JSON" },
    scan: {
      type: "boolean",
      description: "Also scan AGENTS.md/CLAUDE.md/.claude/rules/**/*.md into local candidates",
    },
  },
  run: async (ctx) => {
    const json = ctx.values.json ?? false;
    const result = await runInit(process.cwd(), MIGRATIONS_DIR, { scan: ctx.values.scan ?? false });
    if (!result.ok) {
      printError(json, result.error);
      return;
    }
    printSuccess(json, result.value, formatInit);
  },
});
