import { mcpGetActiveRules } from "@iroha/core";
import { z } from "zod";
import type { McpWarning } from "../envelope.js";
import { defineTool } from "./types.js";

const getActiveRulesInputSchema = z.strictObject({
  repositoryPath: z.string().optional(),
  paths: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  toolName: z.string().optional(),
  commandCategory: z.string().optional(),
  includeAdvisory: z.boolean().optional(),
  includeGuardrails: z.boolean().optional(),
});

export const getActiveRulesTool = defineTool({
  name: "get_active_rules",
  description:
    "Return the approved advisory Rules and Guardrails applicable to the given paths/symbols, distinguishing advisory from guardrail enforcement. Read-only; raw guard specs are not returned.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: getActiveRulesInputSchema,
  handler: (input, ctx) =>
    mcpGetActiveRules({
      cwd: ctx.cwd,
      clock: ctx.clock,
      random: ctx.random,
      repositoryPath: input.repositoryPath,
      paths: input.paths,
      symbols: input.symbols,
      includeAdvisory: input.includeAdvisory,
      includeGuardrails: input.includeGuardrails,
    }),
  warnings: (input) => {
    const warnings: McpWarning[] = [];
    if ((input.paths?.length ?? 0) > 0 || (input.symbols?.length ?? 0) > 0) {
      warnings.push({
        code: "partial_scope_match",
        message: "scope matching uses simplified prefix globbing (WP-08)",
      });
    }
    if (input.toolName !== undefined || input.commandCategory !== undefined) {
      warnings.push({
        code: "unsupported_option",
        message: "toolName/commandCategory matching is not applied yet (WP-08)",
      });
    }
    return warnings;
  },
});
