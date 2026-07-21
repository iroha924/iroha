/**
 * @iroha/cli — iroha command.
 */
export const packageName = "@iroha/cli";

import { cli, define } from "gunshi";
import { dashboardCommand } from "./commands/dashboard.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { searchCommand } from "./commands/search.js";
import { syncCommand } from "./commands/sync.js";

const CLI_VERSION = "0.1.0";

const mainCommand = define({
  name: "iroha",
  description: "Local-first Engineering Memory Graph for Claude Code and Codex",
  run: () => {
    process.stdout.write('Run "iroha --help" to see available commands.\n');
  },
});

export async function runCli(argv: readonly string[]): Promise<void> {
  await cli([...argv], mainCommand, {
    name: "iroha",
    version: CLI_VERSION,
    subCommands: {
      init: initCommand,
      sync: syncCommand,
      doctor: doctorCommand,
      search: searchCommand,
      dashboard: dashboardCommand,
    },
  });
}

/**
 * Re-exported so `@iroha/plugin` — which may depend on `@iroha/cli` but not
 * `@iroha/core` (compatibility.md §4) — can run the hook through the shared
 * `iroha` binary as `iroha __hook <platform>` (WP-11, Option A).
 */
export { runHookMain } from "@iroha/core";
export { dashboardCommand, doctorCommand, initCommand, searchCommand, syncCommand };
