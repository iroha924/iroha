#!/usr/bin/env node
/**
 * The published `iroha` binary (`@iroha-labs/iroha`), the single entrypoint the
 * plugin manifests drive (decision-log ID-038, Option A). This file is a thin,
 * import-light loader on purpose: it statically imports only `metadata.ts` (plain
 * constants) and pulls the heavy dispatch graph in via a dynamic `import()`, so a
 * failure while loading that graph is a rejected promise this `.catch` can see
 * rather than a fatal ESM module-load crash before any of our code runs.
 *
 * That distinction is load-bearing for the hook's fail-open invariant (CLAUDE.md;
 * hooks-contract.md §2/§7): a transitive dependency (`rc-config-loader`, via
 * `secretlint`) calls `process.cwd()` at module top level, which throws `ENOENT`
 * when the agent's working directory has been removed mid-session — and that
 * throw happens during import, before `dispatch.ts` executes. Isolating the heavy
 * graph behind a dynamic import lets the hook still exit 0 in that case.
 */
import { HOOK_SUBCOMMAND } from "./metadata.js";

import("./dispatch.js").catch((error: unknown) => {
  if (process.argv[2] === HOOK_SUBCOMMAND) {
    // Fail open: never block the agent, even when the dispatch graph fails to load.
    process.exit(0);
  }
  process.stderr.write(
    `iroha failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
