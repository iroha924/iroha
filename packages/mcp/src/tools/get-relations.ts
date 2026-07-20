import { mcpGetRelations, RELATION_TYPES } from "@iroha/core";
import { z } from "zod";
import type { McpWarning } from "../envelope.js";
import { defineTool } from "./types.js";

const getRelationsInputSchema = z.strictObject({
  entityIds: z.array(z.string()).min(1).max(20),
  relationTypes: z.array(z.enum(RELATION_TYPES)).optional(),
  direction: z.enum(["outgoing", "incoming", "both"]).optional(),
  depth: z.number().int().min(1).max(4).optional(),
  maxEdges: z.number().int().min(1).max(200).optional(),
});

export const getRelationsTool = defineTool({
  name: "get_relations",
  description:
    "Retrieve a bounded graph (deduplicated nodes and edges) around one or more entities. Read-only.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: getRelationsInputSchema,
  handler: (input, ctx) =>
    mcpGetRelations({
      cwd: ctx.cwd,
      clock: ctx.clock,
      random: ctx.random,
      entityIds: input.entityIds,
      relationTypes: input.relationTypes,
      direction: input.direction,
      depth: input.depth,
      maxEdges: input.maxEdges,
    }),
  warnings: (input) => {
    const warnings: McpWarning[] = [];
    if ((input.depth ?? 1) > 1 && input.direction !== undefined) {
      warnings.push({
        code: "unsupported_option",
        message: "direction is not applied for depth>1 (WP-08)",
      });
    }
    return warnings;
  },
});
