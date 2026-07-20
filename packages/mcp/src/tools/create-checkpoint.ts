import { checkpointInputSchema, mcpCreateCheckpoint } from "@iroha/core";
import type { McpWarning } from "../envelope.js";
import { defineTool } from "./types.js";

export const createCheckpointTool = defineTool({
  name: "create_checkpoint",
  description:
    "Save structured progress for the current turn and optionally create knowledge candidates. Local and non-canonical: candidates stay pending until a human approves them. Idempotent by idempotencyKey; free-text fields are secret-scanned and redacted.",
  annotations: { idempotentHint: true },
  inputSchema: checkpointInputSchema,
  handler: (input, ctx) =>
    mcpCreateCheckpoint({ cwd: ctx.cwd, clock: ctx.clock, random: ctx.random, input }),
  warnings: (input) => {
    const warnings: McpWarning[] = [];
    // mcp-contract.md §6.6 step 6 (materialize reference relations as graph
    // edges) is deferred; the references are stored on the checkpoint, but
    // get_relations will not yet traverse them.
    const hasReferences =
      input.references.length > 0 ||
      input.proposals.some((proposal) => (proposal.relations?.length ?? 0) > 0);
    if (hasReferences) {
      warnings.push({
        code: "unsupported_option",
        message: "references are stored but not yet materialized as graph edges (WP-08)",
      });
    }
    return warnings;
  },
});
