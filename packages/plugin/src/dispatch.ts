/**
 * The heavy dispatch graph behind the `iroha` binary — loaded dynamically by
 * `bin.ts` so that a failure while *loading* it (e.g. a transitive dependency
 * calling `process.cwd()` at module top level when the agent's working directory
 * has been deleted) is a catchable rejection rather than an uncatchable ESM
 * module-load crash. Routes the three entry modes (decision-log ID-038):
 *
 *   - `iroha __mcp`         → the stdio MCP server
 *   - `iroha __hook <plat>` → one hook invocation for `claude` or `codex`
 *   - `iroha <command> …`   → the user CLI
 *
 * `@iroha/plugin` may depend on `@iroha/cli` and `@iroha/mcp` but not `@iroha/core`
 * (compatibility.md §4); the hook runner is reached through `@iroha/cli`'s
 * re-export of `runHookMain`.
 */
import { runCli, runHookMain } from "@iroha/cli";
import { startStdioServer } from "@iroha/mcp";
import { HOOK_SUBCOMMAND, MCP_SUBCOMMAND } from "./metadata.js";

const argv = process.argv.slice(2);
const [command, ...rest] = argv;

if (command === MCP_SUBCOMMAND) {
  startStdioServer().catch((error: unknown) => {
    // Protocol frames own stdout; diagnostics go to stderr only (mcp-contract.md §2).
    process.stderr.write(
      `iroha mcp server failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
} else if (command === HOOK_SUBCOMMAND) {
  // Hook internal failure is fail-open (CLAUDE.md; hooks-contract.md §2/§7): a
  // throw that escapes `runHook`'s own handling — e.g. `process.cwd()` on a
  // deleted working directory, a stdin `'error'`, or a `close()` failure in a
  // `finally` — must still exit 0 with no stdout so the agent is never blocked.
  runHookMain(rest[0]).catch(() => {
    process.exit(0);
  });
} else {
  await runCli(argv);
}
