import { type IrohaError, ok, type Result, type TypedId } from "@iroha/domain";
import type { MatchSource } from "@iroha/search";
import {
  type EntityRow,
  type EntityType,
  type Executor,
  getCanonicalDocumentByEntityId,
  getEntityById,
  getNeighbors,
  getSubgraph,
  getWorkItemByExternalId,
  type RelationType,
} from "@iroha/storage";

/** canonical-schema.md §5 source kinds. */
export type SourceKind =
  | "session"
  | "checkpoint"
  | "issue"
  | "pull_request"
  | "review"
  | "commit"
  | "file"
  | "symbol"
  | "document"
  | "url";

const SOURCE_KINDS = new Set<string>([
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
]);

/** Provenance reference surfaced on a search result (mcp-contract.md §6.1). */
export interface SourceRef {
  type: SourceKind;
  ref: string;
  path?: string;
  lineStart?: number;
}

/** A single typed edge to a neighbouring entity (bounded preview, not full traversal). */
export interface RelationPreview {
  relationType: RelationType;
  direction: "outgoing" | "incoming";
  entityId: string;
  title: string;
}

/** database-schema.md §9's post-RRF scope/graph multipliers (authority + recency live in `searchHybrid`). */
const SAME_SYMBOL_MULTIPLIER = 1.35;
const SAME_PATH_MULTIPLIER = 1.25;
const SAME_ISSUE_MULTIPLIER = 1.3;
const GRAPH_DISTANCE_MULTIPLIER: Record<number, number> = { 1: 1.15, 2: 1.08, 3: 1.03 };
const GRAPH_MAX_DEPTH = 3;
const GRAPH_MAX_EDGES = 200;
/** Bounded relation preview per result. */
const MAX_RELATION_PREVIEWS = 6;
/** mcp-contract.md §6.1: `includeBody` caps at 10 results / 30,000 characters. */
const INCLUDE_BODY_MAX_RESULTS = 10;
const INCLUDE_BODY_MAX_CHARS = 30_000;

export interface QueryScope {
  paths: readonly string[];
  symbols: readonly string[];
  issueRefs: readonly string[];
}

export interface RankFilters {
  minimumAuthority: number;
  statuses?: readonly string[] | undefined;
  entityTypes?: readonly EntityType[] | undefined;
  labels?: readonly string[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export interface RankParams {
  scope: QueryScope;
  filters: RankFilters;
  limit: number;
  includeBody: boolean;
}

export interface RankCandidate {
  entityId: string;
  baseScore: number;
  matchedBy: readonly MatchSource[];
}

export interface RankedResult {
  entity: EntityRow;
  score: number;
  whyRelevant: string[];
  sources: SourceRef[];
  relations: RelationPreview[];
  body?: string;
}

interface EntityFacets {
  scopePaths: string[];
  scopeSymbols: string[];
  labels: string[];
  sources: SourceRef[];
  body: string;
}

const EMPTY_FACETS: EntityFacets = {
  scopePaths: [],
  scopeSymbols: [],
  labels: [],
  sources: [],
  body: "",
};

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseSources(value: unknown): SourceRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: SourceRef[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.type !== "string" || !SOURCE_KINDS.has(record.type)) {
      continue;
    }
    if (typeof record.ref !== "string") {
      continue;
    }
    const source: SourceRef = { type: record.type as SourceKind, ref: record.ref };
    if (typeof record.path === "string") {
      source.path = record.path;
    }
    if (typeof record.line_start === "number") {
      source.lineStart = record.line_start;
    }
    out.push(source);
  }
  return out;
}

/**
 * Simplified prefix globbing shared with `get_active_rules` (mcp-contract.md §6.3):
 * `src/x/**` and `src/x/*` match by prefix, a bare path matches itself or a child.
 * Full glob semantics remain deferred (surfaced as a tool warning there).
 */
export function pathMatches(scopePath: string, requested: string): boolean {
  if (scopePath.endsWith("/**")) {
    return requested.startsWith(scopePath.slice(0, -3));
  }
  if (scopePath.endsWith("*")) {
    return requested.startsWith(scopePath.slice(0, -1));
  }
  return requested === scopePath || requested.startsWith(`${scopePath}/`);
}

async function loadFacets(
  db: Executor,
  entityId: string,
): Promise<Result<EntityFacets, IrohaError>> {
  const doc = await getCanonicalDocumentByEntityId(db, entityId);
  if (!doc.ok) {
    return doc;
  }
  if (doc.value === null) {
    return ok(EMPTY_FACETS);
  }
  try {
    const fm = JSON.parse(doc.value.frontmatterJson) as Record<string, unknown>;
    const scope = (fm.scope ?? {}) as Record<string, unknown>;
    return ok({
      scopePaths: toStringArray(scope.paths),
      scopeSymbols: toStringArray(scope.symbols),
      labels: toStringArray(fm.labels),
      sources: parseSources(fm.sources),
      body: doc.value.body,
    });
  } catch {
    return ok({ ...EMPTY_FACETS, body: doc.value.body });
  }
}

