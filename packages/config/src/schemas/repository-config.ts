import { repositoryIdSchema } from "@iroha/domain";
import { z } from "zod";

/**
 * v1 fixes the embedding provider/model/dimension to a single combination
 * (contracts/database.md §8: "v1 does not mix models or dimensions inside the
 * same vector index"; migrations/001_initial.sql's `embeddings_1024` table
 * has matching `CHECK` constraints), so these are literals, not open enums.
 */
const embeddingConfigSchema = z.strictObject({
  enabled: z.boolean(),
  provider: z.literal("voyage"),
  model: z.literal("voyage-4-large"),
  dimension: z.literal(1024),
});

const searchConfigSchema = z.strictObject({
  embedding: embeddingConfigSchema,
});

const canonicalConfigSchema = z.strictObject({
  require_human_approval: z.boolean(),
  session_auto_publish: z.boolean(),
});

/** `pull_requests.provider`'s CHECK constraint (migrations/001_initial.sql) is the narrowest forge-provider enum in the schema. */
const forgeConfigSchema = z.strictObject({
  provider: z.enum(["github", "gitlab"]),
  enabled: z.boolean(),
  // Distinct pull requests a review-comment pattern must recur across before
  // `iroha sync` proposes it as a `review_learning` candidate. Floor is 2 — a
  // "recurrence" of one is a single comment, not a pattern.
  review_learning_threshold: z.number().int().min(2).default(3),
});

const privacyConfigSchema = z.strictObject({
  canonical_prompt_content: z.boolean(),
  canonical_transcript_content: z.boolean(),
});

/**
 * Mirrors contracts/canonical.md §9's `.iroha/config.yaml` schema. Unknown
 * keys are rejected ("Unknown configuration keys are rejected for schema
 * v1") via `z.strictObject` at every level.
 */
export const repositoryConfigSchema = z.strictObject({
  schema_version: z.literal(1),
  repository_id: repositoryIdSchema,
  // contracts/dashboard-api.md: "Japanese/English rendering" is the only supported UI language pair.
  default_language: z.enum(["ja", "en"]),
  canonical: canonicalConfigSchema,
  search: searchConfigSchema,
  forge: forgeConfigSchema,
  privacy: privacyConfigSchema,
});

export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;
