import { checkpointInputSchema, mcpCreateCheckpoint } from "@iroha/core";
import { defineTool } from "./types.js";

export const createCheckpointTool = defineTool({
  name: "create_checkpoint",
  description:
    "Save structured progress for the current turn and optionally create knowledge candidates. Local and non-canonical: candidates stay pending until a human approves them. Idempotent by idempotencyKey; free-text fields are secret-scanned and redacted.",
  annotations: { idempotentHint: true },
  inputSchema: checkpointInputSchema,
  handler: (input, ctx) =>
    mcpCreateCheckpoint({ cwd: ctx.cwd, clock: ctx.clock, random: ctx.random, input }),
  // `references[]` are now materialized as `checkpoint RELATED_TO entity` edges
  // for refs that resolve to a known entity (mcp-contract.md §6.6 step 6), and a
  // proposal's `relations[]` become canonical edges when the candidate is
  // approved (`build-canonical.ts` → `insertCanonicalDocumentRelations`), so the
  // former "not yet materialized" advisory no longer applies.
});
