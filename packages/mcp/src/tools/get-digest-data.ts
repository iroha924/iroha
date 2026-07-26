import { mcpGetDigestData } from "@iroha/core";
import { z } from "zod";
import { defineTool } from "./types.js";

const getDigestDataInputSchema = z.strictObject({
  unit: z.enum(["week", "month"]).optional(),
  offset: z.number().int().min(0).max(520).optional(),
});

export const getDigestDataTool = defineTool({
  name: "get_digest_data",
  description:
    "Return one period's Digest facts: aggregate counts, prior-period comparisons, denial clusters, and the fact table to reference when composing prose. Read-only. Aggregates only — no actor, author, or per-person data, and no raw prompt, transcript, or tool payload.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: getDigestDataInputSchema,
  handler: (input, ctx) =>
    mcpGetDigestData({
      cwd: ctx.cwd,
      clock: ctx.clock,
      random: ctx.random,
      unit: input.unit,
      offset: input.offset,
    }),
});
