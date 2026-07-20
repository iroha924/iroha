import { mcpLinkEntities, RELATION_TYPES } from "@iroha/core";
import { z } from "zod";
import { defineTool } from "./types.js";

const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const linkEntitiesInputSchema = z.strictObject({
  sessionToken: z.string().min(1),
  idempotencyKey: idempotencyKeySchema,
  fromEntityId: z.string().min(1),
  relationType: z.enum(RELATION_TYPES),
  toEntityId: z.string().min(1),
  evidence: z.string().min(1).max(1000),
  confidence: z.number().min(0).max(1),
});

export const linkEntitiesTool = defineTool({
  name: "link_entities",
  description:
    "Create a local inferred relation between two existing entities for review and retrieval. Both endpoints must already exist; self-relations are allowed only for RELATED_TO. Idempotent by idempotencyKey.",
  annotations: { idempotentHint: true },
  inputSchema: linkEntitiesInputSchema,
  handler: (input, ctx) =>
    mcpLinkEntities({
      cwd: ctx.cwd,
      clock: ctx.clock,
      random: ctx.random,
      sessionToken: input.sessionToken,
      idempotencyKey: input.idempotencyKey,
      fromEntityId: input.fromEntityId,
      relationType: input.relationType,
      toEntityId: input.toEntityId,
      evidence: input.evidence,
      confidence: input.confidence,
    }),
});
