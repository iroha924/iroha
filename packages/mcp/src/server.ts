import type { Clock, RandomSource } from "@iroha/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { dispatchTool } from "./dispatch.js";
import { TOOLS } from "./tools/index.js";

export const SERVER_NAME = "iroha";
export const SERVER_VERSION = "0.1.0";

/**
 * The server instructions. mcp-contract.md §3 requires the first 512 characters
 * to be self-contained and to carry no repository data or secrets.
 */
export const SERVER_INSTRUCTIONS =
  "iroha stores and retrieves approved engineering knowledge for the current Git repository. Search before making architecture or rule-sensitive changes. Create a checkpoint after meaningful implementation, decisions, validation, or discoveries. Checkpoints and proposals are local candidates, not approved team rules. Never claim a proposal is authoritative. Human approval is only available in the iroha dashboard or CLI.";

export interface McpServerDeps {
  cwd: string;
  clock: Clock;
  random: RandomSource;
}

function toListing(): Tool[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema) as Tool["inputSchema"],
    annotations: tool.annotations,
  }));
}

/**
 * Builds the stdio MCP server. Tool listing and dispatch are handled directly
 * (not via `McpServer.registerTool`) so that unknown fields are rejected and
 * every outcome is a typed §4 envelope, rather than being silently stripped or
 * surfaced as an untyped protocol error.
 */
export function buildServer(deps: McpServerDeps): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toListing() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    dispatchTool(request.params.name, request.params.arguments, deps),
  );

  return server;
}
