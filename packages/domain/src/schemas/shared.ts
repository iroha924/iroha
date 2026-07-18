import { z } from "zod";
import { type IdPrefix, isCanonicalEntityId, isTypedId } from "../ids/entity-id.js";

/** Matches every `$defs.entityId` reference in schemas/canonical-v1.schema.json. */
export const entityIdSchema = z
  .string()
  .refine(isCanonicalEntityId, { message: "not a valid canonical entity ID" });

/** Builds a schema for a single typed-ULID prefix, e.g. `dec_`, `trn_`. */
export function typedId(prefix: IdPrefix) {
  return z.string().refine((value) => isTypedId(prefix, value), {
    message: `expected a "${prefix}_" prefixed ULID`,
  });
}

/** Matches every `$defs.repositoryId`/`scope.repository`-style `repo_` reference. */
export const repositoryIdSchema = typedId("repo");

/**
 * Matches `$defs.timestamp`: `format: "date-time"` + `pattern: "Z$"`. Zod's
 * `offset: false` (the default) already requires the literal uppercase "Z"
 * suffix and rejects numeric offsets, so no extra refinement is needed.
 */
export const timestampSchema = z.iso.datetime();

/** Matches `$defs.label`. */
export const labelSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * Matches the repository-relative path constraint used for `scope.paths[]`
 * and checkpoint `relativePath`: rejects absolute paths, Windows drive
 * letters, and any `..` path segment.
 */
const PATH_TRAVERSAL_PATTERN = /^(?:\/|[A-Za-z]:|.*(?:^|\/)\.\.(?:\/|$))/;

export function relativePathSchema(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => !PATH_TRAVERSAL_PATTERN.test(value), {
      message: "must be a repository-relative path without traversal",
    });
}

/** Rejects arrays containing duplicate items, matching `uniqueItems: true`. */
export function unique<T extends z.ZodType>(schema: z.ZodArray<T>): z.ZodArray<T> {
  return schema.refine((arr) => new Set(arr).size === arr.length, {
    message: "must not contain duplicate items",
  });
}
