import { labelSchema } from "@iroha/domain";
import { z } from "zod";

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/** A single entry in `taxonomy/labels.yaml` (canonical-schema.md §10). */
const labelDefinitionSchema = z.strictObject({
  id: labelSchema,
  title: z.string().min(1).max(120),
  description: z.string().max(500),
  color: z.string().regex(HEX_COLOR_PATTERN, {
    message: "must be a 6-digit hex color (e.g. #5B5BD6)",
  }),
});

export type LabelDefinition = z.infer<typeof labelDefinitionSchema>;

/**
 * Mirrors canonical-schema.md §10: `taxonomy/labels.yaml` "contains a
 * sorted list" of label IDs, each unique. Sorted order and uniqueness are
 * validated here (not left to writer discipline) so a hand-edited file
 * that violates either is rejected on read, the same way malformed
 * canonical documents are.
 */
export const labelsFileSchema = z
  .strictObject({
    schema_version: z.literal(1),
    labels: z.array(labelDefinitionSchema),
  })
  .superRefine((value, ctx) => {
    const ids = value.labels.map((label) => label.id);
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        ctx.addIssue({ code: "custom", message: `duplicate label id "${id}"`, path: ["labels"] });
      }
      seen.add(id);
    }
    const sorted = [...ids].sort();
    if (ids.some((id, index) => id !== sorted[index])) {
      ctx.addIssue({
        code: "custom",
        message: "labels must be sorted lexicographically by id",
        path: ["labels"],
      });
    }
  });

export type LabelsFile = z.infer<typeof labelsFileSchema>;
