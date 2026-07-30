import type { Clock, IrohaError, RandomSource, Result, TypedId } from "@iroha/domain";
import { ok } from "@iroha/domain";
import {
  type CheckpointOutcome,
  countPendingReviewLearnings,
  type DenialByRule,
  type Executor,
  getDenialFacts,
  getLatestCheckpointForRepository,
  getOverviewCounts,
  getSyncCursor,
  type KnowledgeEntityType,
  listApprovedRulesForRepository,
  listOpenDirtyMarkers,
  probeCapabilities,
  type StorageCapabilities,
} from "@iroha/storage";
import { classifyGuardSpec, type GuardEnforceability } from "../hooks/guardrail.js";
import { readSchemaVersion } from "../schema-version.js";
import { withDashboardRepository } from "./with-repository.js";

/**
 * How well the approved Guardrail set can actually be enforced by the hook —
 * "the setup failed the agent" alongside "the agent broke a rule". A Guardrail
 * that names no paths cannot be enforced at the hook at all (contracts/hooks.md
 * §8) and a malformed spec is skipped outright, so both are defects a reader can
 * go and fix today. Current state, not windowed.
 */
export type RulesetAdequacy = Record<GuardEnforceability, number>;

/**
 * A group of denied paths sharing their leading segments. Carries the key and the
 * count, never the member paths: the page shows only those two, and the
 * underlying aggregate is uncapped, so returning every distinct path would ship
 * an unbounded array nobody reads on a five-second poll.
 */
export interface DenialCluster {
  /** The shared leading path segments — the cluster's identity. */
  key: string;
  count: number;
}

/**
 * Guardrail denials over a fixed recent window. The window is fixed rather than
 * selectable because Overview reports current state: "which Rule keeps stopping
 * the agent, and where" is a question about now, and a selector would turn the
 * page back into the period newsletter this replaced.
 */
export interface OverviewDenials {
  windowDays: number;
  total: number;
  byRule: DenialByRule[];
  /** Capped for display, with the real cluster count in `total`. */
  clusters: { items: DenialCluster[]; total: number; truncated: boolean };
}

/**
 * The Checkpoint an agent is handed back, and the only Checkpoint anything reads
 * — `listCheckpointsBySession(db, sessionId, 1)` in the SessionStart hook, in
 * `get_session_state`, and in `get_context`. Shown because that text passes no
 * review step: only a Checkpoint's `proposals` become Candidates a human
 * approves, while `summary` and `unresolved` are stored as written and fed back
 * on resume, after a compaction, and to the next tool call in the same session
 * (#199). It is not an activity volume — the count of Checkpoints written stays
 * deliberately absent (`dashboard-api.md` §7).
 */
export interface OverviewLatestCheckpoint {
  id: string;
  outcome: CheckpointOutcome;
  summary: string;
  unresolved: string[];
  createdAt: string;
  /** The session it belongs to, so a reader can tell whose text this is. */
  sessionId: string;
}

/**
 * `unresolved_json` is a JSON array by DB CHECK, but a rebuilt or hand-edited
 * index could hold anything, and one malformed row must not fail the whole page.
 */
function parseUnresolved(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export interface OverviewData {
  pendingCandidates: number;
  oldestPendingCreatedAt: string | null;
  approvedKnowledge: number;
  /** Approved-knowledge composition by canonical type (feeds the Overview chart). */
  approvedKnowledgeByType: Record<KnowledgeEntityType, number>;
  openDirtyMarkers: number;
  lastCanonicalSyncAt: string | null;
  rulesetAdequacy: RulesetAdequacy;
  denials: OverviewDenials;
  /**
   * Pending `review_learning` Candidates — "you might be missing a Rule". Local,
   * not team: either producer is per clone, so two teammates can legitimately see
   * different numbers.
   */
  pendingReviewLearnings: number;
  /** `null` when no Checkpoint has been written in this repository yet. */
  latestCheckpoint: OverviewLatestCheckpoint | null;
}

/** The window the denial facts cover. */
const DENIAL_WINDOW_DAYS = 30;

/**
 * How many leading path segments a denial cluster groups on. Two is the level at
 * which a monorepo's paths become meaningful (`packages/git`, `apps/dashboard`);
 * one would collapse everything under `packages` into a single uninformative
 * cluster.
 */
const CLUSTER_SEGMENTS = 2;

/** A cluster needs at least this many denials — a single denial is not a pattern. */
const MIN_CLUSTER_COUNT = 2;

/** At most this many clusters, strongest first. */
const MAX_CLUSTERS = 5;

/**
 * Group denied paths by their leading segments, strongest cluster first. The
 * ordering is presentational; a cluster's identity is its `key`.
 */
function denialClusters(targets: readonly { path: string; count: number }[]): DenialCluster[] {
  const grouped = new Map<string, number>();
  for (const target of targets) {
    const key = target.path.split("/").slice(0, CLUSTER_SEGMENTS).join("/");
    grouped.set(key, (grouped.get(key) ?? 0) + target.count);
  }
  return [...grouped.entries()]
    .filter(([, count]) => count >= MIN_CLUSTER_COUNT)
    .sort(([keyA, a], [keyB, b]) => b - a || keyA.localeCompare(keyB))
    .map(([key, count]) => ({ key, count }));
}

/**
 * Classify the approved Guardrail set. Reuses the hook's own `classifyGuardSpec`,
 * so this page's adequacy story and what the hook can actually enforce are the
 * same judgement rather than two similar ones — the same reason `iroha doctor`
 * calls it.
 */
async function readRulesetAdequacy(
  db: Executor,
  repositoryId: TypedId<"repo">,
): Promise<Result<RulesetAdequacy, IrohaError>> {
  const listed = await listApprovedRulesForRepository(db, repositoryId);
  if (!listed.ok) {
    return listed;
  }
  const adequacy: RulesetAdequacy = { enforceable: 0, not_hook_enforceable: 0, invalid: 0 };
  for (const rule of listed.value) {
    if (rule.enforcement !== "guardrail") {
      continue;
    }
    adequacy[classifyGuardSpec(rule.guardSpecJson)] += 1;
  }
  return ok(adequacy);
}

export interface GetOverviewInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
}

