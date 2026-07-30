import { checkpointInputSchema, mcpCreateCheckpoint } from "@iroha/core";
import { defineTool } from "./types.js";

export const createCheckpointTool = defineTool({
  name: "create_checkpoint",
  description:
    "Save structured progress for the current turn and optionally create knowledge candidates. Local and non-canonical: candidates stay pending until a human approves them. Idempotent by idempotencyKey; free-text fields are secret-scanned and redacted. Each proposal body must be a canonical body: an H1 equal to its title, then that type's required H2 sections (decision: Context, Decision, Rationale, Consequences, Alternatives considered; rule: Rule, Scope, Rationale, Examples, Exceptions; insight: Observation, Evidence, Implication, Recommended action; incident: Summary, Impact, Timeline, Root cause, Resolution, Prevention; pattern: Problem, Pattern, When to use, When not to use, Examples; review_learning: Review finding, Why it matters, Resolution, Generalized learning; concept: Definition, Domain context, Examples, Related concepts). A body that is not is rejected, and the whole checkpoint with it. Before calling this, re-read every field you wrote prose into — `objective`, `summary`, `unresolved`, `implementation[].change`, `validation[].note`, and each proposal's `title`/`summary`/`body` — in separate reads for non-words, calqued phrasing, unnatural collocation, invented terminology, and padding, then fix what a native speaker of the content language would not write; `summary` and `unresolved` are stored with no later review step and are read back by a future session. Leave verbatim everything that is not prose: commands, file paths, symbols, URLs, and the canonical H2 headings listed above, which are matched exactly and stay English in every locale. The `checkpoint` skill carries the full procedure.",
  annotations: { idempotentHint: true },
  inputSchema: checkpointInputSchema,
  handler: (input, ctx) =>
    mcpCreateCheckpoint({ cwd: ctx.cwd, clock: ctx.clock, random: ctx.random, input }),
});
