import { repositoryIdSchema } from "@iroha/domain";
import { z } from "zod";

/**
 * `.iroha/config.yaml`'s env-var-name constraint (canonical-schema.md §9:
 * "Secret values are forbidden; only environment-variable names may
 * appear"). Standard POSIX environment variable naming — the config file
 * never holds the secret value itself, only where to read it from.
 */
const envVarNameSchema = z
  .string()
  .max(200)
  .regex(/^[A-Z][A-Z0-9_]*$/, {
    message: "must be an environment variable name (UPPER_SNAKE_CASE)",
  });

/**
 * v1 fixes the embedding provider/model/dimension to a single combination
 * (database-schema.md §8: "v1 does not mix models or dimensions inside the
 * same vector index"; migrations/001_initial.sql's `embeddings_1024` table
 * has matching `CHECK` constraints), so these are literals, not open enums.
 */
const embeddingConfigSchema = z.strictObject({
  enabled: z.boolean(),
  provider: z.literal("voyage"),
  model: z.literal("voyage-4-large"),
  dimension: z.literal(1024),
  api_key_env: envVarNameSchema,
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
});

const privacyConfigSchema = z.strictObject({
  canonical_prompt_content: z.boolean(),
  canonical_transcript_content: z.boolean(),
});

/**
 * Mirrors canonical-schema.md §9's `.iroha/config.yaml` schema. Unknown
 * keys are rejected ("Unknown configuration keys are rejected for schema
 * v1") via `z.strictObject` at every level.
 */
export const repositoryConfigSchema = z.strictObject({
  schema_version: z.literal(1),
  repository_id: repositoryIdSchema,
  // dashboard-api.md: "Japanese/English rendering" is the only supported UI language pair.
  default_language: z.enum(["ja", "en"]),
  canonical: canonicalConfigSchema,
  search: searchConfigSchema,
  forge: forgeConfigSchema,
  privacy: privacyConfigSchema,
});

export type RepositoryConfig = z.infer<typeof repositoryConfigSchema>;
