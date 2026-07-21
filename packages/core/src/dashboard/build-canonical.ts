import type {
  CanonicalDocument,
  Clock,
  IrohaError,
  KnowledgeProposal,
  RandomSource,
  Result,
  TypedId,
} from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, makeTypedId, ok } from "@iroha/domain";
import type { CandidateType } from "@iroha/storage";

/**
 * A privacy-safe actor reference (canonical-schema.md §6 `created_by`/
 * `approved_by`). Matches `@iroha/domain`'s `actorRefSchema` shape.
 */
export interface CanonicalActorRef {
  provider: "git" | "github" | "gitlab" | "local";
  id?: string;
  display_name: string;
}

/**
 * The canonical type-specific classification a reviewer may set on a candidate
 * draft (dashboard-api.md §6 "editable ... metadata"). A `KnowledgeProposal`
 * carries none of these fields, so when the reviewer has not set them the
 * approval derives a deterministic default (see `resolveClassification`).
 */
export interface CandidateClassification {
  decisionKind?: "architecture" | "product" | "implementation" | "process";
  ruleSeverity?: "info" | "warning" | "error";
  conceptDomain?: string;
  insightCategory?: "implementation" | "review" | "quality" | "domain" | "process";
  incidentSeverity?: "low" | "medium" | "high" | "critical";
  incidentResolution?: "open" | "mitigated" | "resolved";
  patternMaturity?: "emerging" | "established" | "deprecated";
  reviewLearningCategory?:
    | "correctness"
    | "security"
    | "performance"
    | "maintainability"
    | "testing"
    | "product";
}

/**
 * The stored candidate `payload_json`: a `KnowledgeProposal` (as written by the
 * MCP checkpoint/propose tools) optionally augmented by the dashboard edit
 * endpoint with reviewer-set canonical classification.
 */
export type CandidateDraft = KnowledgeProposal & { classification?: CandidateClassification };

/** canonical-schema.md §5 relation types — the only `type` values a canonical `relations[]` edge may hold. */
const CANONICAL_RELATION_TYPES = new Set([
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
]);

/** A canonical provenance source (`sources[]`) the approval prepends: the originating Session/Checkpoint. */
export interface CanonicalProvenanceSource {
  type: "session" | "checkpoint";
  ref: string;
}

type CanonicalSource = CanonicalDocument["frontmatter"]["sources"][number];
type CanonicalRelation = CanonicalDocument["frontmatter"]["relations"][number];

export interface BuildCanonicalInput {
  candidateType: CandidateType;
  /** Parsed candidate `payload_json`. */
  draft: CandidateDraft;
  repositoryId: TypedId<"repo">;
  /** Mints the new canonical entity id with the correct type prefix (`dec_`, `rul_`, ...). */
  clock: Clock;
  random: RandomSource;
  createdBy: CanonicalActorRef;
  approvedBy: CanonicalActorRef;
  /** RFC 3339 UTC. `created_at` = when proposed; `updated_at`/`approved_at` = approval time. */
  createdAt: string;
  approvedAt: string;
  revision: number;
  /** Session/Checkpoint provenance to prepend to `sources[]`. */
  provenance: CanonicalProvenanceSource[];
}

interface CommonFrontmatter {
  schema_version: 1;
  title: string;
  status: "approved";
  revision: number;
  created_at: string;
  updated_at: string;
  created_by: CanonicalActorRef;
  approved_by: CanonicalActorRef;
  approved_at: string;
  labels: string[];
  scope: {
    repository: TypedId<"repo">;
    paths: string[];
    symbols: string[];
    languages?: string[];
  };
  sources: CanonicalSource[];
  relations: CanonicalRelation[];
}

function mapSources(input: BuildCanonicalInput): CanonicalSource[] {
  const provenance: CanonicalSource[] = input.provenance.map((source) => ({
    type: source.type,
    ref: source.ref,
  }));
  const proposed: CanonicalSource[] = input.draft.sources.map((source) => ({
    type: source.type,
    ref: source.ref,
    ...(source.url !== undefined ? { url: source.url } : {}),
    ...(source.path !== undefined ? { path: source.path } : {}),
  }));
  return [...provenance, ...proposed];
}

function mapRelations(draft: CandidateDraft): CanonicalRelation[] {
  return (draft.relations ?? [])
    .filter((relation) => CANONICAL_RELATION_TYPES.has(relation.type))
    .map((relation) => ({
      // Narrowed by the `CANONICAL_RELATION_TYPES` filter above; `Set.has`
      // does not refine `string` to the enum, so assert it here. `target` is a
      // free-text `string` on the proposal; `writeCanonicalDocument`'s Zod
      // validation rejects a malformed entity id at approval time.
      type: relation.type as CanonicalRelation["type"],
      target: relation.target as CanonicalRelation["target"],
    }));
}