/**
 * BFS distances from an anchor set over the bounded relation subgraph (edges
 * treated as undirected for proximity). Anchors are distance 0; the map only
 * contains nodes reachable within `maxDepth`.
 */
async function graphDistances(
  db: Executor,
  anchorIds: readonly string[],
  maxDepth: number,
): Promise<Result<Map<string, number>, IrohaError>> {
  const distances = new Map<string, number>();
  if (anchorIds.length === 0) {
    return ok(distances);
  }
  const subgraph = await getSubgraph(db, [...anchorIds], maxDepth, GRAPH_MAX_EDGES);
  if (!subgraph.ok) {
    return subgraph;
  }
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    let set = adjacency.get(a);
    if (set === undefined) {
      set = new Set<string>();
      adjacency.set(a, set);
    }
    set.add(b);
  };
  for (const edge of subgraph.value) {
    link(edge.fromEntityId, edge.toEntityId);
    link(edge.toEntityId, edge.fromEntityId);
  }
  const queue: string[] = [];
  for (const anchor of anchorIds) {
    if (!distances.has(anchor)) {
      distances.set(anchor, 0);
      queue.push(anchor);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current === undefined) {
      continue;
    }
    const distance = distances.get(current) ?? 0;
    if (distance >= maxDepth) {
      continue;
    }
    for (const neighbour of adjacency.get(current) ?? []) {
      if (!distances.has(neighbour)) {
        distances.set(neighbour, distance + 1);
        queue.push(neighbour);
      }
    }
  }
  return ok(distances);
}

/** Base-score decay per graph hop away from a lexical seed (mode="graph" expansion). */
const GRAPH_SEED_DECAY = 0.4;

/**
 * `mode="graph"` expansion: keeps the lexical `seeds` and adds their graph
 * neighbours (within `maxDepth`) as extra candidates, each carrying a decayed
 * base score so relation-reachable entities surface even when no FTS/vector
 * term matched them. `rankCandidates` then applies the same scope/graph boosts.
 */
export async function graphExpandedCandidates(
  db: Executor,
  seeds: readonly RankCandidate[],
  maxDepth = 2,
): Promise<Result<RankCandidate[], IrohaError>> {
  if (seeds.length === 0) {
    return ok([]);
  }
  const byId = new Map<string, RankCandidate>();
  for (const seed of seeds) {
    byId.set(seed.entityId, seed);
  }
  const maxSeedScore = Math.max(...seeds.map((seed) => seed.baseScore));
  const distances = await graphDistances(
    db,
    seeds.map((seed) => seed.entityId),
    maxDepth,
  );
  if (!distances.ok) {
    return distances;
  }
  for (const [entityId, distance] of distances.value) {
    if (distance >= 1 && !byId.has(entityId)) {
      byId.set(entityId, {
        entityId,
        baseScore: maxSeedScore * GRAPH_SEED_DECAY ** distance,
        matchedBy: [],
      });
    }
  }
  return ok([...byId.values()]);
}

async function resolveIssueAnchors(
  db: Executor,
  repositoryId: TypedId<"repo">,
  issueRefs: readonly string[],
): Promise<Result<string[], IrohaError>> {
  const anchors: string[] = [];
  for (const ref of issueRefs) {
    for (const provider of ["github", "gitlab"] as const) {
      const workItem = await getWorkItemByExternalId(db, repositoryId, provider, ref);
      if (!workItem.ok) {
        return workItem;
      }
      if (workItem.value !== null) {
        anchors.push(workItem.value.id);
        break;
      }
    }
  }
  return ok(anchors);
}

function inDateRange(updatedAt: string, from?: string, to?: string): boolean {
  if (from !== undefined && updatedAt < from) {
    return false;
  }
  if (to !== undefined && updatedAt > to) {
    return false;
  }
  return true;
}

interface Survivor {
  candidate: RankCandidate;
  entity: EntityRow;
  facets: EntityFacets;
  symbolHit: boolean;
  pathHit: boolean;
}

async function buildRelations(
  db: Executor,
  entityId: string,
): Promise<Result<RelationPreview[], IrohaError>> {
  const neighbours = await getNeighbors(db, entityId, {
    direction: "both",
    limit: MAX_RELATION_PREVIEWS,
  });
  if (!neighbours.ok) {
    return neighbours;
  }
  const previews: RelationPreview[] = [];
  for (const edge of neighbours.value) {
    const outgoing = edge.fromEntityId === entityId;
    const otherId = outgoing ? edge.toEntityId : edge.fromEntityId;
    const other = await getEntityById(db, otherId);
    if (!other.ok) {
      return other;
    }
    previews.push({
      relationType: edge.relationType,
      direction: outgoing ? "outgoing" : "incoming",
      entityId: otherId,
      title: other.value?.title ?? otherId,
    });
  }
  return ok(previews);
}

