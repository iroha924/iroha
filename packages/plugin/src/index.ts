/**
 * @iroha/plugin — manifests, hooks, skills, packaged dist.
 */
export const packageName = "@iroha/plugin";

export { assembleArchive } from "./build-archive.js";
export {
  buildClaudeHooks,
  buildClaudeManifest,
  buildClaudeMcpConfig,
  buildCodexHooks,
  buildCodexManifest,
  buildCodexMcpConfig,
  claudeHooksSchema,
  claudeManifestSchema,
  claudeMcpConfigSchema,
  codexHooksSchema,
  codexManifestSchema,
  codexMcpConfigSchema,
} from "./manifests.js";
export * from "./metadata.js";
