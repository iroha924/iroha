import { fileURLToPath } from "node:url";

/**
 * `packages/cli/dist/` and `packages/cli/src/` sit at the same depth under
 * the repo root, so this relative path resolves correctly whether run from
 * source (tests) or from the tsdown-built `dist/index.mjs`/`dist/bin.mjs`.
 * WP-11 (plugin packaging) is expected to replace this with a bundled
 * migrations path once `@iroha/cli` ships outside this monorepo.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

/**
 * The built dashboard SPA, served by `iroha dashboard`. Same depth reasoning as
 * `MIGRATIONS_DIR`. WP-11 (plugin packaging) will replace this with the bundled
 * asset path once `@iroha/cli` ships outside this monorepo.
 */
export const DASHBOARD_DIST = fileURLToPath(
  new URL("../../../apps/dashboard/dist", import.meta.url),
);
