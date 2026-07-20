import type { Clock, IrohaError, RandomSource, Result } from "@iroha/core";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { McpWarning } from "../envelope.js";

/** Per-request execution context injected by the server. */
export interface McpToolContext {
  cwd: string;
  clock: Clock;
  random: RandomSource;
}

/**
 * A tool with its input type erased so the registry can hold the heterogeneous
 * set. The dispatcher strict-parses `inputSchema` before calling `handler`, so
 * `handler`'s runtime argument is always the schema's validated output.
 */
export interface AnyMcpTool {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: z.ZodType;
  handler: (input: unknown, ctx: McpToolContext) => Promise<Result<unknown, IrohaError>>;
  /** Optional per-request advisories (e.g. a filter that is not applied yet). */
  warnings?: (input: unknown) => McpWarning[];
}

/** Binds a typed input schema to a typed handler, then erases to `AnyMcpTool`. */
export function defineTool<S extends z.ZodType, Data>(tool: {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: S;
  handler: (input: z.output<S>, ctx: McpToolContext) => Promise<Result<Data, IrohaError>>;
  warnings?: (input: z.output<S>) => McpWarning[];
}): AnyMcpTool {
  return tool as unknown as AnyMcpTool;
}