/**
 * Applies database-schema.md §9's scope/graph boosts to `searchHybrid`'s
 * base-scored candidates, filters by the hard filters, then enriches the final
 * result cap with provenance (`sources`), a bounded relation preview, and a
 * human-readable `whyRelevant`. `paths`/`symbols`/`issueRefs` act as scope hints
 * (they boost, never exclude); `statuses`/`entityTypes`/`labels`/date/authority
 * are hard filters (decision-log records this split).
 */
export async function rankCandidates(
  db: Executor,
  repositoryId: TypedId<"repo">,
  candidates: readonly RankCandidate[],
  params: RankParams,
): Promise<Result<RankedResult[], IrohaError>> {
  const issueAnchors = await resolveIssueAnchors(db, repositoryId, params.scope.issueRefs);
  if (!issueAnchors.ok) {
    return issueAnchors;
  }

  const survivors: Survivor[] = [];
  const scopeAnchors: string[] = [];
  for (const candidate of candidates) {
    const entityResult = await getEntityById(db, candidate.entityId);
    if (!entityResult.ok) {
      return entityResult;
    }
    const entity = entityResult.value;
    if (entity === null || entity.authority < params.filters.minimumAuthority) {
      continue;
    }
    if (params.filters.statuses !== undefined && !params.filters.statuses.includes(entity.status)) {
      continue;
    }
    if (
      params.filters.entityTypes !== undefined &&
      !params.filters.entityTypes.includes(entity.entityType)
    ) {
      continue;
    }
    if (!inDateRange(entity.updatedAt, params.filters.from, params.filters.to)) {
      continue;
    }
    const facetsResult = await loadFacets(db, candidate.entityId);
    if (!facetsResult.ok) {
      return facetsResult;
    }
    const facets = facetsResult.value;
    if (
      params.filters.labels !== undefined &&
      params.filters.labels.length > 0 &&
      !params.filters.labels.some((label) => facets.labels.includes(label))
    ) {
      continue;
    }
    const symbolHit = params.scope.symbols.some((symbol) => facets.scopeSymbols.includes(symbol));
    const pathHit = params.scope.paths.some((path) =>
      facets.scopePaths.some((scopePath) => pathMatches(scopePath, path)),
    );
    if (symbolHit || pathHit) {
      scopeAnchors.push(candidate.entityId);
    }
    survivors.push({ candidate, entity, facets, symbolHit, pathHit });
  }

  const scopeDistances = await graphDistances(
    db,
    [...new Set([...scopeAnchors, ...issueAnchors.value])],
    GRAPH_MAX_DEPTH,
  );
  if (!scopeDistances.ok) {
    return scopeDistances;
  }
  const issueDistances = await graphDistances(db, issueAnchors.value, 1);
  if (!issueDistances.ok) {
    return issueDistances;
  }

  interface Scored extends Survivor {
    score: number;
    reasons: string[];
  }
  const scored: Scored[] = survivors.map((survivor) => {
    const reasons = survivor.candidate.matchedBy.map((source) => `${source} match`);
    let score = survivor.candidate.baseScore;
    if (survivor.entity.authority >= 100) {
      reasons.push("approved canonical");
    } else if (survivor.entity.authority >= 80) {
      reasons.push("verified source");
    }
    if (survivor.symbolHit) {
      score *= SAME_SYMBOL_MULTIPLIER;
      reasons.push("same symbol scope");
    }
    if (survivor.pathHit) {
      score *= SAME_PATH_MULTIPLIER;
      reasons.push("same path scope");
    }
    if (issueDistances.value.get(survivor.candidate.entityId) === 1) {
      score *= SAME_ISSUE_MULTIPLIER;
      reasons.push("linked to an active issue");
    }
    const distance = scopeDistances.value.get(survivor.candidate.entityId);
    if (distance !== undefined && distance >= 1) {
      const graphMultiplier = GRAPH_DISTANCE_MULTIPLIER[distance];
      if (graphMultiplier !== undefined) {
        score *= graphMultiplier;
        reasons.push(`graph distance ${distance}`);
      }
    }
    return { ...survivor, score, reasons };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, params.limit);

  const results: RankedResult[] = [];
  let bodyBudget = INCLUDE_BODY_MAX_CHARS;
  for (const item of top) {
    const relations = await buildRelations(db, item.candidate.entityId);
    if (!relations.ok) {
      return relations;
    }
    const result: RankedResult = {
      entity: item.entity,
      score: item.score,
      whyRelevant: item.reasons,
      sources: item.facets.sources,
      relations: relations.value,
    };
    if (
      params.includeBody &&
      results.length < INCLUDE_BODY_MAX_RESULTS &&
      item.facets.body.length <= bodyBudget
    ) {
      result.body = item.facets.body;
      bodyBudget -= item.facets.body.length;
    }
    results.push(result);
  }
  return ok(results);
}
