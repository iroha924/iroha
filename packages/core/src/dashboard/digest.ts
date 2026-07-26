/**
 * The iroha Digest: a per-period editorial read over facts iroha already
 * records, and the deterministic half of the number/prose split.
 *
 * Every number here is computed from the database on demand. Nothing is
 * snapshotted, nothing is committed to `.iroha/`, and no approval gate applies:
 * a Digest asserts no new team truth, it is a *view* over already-recorded
 * activity and already-approved knowledge, so it sits outside the
 * candidate→approve→canonical boundary rather than sneaking past it. Its local
 * inputs (`tool_events`, `checkpoints`) are disposable index state that
 * `sync --rebuild` drops, which is also why a Digest could not be canonical even
 * if we wanted it to be — canonical.md §1 requires everything there to be
 * reconstructible from the committed files, and §2 keeps complete tool inputs and
 * outputs out of it in the first place.
 *
 * The two scopes and the rule that keeps facts from drifting between them are in
 * `.claude/rules/digest-scopes.md`.
 */
import type { Clock, IrohaError, RandomSource, Result, TypedId } from "@iroha/domain";
import { ok } from "@iroha/domain";
import {
  countPendingReviewLearnings,
  type Database,
  type DigestKnowledgeRef,
  type DigestList,
  type DigestWindowFacts,
  type Executor,
  getDigestIssue,
  getDigestWindowFacts,
  getLocalSetting,
  type KnowledgeEntityType,
  listApprovedRulesForRepository,
} from "@iroha/storage";
import { z } from "zod";
import { classifyGuardSpec, type GuardEnforceability } from "../hooks/guardrail.js";
import {
  type DigestPeriod,
  type DigestPeriodUnit,
  priorDigestPeriod,
  resolveDigestPeriod,
} from "./digest-period.js";
import { type DigestProseIssue, parseStoredProse, renderProse } from "./digest-prose.js";
import { withDashboardRepository } from "./with-repository.js";

/** `local_settings.key` holding this developer's preferred Digest window. */
export const DIGEST_PERIOD_SETTING_KEY = "digest.period";

export const digestPeriodSettingSchema = z.strictObject({
  unit: z.enum(["week", "month"]),
});

export type DigestPeriodSetting = z.infer<typeof digestPeriodSettingSchema>;

export const DIGEST_PERIOD_DEFAULT: DigestPeriodSetting = { unit: "week" };

/**
 * Reads the window preference, falling back to the default for an absent,
 * unparseable, or out-of-enum value.
 *
 * Deliberately more forgiving than `readRetentionSetting`, which errors on a
 * malformed value. That setting governs deletion, where guessing at intent is
 * unsafe; this one governs which seven days a page shows, where refusing to
 * render the Digest at all is the worse failure.
 *
 * The preference is per-developer and lives in `local_settings`, never in the
 * Git-shared `config.yaml`. It does not compromise the team scope's
 * "identical for every teammate" property: that property is about the facts for a
 * *given* window, not about everyone choosing the same window.
 */
export async function readDigestPeriodSetting(
  db: Executor,
  repositoryId: TypedId<"repo">,
): Promise<Result<DigestPeriodSetting, IrohaError>> {
  const row = await getLocalSetting(db, repositoryId, DIGEST_PERIOD_SETTING_KEY);
  if (!row.ok) {
    return row;
  }
  if (row.value === null) {
    return ok(DIGEST_PERIOD_DEFAULT);
  }
  try {
    const validated = digestPeriodSettingSchema.safeParse(JSON.parse(row.value.valueJson));
    return ok(validated.success ? validated.data : DIGEST_PERIOD_DEFAULT);
  } catch {
    return ok(DIGEST_PERIOD_DEFAULT);
  }
}

/**
 * A number the Digest is prepared to state, addressed by a stable id.
 *
 * This is the seam between iroha's numbers and an agent's prose. The composing
 * agent receives these ids and may reference them in its text; it is never given
 * a slot to write a number into, and the renderer substitutes iroha's value for
 * each reference. Fabricated figures are therefore not a thing prose can express
 * — the failure mode the seam does *not* prevent is prose that contradicts a
 * correct number ("a quiet week" over a denial spike), which is why numbers
 * render as authoritative and prose is labelled unreviewed.
 *
 * Ids are derived from what the fact *is*, not from a counter or a random seed,
 * so prose composed against one page load still resolves on the next.
 */
export interface DigestFact {
  id: string;
  value: number;
  /**
   * What the number means, in English, for the composing agent. The dashboard
   * renders its own localized labels from the structured data and never shows
   * this.
   */
  label: string;
}

