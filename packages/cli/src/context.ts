import { fileURLToPath } from "node:url";
import { CryptoRandomSource, SystemClock } from "@iroha/domain";

/**
 * `packages/cli/dist/` and `packages/cli/src/` sit at the same depth under
 * the repo root, so this relative path resolves correctly whether run from
 * source (tests) or from the tsdown-built `dist/index.mjs`/`dist/bin.mjs`.
 * WP-11 (plugin packaging) is expected to replace this with a bundled
 * migrations path once `@iroha/cli` ships outside this monorepo.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

export const clock = new SystemClock();

export function newRandom(): CryptoRandomSource {
  return new CryptoRandomSource();
}