/**
 * Overview page data (`GET /api/v1/overview`) — the front page: pending-candidate
 * pressure, approved-knowledge composition, unresolved dirty markers, how
 * enforceable the approved Guardrail set is, and where the agent kept being
 * stopped over the last {@link DENIAL_WINDOW_DAYS} days.
 *
 * Every number here is one a reader can act on. Activity volumes — sessions
 * started, checkpoints written, per-period totals — are deliberately absent: they
 * are counted but never acted on, and browsing an activity log is not what this
 * product is for. Deliberately has no per-person metric either; individual
 * productivity ranking is forbidden.
 */
export async function getOverview(
  input: GetOverviewInput,
): Promise<Result<OverviewData, IrohaError>> {
  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const counts = await getOverviewCounts(ctx.db, ctx.repo.repositoryId);
      if (!counts.ok) {
        return counts;
      }
      const dirty = await listOpenDirtyMarkers(ctx.db, ctx.repo.repositoryId);
      if (!dirty.ok) {
        return dirty;
      }
      const cursor = await getSyncCursor(ctx.db, ctx.repo.repositoryId, "canonical");
      if (!cursor.ok) {
        return cursor;
      }
      const adequacy = await readRulesetAdequacy(ctx.db, ctx.repo.repositoryId);
      if (!adequacy.ok) {
        return adequacy;
      }
      const now = input.clock.now();
      const denials = await getDenialFacts(ctx.db, ctx.repo.repositoryId, {
        start: new Date(now.getTime() - DENIAL_WINDOW_DAYS * 86_400_000).toISOString(),
        end: now.toISOString(),
      });
      if (!denials.ok) {
        return denials;
      }
      const learnings = await countPendingReviewLearnings(ctx.db, ctx.repo.repositoryId);
      if (!learnings.ok) {
        return learnings;
      }
      const latest = await getLatestCheckpointForRepository(ctx.db, ctx.repo.repositoryId);
      if (!latest.ok) {
        return latest;
      }
      const clusters = denialClusters(denials.value.targets);
      const shown = clusters.slice(0, MAX_CLUSTERS);
      return ok({
        pendingCandidates: counts.value.pendingCandidates,
        oldestPendingCreatedAt: counts.value.oldestPendingCreatedAt,
        approvedKnowledge: counts.value.approvedKnowledge,
        approvedKnowledgeByType: counts.value.approvedKnowledgeByType,
        openDirtyMarkers: dirty.value.length,
        lastCanonicalSyncAt: cursor.value?.lastSuccessAt ?? null,
        rulesetAdequacy: adequacy.value,
        denials: {
          windowDays: DENIAL_WINDOW_DAYS,
          total: denials.value.total,
          byRule: denials.value.byRule,
          clusters: {
            items: shown,
            total: clusters.length,
            truncated: clusters.length > shown.length,
          },
        },
        pendingReviewLearnings: learnings.value,
        latestCheckpoint:
          latest.value === null
            ? null
            : {
                id: latest.value.id,
                outcome: latest.value.outcome,
                summary: latest.value.summary,
                unresolved: parseUnresolved(latest.value.unresolvedJson),
                createdAt: latest.value.createdAt,
                sessionId: latest.value.sessionId,
              },
      });
    },
  );
}

export interface BootstrapData {
  repository: {
    id: string;
    defaultLanguage: "ja" | "en";
    requireHumanApproval: boolean;
  };
  schema: {
    version: string | null;
    supported: boolean;
  };
  capabilities: StorageCapabilities;
  embedding: {
    enabled: boolean;
  };
}

export interface GetBootstrapInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
}

/**
 * Startup summary the SPA loads first (`GET /api/v1/bootstrap`): repository
 * identity, UI language, schema status, and capability/embedding flags. The
 * embedding secret is reported only as a presence boolean (secrets are
 * never exposed).
 */
export async function getBootstrap(
  input: GetBootstrapInput,
): Promise<Result<BootstrapData, IrohaError>> {
  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const schemaVersion = await readSchemaVersion(ctx.repo.irohaCanonicalDir);
      const capabilities = await probeCapabilities(ctx.db, ctx.random);
      const embedding = ctx.repo.config.search.embedding;
      return ok({
        repository: {
          id: ctx.repo.repositoryId,
          defaultLanguage: ctx.repo.config.default_language,
          requireHumanApproval: ctx.repo.config.canonical.require_human_approval,
        },
        schema: {
          version: schemaVersion.ok ? schemaVersion.value : null,
          supported: schemaVersion.ok && schemaVersion.value !== null,
        },
        capabilities,
        embedding: {
          enabled: embedding.enabled,
        },
      });
    },
  );
}
