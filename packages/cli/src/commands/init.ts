import { type RunInitResult, runInit } from "@iroha/core";
import { define } from "gunshi";
import { MIGRATIONS_DIR } from "../context.js";
import { printError, printSuccess } from "../output.js";

function formatInit(data: RunInitResult): string {
  return [
    data.init.freshInit
      ? `Initialized a new repository (${data.init.repositoryId}).`
      : `Repository already initialized (${data.init.repositoryId}).`,
    `Docs scanned: ${data.init.docsScanned.join(", ") || "none"} (${data.init.candidatesCreated} new candidate(s)).`,
    `Canonical sync: +${data.sync.added} added, ${data.sync.changed} changed, ${data.sync.unchanged} unchanged, ${data.sync.deleted} deleted.`,
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
