import type { IrohaError, Result } from "@iroha/domain";
import { parseYamlDocument } from "./parse-yaml-document.js";
import { type RepositoryConfig, repositoryConfigSchema } from "./schemas/repository-config.js";

/** Parses and validates `.iroha/config.yaml` (canonical-schema.md §9). */
export function parseRepositoryConfig(content: string): Result<RepositoryConfig, IrohaError> {
  return parseYamlDocument(content, repositoryConfigSchema, "Failed to parse .iroha/config.yaml");
}
