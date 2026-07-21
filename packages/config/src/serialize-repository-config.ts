import { stringify } from "yaml";
import type { RepositoryConfig } from "./schemas/repository-config.js";

/**
 * Serializes `.iroha/config.yaml` deterministically in canonical-schema.md §9
 * field order. Every key is written explicitly rather than by spreading the
 * input, so an unexpected property can never leak into the committed shared
 * config and the output stays byte-stable across writes (a clean Git diff).
 * This package stays filesystem-free: the caller (`@iroha/core`) owns the
 * atomic write to `.iroha/config.yaml`.
 */
export function serializeRepositoryConfig(config: RepositoryConfig): string {
  const ordered = {
    schema_version: config.schema_version,
    repository_id: config.repository_id,
    default_language: config.default_language,
    canonical: {
      require_human_approval: config.canonical.require_human_approval,
      session_auto_publish: config.canonical.session_auto_publish,
    },
    search: {
      embedding: {
        enabled: config.search.embedding.enabled,
        provider: config.search.embedding.provider,
        model: config.search.embedding.model,
        dimension: config.search.embedding.dimension,
        api_key_env: config.search.embedding.api_key_env,
      },
    },
    forge: {
      provider: config.forge.provider,
      enabled: config.forge.enabled,
      api_token_env: config.forge.api_token_env,
      review_learning_threshold: config.forge.review_learning_threshold,
    },
    privacy: {
      canonical_prompt_content: config.privacy.canonical_prompt_content,
      canonical_transcript_content: config.privacy.canonical_transcript_content,
    },
  };
  return stringify(ordered);
}
