import { type RunSyncResult, runSync } from "@iroha/core";
import { define } from "gunshi";
import { MIGRATIONS_DIR } from "../context.js";
import { printError, printSuccess } from "../output.js";

function formatSync(data: RunSyncResult): string {
  if (data.rebuilt) {
    const { backupPath } = data.rebuild;
    return [
      backupPath === null
        ? "Built the local database from canonical data (no previous database to back up)."
        : `Rebuilt the local database (backup at ${backupPath}).`,
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
  // Forge is non-fatal, so its outcome only surfaces here (never as a sync error).
  // "disabled" (the default) prints nothing to keep the common case quiet.
  const forge = data.forge;
  if (forge.status === "skipped") {
    lines.push(`Forge: skipped (${forge.reason}).`);
  } else if (forge.status === "error") {
    lines.push(`Forge: sync failed (${forge.errorCode}) — will retry on the next sync.`);
  } else if (forge.status === "synced") {
    lines.push(
      `Forge: ${forge.issues} issue(s), ${forge.pullRequests} PR(s), ${forge.reviewComments} review comment(s), ${forge.relations} relation(s).`,
    );
    if (forge.reviewLearnings > 0) {
      lines.push(
        `Forge: ${forge.reviewLearnings} recurring review learning(s) proposed for approval.`,
      );
    }
    if (forge.truncated) {
      lines.push(
        "Forge sync was truncated — older history was not fetched; raise the page bound or re-run. See dirty markers.",
      );
    }
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
