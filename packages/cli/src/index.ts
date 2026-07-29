/**
 * @iroha/cli — iroha command.
 */
export const packageName = "@iroha/cli";

import { cli, define } from "gunshi";
import { credentialsCommand } from "./commands/credentials.js";
import { dashboardCommand } from "./commands/dashboard.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { searchCommand } from "./commands/search.js";
import { syncCommand } from "./commands/sync.js";
import { muted, title } from "./render.js";
import { renderUsage, renderValidationErrors, validationErrorsRendered } from "./usage.js";

export const CLI_VERSION = "0.6.0";

const mainCommand = define({
  name: "iroha",
  description: "Local-first Engineering Memory Graph for Claude Code and Codex",
  run: () => {
    process.stdout.write(`${title(`iroha ${CLI_VERSION}`)}\n`);
    process.stdout.write(`  ${muted("Run `iroha --help` to see the available commands.")}\n`);
  },
});

export async function runCli(argv: readonly string[]): Promise<void> {
  try {
    await cli([...argv], mainCommand, {
      name: "iroha",
      version: CLI_VERSION,
      subCommands: {
        init: initCommand,
        sync: syncCommand,
        doctor: doctorCommand,
        search: searchCommand,
        dashboard: dashboardCommand,
        credentials: credentialsCommand,
      },
      // The title belongs to `renderUsage`, which draws it under the brand mark;
      // leaving the default header on would print a second, plainer one above it.
      renderHeader: null,
      renderUsage,
      renderValidationErrors,
    });
  } catch (error) {
    // Swallowed only when this process actually rendered the validation errors —
    // `instanceof AggregateError` alone would also silence one thrown from a
    // command body, exiting 1 with nothing on any stream. The narrow case is real:
    // gunshi rejects with a message-less `AggregateError` after showing the errors,
    // so rethrowing makes a mistyped flag surface as `iroha failed to start:` with
    // nothing after it. Anything else is a genuine fault and still propagates.
    if (!(error instanceof AggregateError) || !validationErrorsRendered()) {
      throw error;
    }
    process.exitCode = 1;
  }
}

/**
 * Re-exported so `@iroha/plugin` — which may depend on `@iroha/cli` but not
 * `@iroha/core` (compatibility.md §4) — can run the hook through the shared
 * `iroha` binary as `iroha __hook <platform>`.
 */
export { runHookMain } from "@iroha/core";
export {
  credentialsCommand,
  dashboardCommand,
  doctorCommand,
  initCommand,
  searchCommand,
  syncCommand,
};