function buildCommon(input: BuildCanonicalInput): CommonFrontmatter {
  const { draft } = input;
  return {
    schema_version: 1,
    title: draft.title,
    status: "approved",
    revision: input.revision,
    created_at: input.createdAt,
    updated_at: input.approvedAt,
    created_by: input.createdBy,
    approved_by: input.approvedBy,
    approved_at: input.approvedAt,
    labels: draft.labels,
    scope: {
      repository: input.repositoryId,
      paths: draft.scope.paths,
      symbols: draft.scope.symbols,
      ...(draft.scope.languages !== undefined ? { languages: draft.scope.languages } : {}),
    },
    sources: mapSources(input),
    relations: mapRelations(draft),
  };
}

/**
 * Builds the `CanonicalDocument` for an approved candidate from its
 * `KnowledgeProposal` payload plus approval metadata. Type-specific
 * classification comes from the reviewer's `draft.classification` when set,
 * otherwise a deterministic default (decision-log WP-09 ADR). The result is not
 * re-validated here — `writeCanonicalDocument` runs the authoritative Zod +
 * body-template + secret validation, so a proposal whose body is missing a
 * required section (or whose type-specific values are out of range) fails there
 * with `INVALID_INPUT`, matching dashboard-api.md §6 "approval is disabled
 * until validation passes".
 */
export function buildCanonicalDocumentFromCandidate(
  input: BuildCanonicalInput,
): Result<CanonicalDocument, IrohaError> {
  const common = buildCommon(input);
  const { draft } = input;
  const cls = draft.classification ?? {};
  const body = draft.body;

  switch (input.candidateType) {
    case "decision":
      return ok({
        frontmatter: {
          ...common,
          id: makeTypedId("dec", input.clock, input.random),
          type: "decision",
          decision: { kind: cls.decisionKind ?? "implementation" },
        },
        body,
      });
    case "rule": {
      const enforcement = draft.enforcement ?? "advisory";
      const guard =
        enforcement === "guardrail" && draft.guard !== undefined
          ? {
              tools: draft.guard.tools,
              paths: draft.guard.paths,
              ...(draft.guard.denyCommands !== undefined
                ? { deny_commands: draft.guard.denyCommands }
                : {}),
            }
          : undefined;
      return ok({
        frontmatter: {
          ...common,
          id: makeTypedId("rul", input.clock, input.random),
          type: "rule",
          rule: {
            enforcement,
            severity: cls.ruleSeverity ?? "warning",
            ...(guard !== undefined ? { guard } : {}),
          },
        },
        body,
      });
    }
    case "concept":
      return ok({
        frontmatter: {
          ...common,
          id: makeTypedId("con", input.clock, input.random),
          type: "concept",
          concept: { domain: cls.conceptDomain ?? "" },
        },
        body,
      });
    case "insight":
      return ok({
        frontmatter: {
          ...common,
          id: makeTypedId("ins", input.clock, input.random),
          type: "insight",
          insight: { category: cls.insightCategory ?? "implementation" },
        },
        body,
      });
    case "incident":
      return ok({
        frontmatter: {
          ...common,
          id: makeTypedId("inc", input.clock, input.random),
          type: "incident",
          incident: {
            severity: cls.incidentSeverity ?? "medium",
            resolution: cls.incidentResolution ?? "open",
          },
        },
        body,
      });
    case "pattern":
      return ok({
        frontmatter: {
          ...common,
          id: makeTypedId("pat", input.clock, input.random),
          type: "pattern",
          pattern: { maturity: cls.patternMaturity ?? "emerging" },
        },
        body,
      });
    case "review_learning":
      return ok({
        frontmatter: {
          ...common,
          id: makeTypedId("rev", input.clock, input.random),
          type: "review_learning",
          review_learning: { category: cls.reviewLearningCategory ?? "maintainability" },
        },
        body,
      });
    case "session_summary":
      // Session Summary approval is a separate publication unit
      // (canonical-schema.md §8; "never auto-published in v0.1") and is not
      // reachable from the candidate review queue in WP-09.
      return err(
        new IrohaErrorClass(
          "INVALID_INPUT",
          "Session Summary candidates are not approved through the review queue",
        ),
      );
  }
}
