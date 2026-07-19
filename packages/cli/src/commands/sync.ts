import {
  type RebuildDatabaseResult,
  rebuildDatabase,
  resolveInitializedRepository,
  type SyncCanonicalResult,
  syncCanonicalToDatabase,
} from "@iroha/core";
import { closeDatabase, openDatabase } from "@iroha/storage";
import { define } from "gunshi";
import { clock, MIGRATIONS_DIR, newRandom } from "../context.js";
import { printError, printSuccess } from "../output.js";

function formatSync(data: { sync: SyncCanonicalResult }): string {
  const { added, changed, unchanged, deleted, scanErrors, unresolvedRelations } = data.sync;
  const lines = [
    `+${added} added, ${changed} changed, ${unchanged} unchanged, ${deleted} deleted.`,
  ];
  if (scanErrors > 0) {
    lines.push(`${scanErrors} file(s) failed to parse — see dirty markers.`);
  }
  if (unresolvedRelations > 0) {
    lines.push(`${unresolvedRelations} relation(s) could not be resolved — see dirty markers.`);
  }
  return lines.join("\n");
}

function formatRebuild(data: { rebuild: RebuildDatabaseResult }): string {
  return [
    `Rebuilt the local database (backup at ${data.rebuild.backupPath}).`,
    formatSync({ sync: data.rebuild.sync }),
  ].join("\n");
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
    const cwd = process.cwd();

    if (ctx.values.rebuild) {
      const rebuildResult = await rebuildDatabase(cwd, clock, newRandom(), MIGRATIONS_DIR);
      if (!rebuildResult.ok) {
        printError(json, rebuildResult.error);
        return;
      }
      printSuccess(json, { rebuild: rebuildResult.value }, formatRebuild);
      return;
    }

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
    const syncResult = await syncCanonicalToDatabase(
      opened.value,
      resolvedResult.value.repositoryId,
      resolvedResult.value.irohaCanonicalDir,
      clock,
      newRandom(),
    );
    closeDatabase(opened.value);
    if (!syncResult.ok) {
      printError(json, syncResult.error);
      return;
    }
    printSuccess(json, { sync: syncResult.value }, formatSync);
  },
});
