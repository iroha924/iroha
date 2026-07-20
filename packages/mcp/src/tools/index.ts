import { getActiveRulesTool } from "./get-active-rules.js";
import { getContextTool } from "./get-context.js";
import { getRelationsTool } from "./get-relations.js";
import { getSessionStateTool } from "./get-session-state.js";
import { searchTool } from "./search.js";
import type { AnyMcpTool } from "./types.js";

/**
 * The complete agent-facing tool set. Approval, canonical publication, and
 * deletion are intentionally absent (mcp-contract.md §10) — this list is the
 * structural guarantee that no such operation is exposed to a model.
 */
export const TOOLS: readonly AnyMcpTool[] = [
  searchTool,
  getContextTool,
  getActiveRulesTool,
  getRelationsTool,
  getSessionStateTool,
];
