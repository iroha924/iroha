import { z } from "zod";
import {
  entityIdSchema,
  labelSchema,
  relativePathSchema,
  repositoryIdSchema,
  timestampSchema,
  typedId,
  unique,
} from "./shared.js";

/**
 * Mirrors schemas/canonical-v1.schema.json `$defs.actorRef`.
 */
export const actorRefSchema = z.strictObject({
  provider: z.enum(["git", "github", "gitlab", "local"]),
  id: z.string().max(200).optional(),
  display_name: z.string().min(1).max(120),
});

/**
 * Mirrors schemas/canonical-v1.schema.json `$defs.scope`.
 */
export const scopeSchema = z.strictObject({
  repository: repositoryIdSchema,
  paths: unique(z.array(relativePathSchema(500))).max(100),
  symbols: unique(z.array(z.string().min(1).max(500))).max(100),
  languages: unique(z.array(z.string().regex(/^[a-z0-9+#.-]{1,32}$/)).max(20)).optional(),
});

/**
 * Mirrors schemas/canonical-v1.schema.json `$defs.source`.
 */
export const sourceSchema = z.strictObject({
  type: z.enum([
    "session",
    "checkpoint",
    "issue",
    "pull_request",
    "review",
    "commit",
    "file",
    "symbol",
    "document",
    "url",
  ]),
  ref: z.string().min(1).max(500),
  url: z.url().max(2048).optional(),
  path: z.string().max(500).optional(),
  line_start: z.number().int().min(1).optional(),
  line_end: z.number().int().min(1).optional(),
  quote_hash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  captured_at: timestampSchema.optional(),
});

const RELATION_TYPES = [
  "ADDRESSES",
  "IMPLEMENTED_IN",
  "PRODUCED",
  "AUTHORED_BY",
  "REVIEWED_IN",
  "DERIVED_FROM",
  "APPLIES_TO",
  "AFFECTS",
  "VALIDATED_BY",
  "BLOCKED_BY",
  "SUPERSEDES",
  "CONTRADICTS",
  "DUPLICATES",
  "RELATED_TO",
  "PARENT_OF",
] as const;

/**
 * Mirrors schemas/canonical-v1.schema.json `$defs.relation`.
 */
export const relationSchema = z.strictObject({
  type: z.enum(RELATION_TYPES),
  target: entityIdSchema,
  note: z.string().max(500).optional(),
});

/**
 * Mirrors schemas/canonical-v1.schema.json `$defs.commonFrontmatter`. Each
 * type-specific variant below extends this shape, narrows `id`/`type`, and
 * adds its own required type-specific object.
 */
const commonFrontmatterShape = {
  schema_version: z.literal(1),
  id: entityIdSchema,
  title: z.string().min(1).max(160),
  status: z.enum(["approved", "superseded", "archived"]),
  revision: z.number().int().min(1),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  created_by: actorRefSchema,
  approved_by: actorRefSchema,
  approved_at: timestampSchema,
  labels: unique(z.array(labelSchema)).max(50),
  scope: scopeSchema,
  sources: z.array(sourceSchema).min(1).max(100),
  relations: z.array(relationSchema).max(200),
};

const commonFrontmatterBase = z.object(commonFrontmatterShape);

const sessionSummaryFrontmatter = commonFrontmatterBase
  .extend({
    id: typedId("ses"),
    type: z.literal("session_summary"),
    session: z.strictObject({
      platforms: unique(z.array(z.enum(["claude_code", "codex"]))).min(1),
      run_count: z.number().int().min(1),
      outcome: z.enum(["completed", "partial", "blocked", "no_change"]),
    }),
  })
  .strict();

const decisionFrontmatter = commonFrontmatterBase
  .extend({
    id: typedId("dec"),
    type: z.literal("decision"),
    decision: z.strictObject({
      kind: z.enum(["architecture", "product", "implementation", "process"]),
    }),
  })
  .strict();

const guardSchema = z.strictObject({
  tools: unique(z.array(z.string().max(100))).min(1),
  paths: unique(z.array(z.string().max(500))).describe(
    "Repo-relative POSIX path globs (picomatch). A guard path protects itself and its whole subtree, so `src/generated` and `src/generated/**` are equivalent; use a globstar to cross directories, e.g. `**/*.env`.",
  ),
  deny_commands: unique(z.array(z.string().max(500))).optional(),
});

const ruleFrontmatter = commonFrontmatterBase
  .extend({
    id: typedId("rul"),
    type: z.literal("rule"),
    rule: z
      .strictObject({
        enforcement: z.enum(["advisory", "guardrail"]),
        severity: z.enum(["info", "warning", "error"]),
        guard: guardSchema.optional(),
      })
      .superRefine((value, ctx) => {
        if (value.enforcement === "guardrail" && value.guard === undefined) {
          ctx.addIssue({
            code: "custom",
            message: 'a "guardrail" rule requires a "guard" object',
            path: ["guard"],
          });
        }
        if (value.enforcement === "advisory" && value.guard !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: 'an "advisory" rule must not include a "guard" object',
            path: ["guard"],
          });
        }
      }),
  })
  .strict();

const conceptFrontmatter = commonFrontmatterBase
  .extend({
    id: typedId("con"),
    type: z.literal("concept"),
    concept: z.strictObject({
      domain: z.string().max(120),
    }),
  })
  .strict();

const insightFrontmatter = commonFrontmatterBase
  .extend({
    id: typedId("ins"),
    type: z.literal("insight"),
    insight: z.strictObject({
      category: z.enum(["implementation", "review", "quality", "domain", "process"]),
    }),
  })
  .strict();

const incidentFrontmatter = commonFrontmatterBase
  .extend({
    id: typedId("inc"),
    type: z.literal("incident"),
    incident: z.strictObject({
      severity: z.enum(["low", "medium", "high", "critical"]),
      resolution: z.enum(["open", "mitigated", "resolved"]),
    }),
  })
  .strict();

const patternFrontmatter = commonFrontmatterBase
  .extend({
    id: typedId("pat"),
    type: z.literal("pattern"),
    pattern: z.strictObject({
      maturity: z.enum(["emerging", "established", "deprecated"]),
    }),
  })
  .strict();

const reviewLearningFrontmatter = commonFrontmatterBase
  .extend({
    id: typedId("rev"),
    type: z.literal("review_learning"),
    review_learning: z.strictObject({
      category: z.enum([
        "correctness",
        "security",
        "performance",
        "maintainability",
        "testing",
        "product",
      ]),
    }),
  })
  .strict();

/**
 * Mirrors the `frontmatter` property in schemas/canonical-v1.schema.json:
 * `commonFrontmatter` intersected with exactly one of the 8 type-specific
 * `oneOf` branches, discriminated on `type`.
 */
export const canonicalFrontmatterSchema = z.discriminatedUnion("type", [
  sessionSummaryFrontmatter,
  decisionFrontmatter,
  ruleFrontmatter,
  conceptFrontmatter,
  insightFrontmatter,
  incidentFrontmatter,
  patternFrontmatter,
  reviewLearningFrontmatter,
]);

/**
 * Mirrors the top-level envelope in schemas/canonical-v1.schema.json.
 */
export const canonicalDocumentSchema = z.strictObject({
  frontmatter: canonicalFrontmatterSchema,
  body: z.string().min(1).max(100000),
});

export type CanonicalDocument = z.infer<typeof canonicalDocumentSchema>;
