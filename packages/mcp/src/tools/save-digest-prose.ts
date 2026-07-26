import { digestProseSchema, mcpSaveDigestProse } from "@iroha/core";
import { z } from "zod";
import { defineTool } from "./types.js";

const saveDigestProseInputSchema = z.strictObject({
  sessionToken: z.string().min(1),
  unit: z.enum(["week", "month"]).optional(),
  offset: z.number().int().min(0).max(520).optional(),
  prose: digestProseSchema,
});

export const saveDigestProseTool = defineTool({
  name: "save_digest_prose",
  description:
    "Store the composed prose for one Digest period. Write only sentences: state a number by referencing an id from get_digest_data as {{factId}} and iroha substitutes its own value — there is no field to put a number in. Referencing an id the period did not issue is rejected. Overwrites any previous composition for the same period. The result is local and never committed to Git.",
  annotations: { idempotentHint: true },
  inputSchema: saveDigestProseInputSchema,
  handler: (input, ctx) =>
    mcpSaveDigestProse({
      cwd: ctx.cwd,
      clock: ctx.clock,
      random: ctx.random,
      sessionToken: input.sessionToken,
      unit: input.unit,
      offset: input.offset,
      prose: input.prose,
    }),
});
