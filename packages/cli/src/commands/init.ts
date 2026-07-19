import {
  type InitRepositoryResult,
  initRepository,
  type SyncCanonicalResult,
  syncCanonicalToDatabase,
} from "@iroha/core";
import { closeDatabase, openDatabase } from "@iroha/storage";
import { define } from "gunshi";
import { clock, MIGRATIONS_DIR, newRandom } from "../context.js";
import { printError, printSuccess } from "../output.js";

interface InitOutput {
  init: InitRepositoryResult;
  sync: SyncCanonicalResult;
}

function formatInit(data: InitOutput): string {
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
  },
  run: async (ctx) => {
    const json = ctx.values.json ?? false;
    const cwd = process.cwd();

    const initResult = await initRepository(cwd, clock, newRandom(), MIGRATIONS_DIR);
    if (!initResult.ok) {
      printError(json, initResult.error);
      return;
    }

    const opened = await openDatabase(initResult.value.dbPath);
    if (!opened.ok) {
      printError(json, opened.error);
      return;
    }
    const syncResult = await syncCanonicalToDatabase(
      opened.value,
      initResult.value.repositoryId,
      initResult.value.irohaCanonicalDir,
      clock,
      newRandom(),
    );
    closeDatabase(opened.value);
    if (!syncResult.ok) {
      printError(json, syncResult.error);
      return;
    }

    printSuccess<InitOutput>(json, { init: initResult.value, sync: syncResult.value }, formatInit);
  },
});