/** A correlation iroha found, so prose can narrate a link rather than invent one. */
export interface DigestCorrelation {
  kind: "denial_cluster";
  /**
   * What the cluster *is* — the leading path segments its members share. This is
   * the cluster's identity, and what its fact id is built from; the rank it
   * happens to hold in the list is not.
   */
  key: string;
  /** The repo paths the cluster covers, most-denied first. */
  paths: string[];
  count: number;
}

export interface DigestDelta {
  value: number;
  priorValue: number;
}

/**
 * How well the approved Guardrail set can actually be enforced by the hook —
 * "the setup failed the agent" as a first-class metric alongside "the agent broke
 * a rule". A Guardrail that names no paths cannot be enforced at the hook at all
 * (contracts/hooks.md §8), and a malformed spec is skipped outright, so both are
 * as much a story as a denial count.
 */
export type DigestRulesetAdequacy = Record<GuardEnforceability, number>;

export interface DigestLocalScope {
  denials: DigestDelta & {
    byRule: { ruleId: string | null; ruleTitle: string | null; count: number }[];
  };
  checkpoints: DigestDelta & { byOutcome: DigestWindowFacts["checkpoints"]["byOutcome"] };
  sessions: DigestDelta;
  /**
   * Pending `review_learning` Candidates — "you might be missing a Rule". Both
   * producers count: recurrences Forge detected, and lessons an agent proposed
   * from a Checkpoint. Local, not team — either source is per clone, so two
   * teammates can legitimately see different numbers.
   */
  pendingReviewLearnings: number;
  /**
   * Capped at `MAX_CLUSTERS` for display, with the real number of clusters in
   * `total`. Without that, prose told "these are the clusters" could honestly
   * claim denials clustered in exactly five areas when there were nine.
   */
  correlations: DigestList<DigestCorrelation>;
}

export interface DigestTeamScope {
  knowledge: DigestDelta & { byType: Record<KnowledgeEntityType, number> };
  guardrailsChanged: DigestList<DigestKnowledgeRef>;
  reviewLearnings: DigestList<DigestKnowledgeRef>;
  rulesetAdequacy: DigestRulesetAdequacy;
}

export interface DigestData {
  /**
   * The period these facts cover. `offset` is the *resolved* offset, which is what
   * a client must read to know which issue it got — an out-of-range request is
   * clamped, so the offset asked for and the offset served can differ, and a
   * client trusting its own value would render the wrong archive controls.
   */
  period: DigestPeriod;
  local: DigestLocalScope;
  team: DigestTeamScope;
  facts: DigestFact[];
  /**
   * The composed narration, with every `{{factId}}` already substituted, or
   * `null` when this period has none. `null` is a normal state, not a failure:
   * the page renders templated copy over the live numbers, in the same spirit as
   * embedding failure degrading to lexical search.
   */
  prose: DigestProseIssue | null;
}

/**
 * How many leading path segments a denial cluster groups on. Two is the level at
 * which this monorepo's paths become meaningful (`packages/git`,
 * `apps/dashboard`); one would collapse everything under `packages` into a single
 * uninformative cluster.
 */
const CLUSTER_SEGMENTS = 2;

/** A cluster needs at least this many denials — a single denial is not a pattern. */
const MIN_CLUSTER_COUNT = 2;

/** At most this many clusters, strongest first, so prose has a short list to work from. */
const MAX_CLUSTERS = 5;

function clusterKey(path: string): string {
  return path.split("/").slice(0, CLUSTER_SEGMENTS).join("/");
}

/**
 * Group denied paths by their leading segments, strongest cluster first.
 *
 * The ordering is presentational only. Each cluster's *identity* is its `key`,
 * which is what `buildFacts` addresses it by — a rank would change owner the
 * moment another denial landed, and a citation written against rank 0 would then
 * render a different cluster's number while still resolving.
 */
function denialClusters(targets: readonly { path: string; count: number }[]): DigestCorrelation[] {
  const grouped = new Map<string, { paths: { path: string; count: number }[]; count: number }>();
  for (const target of targets) {
    const key = clusterKey(target.path);
    const entry = grouped.get(key) ?? { paths: [], count: 0 };
    entry.paths.push(target);
    entry.count += target.count;
    grouped.set(key, entry);
  }
  return [...grouped.entries()]
    .filter(([, entry]) => entry.count >= MIN_CLUSTER_COUNT)
    .sort(([keyA, a], [keyB, b]) => b.count - a.count || keyA.localeCompare(keyB))
    .map(([key, entry]) => ({
      kind: "denial_cluster" as const,
      key,
      paths: entry.paths
        .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
        .map((target) => target.path),
      count: entry.count,
    }));
}

