import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Resolve a runtime asset shipped both inside this monorepo and inside the
 * published `@iroha-labs/iroha` package. The bundled code runs from two layouts:
 * in the monorepo the asset sits at the repo root (`../../..` from
 * `packages/cli/{src,dist}/…` or the plugin's `packages/plugin/dist/…`), while in
 * the published package `build-release.ts` ships it at the package root (`..`
 * from `<pkg>/dist/…`). Prefer the package-relative path, fall back to the
 * repo-root path, and default to the repo-root path so a genuinely missing asset
 * surfaces as the same downstream error rather than a wrong guess.
 */
function resolveRuntimeAsset(installed: string, dev: string): string {
  for (const relative of [installed, dev]) {
    const candidate = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return fileURLToPath(new URL(dev, import.meta.url));
}

/** Forward-only SQL migrations, applied by `init`/`sync`/`doctor --repair`. */
export const MIGRATIONS_DIR = resolveRuntimeAsset("../migrations", "../../../migrations");

/** The built dashboard SPA, served by `iroha dashboard`. */
export const DASHBOARD_DIST = resolveRuntimeAsset("../dashboard", "../../../apps/dashboard/dist");
