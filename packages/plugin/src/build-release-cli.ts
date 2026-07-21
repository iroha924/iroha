/**
 * Runnable entrypoint for `pnpm --filter @iroha/plugin build:release`. Assembles
 * the publishable `@iroha-labs/iroha` package into `packages/plugin/release`;
 * the WP-11c release workflow packs/publishes from there. Kept separate from
 * `build-release.ts` so the side-effecting run lives in its own tsdown entry
 * chunk (see `build-archive-cli.ts` for the rationale).
 */
import { assembleRelease, DEFAULT_RELEASE_DIR } from "./build-release.js";

assembleRelease(DEFAULT_RELEASE_DIR).catch((error: unknown) => {
  process.stderr.write(
    `iroha release assembly failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