/** Cap the clusters shown while keeping the real count, so prose cannot imply it saw them all. */
function capClusters(clusters: DigestCorrelation[]): DigestList<DigestCorrelation> {
  const items = clusters.slice(0, MAX_CLUSTERS);
  return { items, total: clusters.length, truncated: clusters.length > items.length };
}

/**
 * The fact table for one Digest.
 *
 * Every number the page or the prose may state appears here exactly once, which
 * is what makes `save_digest_prose`'s validation possible: a reference is valid
 * if and only if its id is in this list. A number rendered on the page but absent
 * here would be one prose could not cite; one present here but never rendered
 * would be a claim with no visible source.
 */
function buildFacts(local: DigestLocalScope, team: DigestTeamScope): DigestFact[] {
  const facts: DigestFact[] = [
    { id: "local.denials.total", value: local.denials.value, label: "Guardrail denials" },
    {
      id: "local.denials.priorTotal",
      value: local.denials.priorValue,
      label: "Guardrail denials in the previous period",
    },
    { id: "local.sessions.total", value: local.sessions.value, label: "Sessions" },
    {
      id: "local.sessions.priorTotal",
      value: local.sessions.priorValue,
      label: "Sessions in the previous period",
    },
    { id: "local.checkpoints.total", value: local.checkpoints.value, label: "Checkpoints saved" },
    {
      id: "local.checkpoints.priorTotal",
      value: local.checkpoints.priorValue,
      label: "Checkpoints saved in the previous period",
    },
    {
      id: "local.pendingReviewLearnings",
      value: local.pendingReviewLearnings,
      label: "Review lessons awaiting approval",
    },
    { id: "team.knowledge.total", value: team.knowledge.value, label: "Knowledge approved" },
    {
      id: "team.knowledge.priorTotal",
      value: team.knowledge.priorValue,
      label: "Knowledge approved in the previous period",
    },
    // `total`, never `items.length`: the items are capped for display, so a fact
    // taken from their length reports the cap for any period that overflows it.
    {
      id: "team.guardrailsChanged.total",
      value: team.guardrailsChanged.total,
      label: "Guardrails added or changed",
    },
    {
      id: "team.reviewLearnings.total",
      value: team.reviewLearnings.total,
      label: "Review lessons promoted",
    },
    {
      id: "local.correlations.total",
      value: local.correlations.total,
      label: "Distinct areas denials clustered in",
    },
  ];
  for (const [outcome, count] of Object.entries(local.checkpoints.byOutcome)) {
    facts.push({
      id: `local.checkpoints.byOutcome.${outcome}`,
      value: count,
      label: `Checkpoints with outcome "${outcome}"`,
    });
  }
  for (const row of local.denials.byRule) {
    facts.push({
      id: `local.denials.byRule.${row.ruleId ?? "unattributed"}`,
      value: row.count,
      label: `Denials by rule ${row.ruleTitle ?? row.ruleId ?? "(unattributed)"}`,
    });
  }
  for (const [type, count] of Object.entries(team.knowledge.byType)) {
    facts.push({
      id: `team.knowledge.byType.${type}`,
      value: count,
      label: `Approved knowledge of type "${type}"`,
    });
  }
  for (const [kind, count] of Object.entries(team.rulesetAdequacy)) {
    facts.push({
      id: `team.rulesetAdequacy.${kind}`,
      value: count,
      label: `Guardrails classified "${kind}"`,
    });
  }
  for (const correlation of local.correlations.items) {
    facts.push({
      id: `local.correlations.${correlation.key}.count`,
      value: correlation.count,
      label: `Denials clustered in ${correlation.key}`,
    });
  }
  return facts;
}

/**
 * Classify the approved Guardrail set. Reuses the hook's own
 * `classifyGuardSpec`, so the Digest's adequacy story and what the hook can
 * actually enforce are the same judgement rather than two similar ones — the same
 * reason `iroha doctor` calls it.
 */
async function readRulesetAdequacy(
  db: Executor,
  repositoryId: TypedId<"repo">,
): Promise<Result<DigestRulesetAdequacy, IrohaError>> {
  const listed = await listApprovedRulesForRepository(db, repositoryId);
  if (!listed.ok) {
    return listed;
  }
  const adequacy: DigestRulesetAdequacy = {
    enforceable: 0,
    not_hook_enforceable: 0,
    invalid: 0,
  };
  for (const rule of listed.value) {
    if (rule.enforcement !== "guardrail") {
      continue;
    }
    adequacy[classifyGuardSpec(rule.guardSpecJson)] += 1;
  }
  return ok(adequacy);
}

export interface DigestSelection {
  /** Overrides the stored window preference (the archive's unit switch). */
  unit?: DigestPeriodUnit | undefined;
  /** 0 (default) is the current period; higher values are back issues. */
  offset?: number | undefined;
}

