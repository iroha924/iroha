import { mcpGetContext } from "@iroha/core";
import { z } from "zod";
import { defineTool } from "./types.js";

const getContextInputSchema = z.strictObject({
  sessionToken: z.string().min(1),
  query: z.string().max(2000).optional(),
  activeIssueRefs: z.array(z.string()).optional(),
  paths: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  maxItems: z.number().int().min(1).max(20).optional(),
  maxCharacters: z.number().int().min(1).max(16000).optional(),
});

export const getContextTool = defineTool({
  name: "get_context",
  description:
    "Create a bounded context pack (relevant approved knowledge plus the session's unresolved items) for the current task. Read-only; excludes pending candidates and raw contents.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: getContextInputSchema,
  handler: (input, ctx) =>
    mcpGetContext({
      cwd: ctx.cwd,
      clock: ctx.clock,
      random: ctx.random,
      sessionToken: input.sessionToken,
      query: input.query,
      activeIssueRefs: input.activeIssueRefs,
      paths: input.paths,
      symbols: input.symbols,
      maxItems: input.maxItems,
      maxCharacters: input.maxCharacters,
    }),
});
