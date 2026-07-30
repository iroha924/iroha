import { type McpProposeKnowledgeData, mcpProposeKnowledge, proposalSchema } from "@iroha/core";
import { z } from "zod";
import type { McpWarning } from "../envelope.js";
import { defineTool } from "./types.js";

const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const proposeKnowledgeInputSchema = z.strictObject({
  sessionToken: z.string().min(1),
  idempotencyKey: idempotencyKeySchema,
  proposal: proposalSchema,
  sourceCheckpointId: z.string().optional(),
  supersedesCandidateId: z.string().optional(),
});

export const proposeKnowledgeTool = defineTool({
  name: "propose_knowledge",
  description:
    "Create one pending knowledge candidate outside a checkpoint. Never writes canonical files; the candidate stays local and pending until a human approves it. Idempotent by idempotencyKey. The body must be a canonical body: an H1 equal to the title, then that type's required H2 sections (decision: Context, Decision, Rationale, Consequences, Alternatives considered; rule: Rule, Scope, Rationale, Examples, Exceptions; insight: Observation, Evidence, Implication, Recommended action; incident: Summary, Impact, Timeline, Root cause, Resolution, Prevention; pattern: Problem, Pattern, When to use, When not to use, Examples; review_learning: Review finding, Why it matters, Resolution, Generalized learning; concept: Definition, Domain context, Examples, Related concepts). Before calling this, re-read the title, summary, and the prose under each heading — in separate reads for non-words, calqued phrasing, unnatural collocation, invented terminology, and padding — and fix what a native speaker of the content language would not write. Leave the H2 headings above in English even when the content language is not: they are contract constants matched exactly, so translating one is rejected as a missing section. Leave commands, file paths, symbols, and URLs verbatim too.",
  annotations: { idempotentHint: true },
  inputSchema: proposeKnowledgeInputSchema,
  handler: (input, ctx) =>
    mcpProposeKnowledge({
      cwd: ctx.cwd,
      clock: ctx.clock,
      random: ctx.random,
      sessionToken: input.sessionToken,
      idempotencyKey: input.idempotencyKey,
      proposal: input.proposal,
      sourceCheckpointId: input.sourceCheckpointId,
      supersedesCandidateId: input.supersedesCandidateId,
    }),
  warnings: (_input, data: McpProposeKnowledgeData) => {
    const warnings: McpWarning[] = [];
    if (data.duplicateCandidateIds.length > 0) {
      warnings.push({
        code: "likely_duplicate",
        message: `${data.duplicateCandidateIds.length} existing candidate(s) of this type share this title; not merged (see data.duplicateCandidateIds)`,
      });
    }
    return warnings;
  },
});
