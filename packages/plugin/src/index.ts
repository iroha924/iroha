/**
 * @iroha/plugin — manifests, hooks, skills, packaged dist.
 */
export const packageName = "@iroha/plugin";

export { assembleArchive, REPO_ROOT, writeMarketplaces } from "./build-archive.js";
export { assembleRelease, DEFAULT_RELEASE_DIR } from "./build-release.js";
export {
  buildClaudeHooks,
  buildClaudeManifest,
  buildClaudeMarketplace,
  buildClaudeMcpConfig,
  buildCodexHooks,
  buildCodexManifest,
  buildCodexMarketplace,
  buildCodexMcpConfig,
  claudeHooksSchema,
  claudeManifestSchema,
  claudeMarketplaceSchema,
  claudeMcpConfigSchema,
  codexHooksSchema,
  codexManifestSchema,
  codexMarketplaceSchema,
  codexMcpConfigSchema,
} from "./manifests.js";
export * from "./metadata.js";
