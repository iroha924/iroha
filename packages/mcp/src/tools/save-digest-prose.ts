import { digestProseSchema, mcpSaveDigestProse } from "@iroha/core";
import { z } from "zod";
import type { McpWarning } from "../envelope.js";
import { defineTool } from "./types.js";

const saveDigestProseInputSchema = z.strictObject({
  sessionToken: z.string().min(1),
  /**
   * The period being written for, echoed from `get_digest_data`'s `period`. Not an
   * offset: an offset is relative to "now", so a dropped or stale one silently
   * attaches a composition to a different period than the one it describes.
   */
  periodUnit: z.enum(["week", "month"]),
  periodKey: z.string().min(1).max(16),
  prose: digestProseSchema,
});

export const saveDigestProseTool = defineTool({
  name: "save_digest_prose",
  description:
    "Store the composed prose for one Digest period. Pass back the `periodUnit` and `periodKey` from the get_digest_data response this was composed against. Write only sentences: state a number by referencing an id from get_digest_data as {{factId}} and iroha substitutes its own value — there is no field to put a number in. Referencing an id the period did not issue is rejected. Overwrites any previous composition for the same period. The result is local and never committed to Git.",
  annotations: { idempotentHint: true },
  inputSchema: saveDigestProseInputSchema,
  handler: (input, ctx) =>
    mcpSaveDigestProse({
      cwd: ctx.cwd,
      clock: ctx.clock,
      random: ctx.random,
      sessionToken: input.sessionToken,
      periodUnit: input.periodUnit,
      periodKey: input.periodKey,
      prose: input.prose,
    }),
  warnings: (_input, data) => {
    const warnings: McpWarning[] = [];
    // Redaction replaces a whole field, so a silent success would tell the agent
    // its section saved when nothing of it survived.
    if (data.redactions.length > 0) {
      warnings.push({
        code: "field_redacted",
        message: `${data.redactions.length} field(s) were replaced because a secret was detected: ${data.redactions.map((r) => r.field).join(", ")}`,
      });
    }
    return warnings;
  },
});
