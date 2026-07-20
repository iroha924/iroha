import { type RunSyncResult, runSync } from "@iroha/core";
import { define } from "gunshi";
import { MIGRATIONS_DIR } from "../context.js";
import { printError, printSuccess } from "../output.js";

function formatSync(data: RunSyncResult): string {
  if (data.rebuilt) {
    return [
      `Rebuilt the local database (backup at ${data.rebuild.backupPath}).`,
      formatSyncCounts(data.rebuild.sync),
    ].join("\n");
  }
  const lines = [formatSyncCounts(data.sync)];
  const embedding = data.embedding;
  if (embedding.skipped === null && embedding.processed + embedding.failed + embedding.dead > 0) {
    lines.push(
      `Embeddings: ${embedding.processed} embedded, ${embedding.failed} retrying, ${embedding.dead} dead-lettered.`,
    );
  }
  return lines.join("\n");
}

function formatSyncCounts(sync: {
  added: number;
  changed: number;
  unchanged: number;
  deleted: number;
  scanErrors: number;
  unresolvedRelations: number;
}): string {
  const lines = [
    `+${sync.added} added, ${sync.changed} changed, ${sync.unchanged} unchanged, ${sync.deleted} deleted.`,
  ];
  if (sync.scanErrors > 0) {
    lines.push(`${sync.scanErrors} file(s) failed to parse — see dirty markers.`);
  }
  if (sync.unresolvedRelations > 0) {
    lines.push(
      `${sync.unresolvedRelations} relation(s) could not be resolved — see dirty markers.`,
    );
  }
  return lines.join("\n");
}

export const syncCommand = define({
  name: "sync",
  description: "Import .iroha/ canonical documents into the local database",
  rendering: { header: null },
  args: {
    json: { type: "boolean", description: "Output JSON" },
    rebuild: { type: "boolean", description: "Rebuild the local database from scratch" },
  },
  run: async (ctx) => {
    const json = ctx.values.json ?? false;
    const result = await runSync(process.cwd(), MIGRATIONS_DIR, {
      rebuild: ctx.values.rebuild ?? false,
    });
    if (!result.ok) {
      printError(json, result.error);
      return;
    }
    printSuccess(json, result.value, formatSync);
  },
});
