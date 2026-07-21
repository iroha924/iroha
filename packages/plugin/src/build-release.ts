/**
 * Assemble the publishable `@iroha-labs/iroha` npm package into a staging
 * directory (WP-11c). Under Option A (decision-log ID-038) one npm package is
 * both the runtime and the plugin, so the tarball root carries the `iroha`
 * binary (`dist/`), the two platform manifests + hook/MCP config + skills (so a
 * marketplace `npm` source finds them), and `LICENSE`.
 *
 * The generated `package.json` (ID-011: internal `@iroha/*`, published
 * `@iroha-labs/iroha`) renames the package, drops the `@iroha/*` workspace
 * dependencies — they are bundled into `dist/bin.mjs` by tsdown, not resolved at
 * runtime — and resolves every remaining `catalog:` dependency to the concrete
 * version from `pnpm-workspace.yaml`, so the tarball is installable by an
 * external consumer with no workspace or catalog.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { assembleArchive, REPO_ROOT } from "./build-archive.js";
import {
  PLUGIN_DESCRIPTION,
  PLUGIN_HOMEPAGE,
  PLUGIN_LICENSE,
  PLUGIN_REPOSITORY,
  PLUGIN_VERSION,
  PUBLISHED_PACKAGE_NAME,
} from "./metadata.js";

/** `packages/plugin` — resolved identically from `src/` or the built `dist/`. */
const PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Default staging directory (`packages/plugin/release`) for the publish package. */
export const DEFAULT_RELEASE_DIR = fileURLToPath(new URL("../release", import.meta.url));

interface PluginPackageJson {
  dependencies: Record<string, string>;
}

interface Workspace {
  catalog: Record<string, string>;
}

/** Build the published `package.json` with concrete, workspace-free dependencies. */
async function buildPublishManifest(): Promise<Record<string, unknown>> {
  const pluginPkg = JSON.parse(
    await readFile(join(PLUGIN_DIR, "package.json"), "utf8"),
  ) as PluginPackageJson;
  const workspace = parse(
    await readFile(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8"),
  ) as Workspace;

  const dependencies: Record<string, string> = {};
  for (const [name, spec] of Object.entries(pluginPkg.dependencies)) {
    if (name.startsWith("@iroha/")) {
      continue; // workspace package — bundled into dist/bin.mjs, not a runtime dependency
    }
    if (spec === "catalog:") {
      const resolved = workspace.catalog[name];
      if (resolved === undefined) {
        throw new Error(`no catalog version for dependency "${name}"`);
      }
      dependencies[name] = resolved;
    } else if (/^(catalog:|workspace:|npm:|link:|file:)/.test(spec)) {
      // A named catalog, a non-@iroha workspace dep, or any other unresolved
      // protocol would ship an uninstallable spec — fail rather than emit it.
      throw new Error(`cannot resolve dependency "${name}" spec "${spec}" for publish`);
    } else {
      dependencies[name] = spec;
    }
  }

  return {
    name: PUBLISHED_PACKAGE_NAME,
    version: PLUGIN_VERSION,
    description: PLUGIN_DESCRIPTION,
    license: PLUGIN_LICENSE,
    repository: { type: "git", url: `git+${PLUGIN_REPOSITORY}.git` },
    homepage: PLUGIN_HOMEPAGE,
    type: "module",
    engines: { node: ">=24.0.0 <25" },
    bin: { iroha: "./dist/bin.mjs" },
    files: [
      "dist",
      "migrations",
      "dashboard",
      "skills",
      ".claude-plugin",
      ".codex-plugin",
      "hooks",
      ".mcp.json",
      "mcp.codex.json",
    ],
    dependencies,
  };
}

/**
 * Reduce a copied `dist/` to just the runtime closure of `entry` — the `.mjs`
 * files reachable through static and dynamic imports from `bin.mjs` (i.e. the
 * `dispatch` and `metadata` chunks). Everything else the shared plugin build
 * emits — the `index` library entry, the `build-*-cli` tooling and its chunks,
 * and every `.d.mts` — is not needed to run the binary and is dropped from the
 * publishable package. Robust to tsdown's content-hashed chunk names.
 */
async function pruneDistToRuntime(distDir: string, entry: string): Promise<void> {
  const keep = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || keep.has(file)) {
      continue;
    }
    const path = join(distDir, file);
    if (!existsSync(path)) {
      // A bundled string literal that merely looks like `"./x.mjs"` (a docstring
      // or error message, not an emitted chunk) is not a real dependency — skip
      // it rather than fail the whole release assembly.
      continue;
    }
    keep.add(file);
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/["'`]\.\/([\w.-]+\.mjs)["'`]/g)) {
      const imported = match[1];
      if (imported !== undefined) {
        queue.push(imported);
      }
    }
  }
  for (const file of await readdir(distDir)) {
    if (!keep.has(file)) {
      await rm(join(distDir, file), { recursive: true });
    }
  }
}

/**
 * Write the complete publishable package into `destDir`, replacing any previous
 * contents. Reuses `assembleArchive` for the plugin config + skills, then adds
 * the runtime `dist/` (pruned to the `bin.mjs` closure), `LICENSE`, and the
 * generated `package.json`.
 */
export async function assembleRelease(destDir: string): Promise<void> {
  await assembleArchive(destDir); // manifests, hook/MCP config, skills (removes destDir first)
  await cp(join(PLUGIN_DIR, "dist"), join(destDir, "dist"), { recursive: true });
  await pruneDistToRuntime(join(destDir, "dist"), "bin.mjs");
  // Runtime assets the bundled CLI resolves at package-relative paths (context.ts):
  // the SQL migrations `iroha init`/`sync` apply, and the dashboard SPA `iroha
  // dashboard` serves. Without these the published binary's core commands fail.
  await cp(join(REPO_ROOT, "migrations"), join(destDir, "migrations"), { recursive: true });
  await cp(join(REPO_ROOT, "apps", "dashboard", "dist"), join(destDir, "dashboard"), {
    recursive: true,
  });
  await cp(join(REPO_ROOT, "LICENSE"), join(destDir, "LICENSE"));

  const manifest = await buildPublishManifest();
  await mkdir(dirname(join(destDir, "package.json")), { recursive: true });
  await writeFile(join(destDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
