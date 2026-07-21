/**
 * Runnable entrypoint for `pnpm --filter @iroha/plugin build:archive`. Kept
 * separate from `build-archive.ts` (which only exports `assembleArchive`) so the
 * side-effecting run lives in its own tsdown entry chunk rather than a shared
 * module — a `process.argv[1] === import.meta.url` self-invoke guard is
 * unreliable once tsdown code-splits a re-exported entry.
 */
import { assembleArchive, DEFAULT_BUILD_DIR, writeMarketplaces } from "./build-archive.js";

Promise.all([assembleArchive(DEFAULT_BUILD_DIR), writeMarketplaces()]).catch((error: unknown) => {
  process.stderr.write(
    `iroha plugin archive assembly failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
