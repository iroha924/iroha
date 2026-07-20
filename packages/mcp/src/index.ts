/**
 * @iroha/mcp — stdio MCP transport and tools.
 */
export const packageName = "@iroha/mcp";

export { dispatchTool } from "./dispatch.js";
export {
  failureEnvelope,
  type McpEnvelope,
  type McpFailure,
  type McpSuccess,
  type McpWarning,
  newTraceId,
  successEnvelope,
} from "./envelope.js";
export {
  buildServer,
  type McpServerDeps,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  SERVER_VERSION,
} from "./server.js";
export { TOOLS } from "./tools/index.js";
export type { AnyMcpTool, McpToolContext } from "./tools/types.js";
