/**
 * Assemble the distributable plugin archive tree (WP-11). Under Option A
 * (decision-log ID-038) the archive is thin: the two platform manifests, their
 * hook/MCP configs, and the shared skills — no runtime `dist/` and no native
 * binaries, because hooks and the MCP server run through the npm-installed
 * `iroha` binary. The result therefore contains only text and needs no install
 * lifecycle script (compatibility.md §3/§13).
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildClaudeHooks,
  buildClaudeManifest,
  buildClaudeMcpConfig,
  buildCodexHooks,
  buildCodexManifest,
  buildCodexMcpConfig,
} from "./manifests.js";

/** `packages/plugin/skills` — resolved identically from `src/` or the built `dist/`. */
const SKILLS_SOURCE = fileURLToPath(new URL("../skills", import.meta.url));

/** Default staging directory (`packages/plugin/build`) for the archive assembly. */
export const DEFAULT_BUILD_DIR = fileURLToPath(new URL("../build", import.meta.url));

async function writeJson(destDir: string, relativePath: string, value: unknown): Promise<void> {
  const target = join(destDir, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Write the full archive into `destDir`, replacing any previous contents. The
 * caller owns `destDir` (the build staging dir, or a test temp dir); it is
 * removed and recreated, so never pass a directory holding other files.
 */
export async function assembleArchive(destDir: string): Promise<void> {
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });

  await writeJson(destDir, ".claude-plugin/plugin.json", buildClaudeManifest());
  await writeJson(destDir, ".codex-plugin/plugin.json", buildCodexManifest());
  await writeJson(destDir, "hooks/claude.json", buildClaudeHooks());
  await writeJson(destDir, "hooks/codex.json", buildCodexHooks());
  await writeJson(destDir, ".mcp.json", buildClaudeMcpConfig());
  await writeJson(destDir, "mcp.codex.json", buildCodexMcpConfig());

  await cp(SKILLS_SOURCE, join(destDir, "skills"), { recursive: true });
}
