import { mcpGetSessionState } from "@iroha/core";
import { z } from "zod";
import { defineTool } from "./types.js";

export const getSessionStateTool = defineTool({
  name: "get_session_state",
  description:
    "Inspect the caller's current local iroha session state: Session/Run/Turn IDs, branch, start SHA, last checkpoint summary, pending-checkpoint status, unresolved items, and known issue/PR references. Read-only; never returns raw prompt or tool contents.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: z.strictObject({ sessionToken: z.string().min(1) }),
  handler: (input, ctx) =>
    mcpGetSessionState({
      cwd: ctx.cwd,
      clock: ctx.clock,
      random: ctx.random,
      sessionToken: input.sessionToken,
    }),
});
