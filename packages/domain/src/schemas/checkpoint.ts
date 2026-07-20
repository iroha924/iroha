import { z } from "zod";
import { labelSchema, relativePathSchema, typedId, unique } from "./shared.js";

/** Matches implementation/mcp-contract.md §5: `ist_<43 base64url characters>`. */
export const sessionTokenSchema = z.string().regex(/^ist_[A-Za-z0-9_-]{43}$/);

const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

/**
 * Mirrors schemas/checkpoint-v1.schema.json `$defs.implementationItem`:
 * `change` is always required, and at least one of `file`/`symbol` must
 * also be present (both may be).
 */
const implementationItemSchema = z
  .strictObject({
    file: relativePathSchema(500).optional(),
    symbol: z.string().max(500).optional(),
    change: z.string().min(1).max(2000),
  })
  .refine((value) => value.file !== undefined || value.symbol !== undefined, {
    message: "at least one of file or symbol is required",
    path: ["file"],
  });

/** Mirrors schemas/checkpoint-v1.schema.json `$defs.validationItem`. */
const validationItemSchema = z.strictObject({
  command: z.string().max(2000).optional(),
  result: z.enum(["passed", "failed", "not_run"]),
  note: z.string().max(2000).optional(),
  durationMs: z.number().int().min(0).optional(),
});

/**
 * Mirrors schemas/checkpoint-v1.schema.json `$defs.reference`. Distinct from
 * canonical's `$defs.source`: no "session"/"checkpoint" reference kinds here.
 */
const referenceSchema = z.strictObject({
  type: z.enum(["issue", "pull_request", "review", "commit", "file", "symbol", "url", "document"]),
  ref: z.string().min(1).max(500),
  url: z.url().max(2048).optional(),
  path: relativePathSchema(500).optional(),
});

/**
 * Mirrors schemas/checkpoint-v1.schema.json `$defs.scope`. Unlike canonical's
 * `$defs.scope`, there is no `repository` field.
 */
const checkpointScopeSchema = z.strictObject({
  paths: unique(z.array(relativePathSchema(500))).max(100),
  symbols: unique(z.array(z.string().max(500))).max(100),
  languages: unique(z.array(z.string().regex(/^[a-z0-9+#.-]{1,32}$/)))
    .max(20)
    .optional(),
});

/**
 * Mirrors schemas/checkpoint-v1.schema.json `$defs.guard`. Unlike canonical's
 * `rule.guard.paths` (plain strings), `paths` here uses `relativePath` and
 * therefore rejects traversal/absolute values.
 */
const proposalGuardSchema = z.strictObject({
  tools: unique(z.array(z.string().max(100))).min(1),
  paths: unique(z.array(relativePathSchema(500))),
  denyCommands: unique(z.array(z.string().max(500))).optional(),
});

const proposalRelationSchema = z.strictObject({
  type: z.string().max(50),
  target: z.string().max(64),
});

/**
 * Mirrors schemas/checkpoint-v1.schema.json `$defs.proposal`. Only the
 * guardrail-requires-guard direction is enforced (unlike canonical's `rule`,
 * an advisory proposal may still carry a `guard` object).
 */
export const proposalSchema = z
  .strictObject({
    type: z.enum([
      "decision",
      "rule",
      "concept",
      "insight",
      "incident",
      "pattern",
      "review_learning",
    ]),
    title: z.string().min(1).max(160),
    summary: z.string().min(1).max(1000),
    body: z.string().min(1).max(20000),
    confidence: z.number().min(0).max(1).optional(),
    labels: unique(z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))).max(50),
    scope: checkpointScopeSchema,
    enforcement: z.enum(["advisory", "guardrail"]).optional(),
    guard: proposalGuardSchema.optional(),
    sources: z.array(referenceSchema).min(1).max(100),
    relations: z.array(proposalRelationSchema).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.enforcement === "guardrail" && value.guard === undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'a "guardrail" proposal requires a "guard" object',
        path: ["guard"],
      });
    }
  });

/**
 * Mirrors the top-level object in schemas/checkpoint-v1.schema.json: the
 * `create_checkpoint` MCP tool input.
 */
export const checkpointInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionToken: sessionTokenSchema,
  idempotencyKey: idempotencyKeySchema,
  turnId: typedId("trn").optional(),
  outcome: z.enum(["completed", "partial", "blocked", "no_change"]),
  objective: z.string().min(1).max(1000),
  summary: z.string().min(1).max(5000),
  implementation: z.array(implementationItemSchema).max(200),
  validation: z.array(validationItemSchema).max(100),
  unresolved: z.array(z.string().min(1).max(1000)).max(100),
  references: z.array(referenceSchema).max(100),
  labels: unique(z.array(labelSchema)).max(50),
  proposals: z.array(proposalSchema).max(50),
});

export type CheckpointInput = z.infer<typeof checkpointInputSchema>;

/**
 * A single knowledge proposal — the `create_checkpoint` `proposals[]` element
 * and the `propose_knowledge` `proposal` field share one shape
 * (mcp-contract.md §7 `KnowledgeProposal`).
 */
export type KnowledgeProposal = z.infer<typeof proposalSchema>;
