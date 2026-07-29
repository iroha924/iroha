import { checkpointInputSchema, mcpCreateCheckpoint } from "@iroha/core";
import { defineTool } from "./types.js";

export const createCheckpointTool = defineTool({
  name: "create_checkpoint",
  description:
    "Save structured progress for the current turn and optionally create knowledge candidates. Local and non-canonical: candidates stay pending until a human approves them. Idempotent by idempotencyKey; free-text fields are secret-scanned and redacted. Each proposal body must be a canonical body: an H1 equal to its title, then that type's required H2 sections (decision: Context, Decision, Rationale, Consequences, Alternatives considered; rule: Rule, Scope, Rationale, Examples, Exceptions; insight: Observation, Evidence, Implication, Recommended action; incident: Summary, Impact, Timeline, Root cause, Resolution, Prevention; pattern: Problem, Pattern, When to use, When not to use, Examples; review_learning: Review finding, Why it matters, Resolution, Generalized learning; concept: Definition, Domain context, Examples, Related concepts). A body that is not is rejected, and the whole checkpoint with it.",
  annotations: { idempotentHint: true },
  inputSchema: checkpointInputSchema,
  handler: (input, ctx) =>
    mcpCreateCheckpoint({ cwd: ctx.cwd, clock: ctx.clock, random: ctx.random, input }),
});
