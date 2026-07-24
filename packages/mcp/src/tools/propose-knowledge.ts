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
    "Create one pending knowledge candidate outside a checkpoint. Never writes canonical files; the candidate stays local and pending until a human approves it. Idempotent by idempotencyKey.",
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