export interface GetDigestInput extends DigestSelection {
  cwd: string;
  clock: Clock;
  random: RandomSource;
}

/**
 * The parts of a request context a Digest computation needs. Structural rather
 * than one of the two named contexts, because both reach here: the dashboard read
 * path (`withDashboardRepository`) and the MCP compose path
 * (`withMcpRepository`), which differ only in carrying an HMAC salt.
 */
export interface DigestComputeContext {
  db: Database;
  repo: { repositoryId: TypedId<"repo"> };
  clock: Clock;
}

/** The period a request asks for: the caller's overrides over the stored preference. */
export async function resolveRequestedPeriod(
  ctx: DigestComputeContext,
  selection: DigestSelection,
): Promise<Result<DigestPeriod, IrohaError>> {
  const stored = await readDigestPeriodSetting(ctx.db, ctx.repo.repositoryId);
  if (!stored.ok) {
    return stored;
  }
  return ok(
    resolveDigestPeriod(selection.unit ?? stored.value.unit, selection.offset ?? 0, ctx.clock),
  );
}

/**
 * Compute one issue against an open connection: the numbers, the fact table, and
 * the stored prose rendered against them.
 *
 * Takes an **already-resolved** period rather than a selection. A selection is
 * relative to "now", so re-resolving it here would read the clock a second time —
 * and a save that crosses a period boundary between naming its period and
 * computing the facts would then validate references against the *next* period's
 * facts while storing under the named key.
 *
 * Shared by the read path and the compose path so both work from the same fact
 * table: if composing validated against its own computation, prose could be
 * accepted citing a fact the page never renders.
 */
export async function computeDigest(
  ctx: DigestComputeContext,
  period: DigestPeriod,
): Promise<Result<DigestData, IrohaError>> {
  const repositoryId = ctx.repo.repositoryId;
  const prior = priorDigestPeriod(period, ctx.clock);

  const [currentFacts, priorFacts, pendingLearnings, adequacy, issue] = await Promise.all([
    getDigestWindowFacts(ctx.db, repositoryId, period),
    getDigestWindowFacts(ctx.db, repositoryId, prior),
    countPendingReviewLearnings(ctx.db, repositoryId),
    readRulesetAdequacy(ctx.db, repositoryId),
    getDigestIssue(ctx.db, repositoryId, period.unit, period.key),
  ]);
  if (!currentFacts.ok) {
    return currentFacts;
  }
  if (!priorFacts.ok) {
    return priorFacts;
  }
  if (!pendingLearnings.ok) {
    return pendingLearnings;
  }
  if (!adequacy.ok) {
    return adequacy;
  }
  if (!issue.ok) {
    return issue;
  }

  const now = currentFacts.value;
  const before = priorFacts.value;
  const local: DigestLocalScope = {
    denials: {
      value: now.denials.total,
      priorValue: before.denials.total,
      byRule: now.denials.byRule,
    },
    checkpoints: {
      value: now.checkpoints.total,
      priorValue: before.checkpoints.total,
      byOutcome: now.checkpoints.byOutcome,
    },
    sessions: { value: now.sessions, priorValue: before.sessions },
    pendingReviewLearnings: pendingLearnings.value,
    correlations: capClusters(denialClusters(now.denials.allTargets)),
  };
  const team: DigestTeamScope = {
    knowledge: {
      value: now.approvedKnowledge.total,
      priorValue: before.approvedKnowledge.total,
      byType: now.approvedKnowledge.byType,
    },
    guardrailsChanged: now.guardrailsChanged,
    reviewLearnings: now.promotedReviewLearnings,
    rulesetAdequacy: adequacy.value,
  };
  const facts = buildFacts(local, team);
  const storedProse =
    issue.value === null ? null : parseStoredProse(issue.value.proseJson, issue.value.composedAt);

  return ok({
    period,
    local,
    team,
    facts,
    prose:
      storedProse === null
        ? null
        : { ...storedProse, prose: renderProse(storedProse.prose, facts) },
  });
}

/**
 * Compute one Digest issue (`GET /api/v1/digest`).
 *
 * The numbers are always current: they are read on request, not composed by an
 * agent, so the page is never blank and never stale — with no prose it renders as
 * templated copy over live figures. That degraded state is the normal state, in
 * the same spirit as embedding failure degrading to lexical search.
 */
export async function getDigest(input: GetDigestInput): Promise<Result<DigestData, IrohaError>> {
  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const period = await resolveRequestedPeriod(ctx, input);
      return period.ok ? computeDigest(ctx, period.value) : period;
    },
  );
}
