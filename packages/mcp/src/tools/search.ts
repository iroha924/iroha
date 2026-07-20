import { ENTITY_TYPES, mcpSearch } from "@iroha/core";
import { z } from "zod";
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
    "Retrieve approved engineering knowledge for the repository via hybrid retrieval (lexical full-text + vector + graph, RRF-fused with authority/scope/graph boosts). Read-only; returns approved canonical entities, never pending candidates or raw events. When embedding is unconfigured or unavailable, it degrades to lexical and reports `degradedFrom` in the response.",
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
      includeBody: input.includeBody,
      filters: input.filters,
    }),
});
