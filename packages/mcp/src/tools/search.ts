import { ENTITY_TYPES, mcpSearch } from "@iroha/core";
import { z } from "zod";
import type { McpWarning } from "../envelope.js";
import { defineTool } from "./types.js";

const searchInputSchema = z.strictObject({
  query: z.string().min(1).max(2000),
  repositoryPath: z.string().optional(),
  mode: z.enum(["hybrid", "lexical", "vector", "graph"]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  filters: z
    .strictObject({
      entityTypes: z.array(z.enum(ENTITY_TYPES)).optional(),
      labels: z.array(z.string()).optional(),
      statuses: z.array(z.enum(["approved", "active", "resolved"])).optional(),
      paths: z.array(z.string()).optional(),
      symbols: z.array(z.string()).optional(),
      issueRefs: z.array(z.string()).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      minimumAuthority: z.number().min(0).max(100).optional(),
    })
    .optional(),
  includeBody: z.boolean().optional(),
});

export const searchTool = defineTool({
  name: "search",
  description:
    "Retrieve approved engineering knowledge for the repository via lexical full-text search. Read-only; returns approved canonical entities, never pending candidates or raw events.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: searchInputSchema,
  handler: (input, ctx) =>
    mcpSearch({
      cwd: ctx.cwd,
      clock: ctx.clock,
      random: ctx.random,
      query: input.query,
      repositoryPath: input.repositoryPath,
      mode: input.mode,
      limit: input.limit,
      filters: input.filters,
    }),
  warnings: (input) => {
    const warnings: McpWarning[] = [];
    if (input.includeBody === true) {
      warnings.push({
        code: "unsupported_option",
        message: "includeBody is not applied yet (WP-08)",
      });
    }
    const f = input.filters;
    const hasUnsupportedFilter =
      f !== undefined &&
      ((f.labels?.length ?? 0) > 0 ||
        (f.paths?.length ?? 0) > 0 ||
        (f.symbols?.length ?? 0) > 0 ||
        (f.issueRefs?.length ?? 0) > 0 ||
        f.from !== undefined ||
        f.to !== undefined);
    if (hasUnsupportedFilter) {
      warnings.push({
        code: "unsupported_filter",
        message: "labels/paths/symbols/issueRefs/from/to filters are not applied yet (WP-08)",
      });
    }
    if (input.mode !== undefined && input.mode !== "lexical") {
      warnings.push({
        code: "degraded",
        message: `served lexical FTS only; ${input.mode} ranking is WP-08`,
      });
    }
    return warnings;
  },
});
