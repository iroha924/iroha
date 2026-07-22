import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { err, ok } from "@iroha/domain";
import { type SearchMode, searchHybrid } from "@iroha/search";
import type { EntityType } from "@iroha/storage";
import { resolveEmbeddingProvider } from "../embedding-sync.js";
import {
  graphExpandedCandidates,
  type QueryScope,
  type RankCandidate,
  type RankFilters,
  type RelationPreview,
  rankCandidates,
  type SourceRef,
} from "./ranking.js";
import { withMcpRepository } from "./with-repository.js";

export interface McpSearchResult {
  id: string;
  type: EntityType;
  title: string;
  summary: string;
  authority: number;
  status: string;
  score: number;
  whyRelevant: string[];
  sources: SourceRef[];
  relations: RelationPreview[];
  body?: string;
}

export interface McpSearchData {
  query: string;
  effectiveMode: SearchMode;
  degradedFrom?: "hybrid" | "vector" | undefined;
  results: McpSearchResult[];
}

export interface McpSearchFilters {
  entityTypes?: EntityType[] | undefined;
  statuses?: string[] | undefined;
  labels?: string[] | undefined;
  minimumAuthority?: number | undefined;
  from?: string | undefined;
  to?: string | undefined;
  /** Scope hints: they boost matching results (same-symbol/path) rather than excluding others. */
  paths?: string[] | undefined;
  symbols?: string[] | undefined;
  issueRefs?: string[] | undefined;
}

export interface McpSearchInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  query: string;
  repositoryPath?: string | undefined;
  mode?: SearchMode | undefined;
  limit?: number | undefined;
  includeBody?: boolean | undefined;
  filters?: McpSearchFilters | undefined;
}

const DEFAULT_MINIMUM_AUTHORITY = 60;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/**
 * `search` (mcp-contract.md §6.1): database-schema.md §9's hybrid retrieval over
 * approved/verified entities. When embedding is configured and the query
 * embedding succeeds, the vector term joins the FTS RRF sum; otherwise the
 * request degrades to lexical (CLAUDE.md: "embedding failure must degrade to
 * lexical search"). `rankCandidates` then applies the authority/scope/graph
 * boosts and enriches results with `whyRelevant`, provenance, and a bounded
 * relation preview. `mode="graph"` expands lexical seeds along the relation
 * graph before ranking.
 */
export async function mcpSearch(input: McpSearchInput): Promise<Result<McpSearchData, IrohaError>> {
  return withMcpRepository(
    { cwd: input.repositoryPath ?? input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      // Clamp both bounds: the MCP/API transports reject `limit < 1` at their Zod
      // boundary, but `runSearch` (the CLI) forwards the raw value, and a negative
      // limit reaches `rankCandidates`'s `slice(0, limit)` — `slice(0, -1)` drops
      // rows instead of capping. Defend the contract (1..MAX_LIMIT) at the use case.
      const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
      const filters = input.filters ?? {};
      const now = ctx.clock.now().toISOString();
      const requestedMode: SearchMode = input.mode ?? "hybrid";

      let queryVector: readonly number[] | undefined;
      let degradedFrom: "hybrid" | "vector" | undefined;
      if (requestedMode !== "lexical") {
        // `graph` seeds with the vector too: a long relationship query rarely
        // satisfies the lexical arm's all-terms AND, so lexical-only seeds would
        // leave the graph expansion nothing to grow from.
        const provider = resolveEmbeddingProvider(ctx.repo.config.search.embedding);
        const embedded = provider === null ? null : await provider.embed([input.query], "query");
        if (embedded !== null && embedded.ok && embedded.value[0] !== undefined) {
          queryVector = embedded.value[0];
        } else if (requestedMode === "hybrid" || requestedMode === "vector") {
          // graph tolerates lexical seeds, so it is not reported as degraded.
          degradedFrom = requestedMode === "vector" ? "vector" : "hybrid";
        }
      }

      // Hybrid and graph both seed with the fused hybrid candidates; vector uses
      // only the vector arm; all fall back to lexical when no query vector exists.
      const searchMode: SearchMode =
        queryVector === undefined ? "lexical" : requestedMode === "vector" ? "vector" : "hybrid";
      const effectiveMode: SearchMode =
        requestedMode === "graph" ? "graph" : queryVector !== undefined ? requestedMode : "lexical";

      const hits = await searchHybrid(ctx.db, {
        query: input.query,
        queryVector,
        mode: searchMode,
        now,
      });
      if (!hits.ok) {
        return err(hits.error);
      }

      let candidates: RankCandidate[] = hits.value.map((hit) => ({
        entityId: hit.entityId,
        baseScore: hit.score,
        matchedBy: hit.matchedBy,
      }));
      if (requestedMode === "graph") {
        const expanded = await graphExpandedCandidates(ctx.db, candidates);
        if (!expanded.ok) {
          return err(expanded.error);
        }
        candidates = expanded.value;
      }

      const scope: QueryScope = {
        paths: filters.paths ?? [],
        symbols: filters.symbols ?? [],
        issueRefs: filters.issueRefs ?? [],
      };
      const rankFilters: RankFilters = {
        minimumAuthority: filters.minimumAuthority ?? DEFAULT_MINIMUM_AUTHORITY,
        statuses: filters.statuses,
        entityTypes: filters.entityTypes,
        labels: filters.labels,
        from: filters.from,
        to: filters.to,
      };
      const ranked = await rankCandidates(ctx.db, ctx.repo.repositoryId, candidates, {
        scope,
        filters: rankFilters,
        limit,
        includeBody: input.includeBody ?? false,
      });
      if (!ranked.ok) {
        return err(ranked.error);
      }

      const results: McpSearchResult[] = ranked.value.map((result) => ({
        id: result.entity.id,
        type: result.entity.entityType,
        title: result.entity.title,
        summary: result.entity.summary ?? "",
        authority: result.entity.authority,
        status: result.entity.status,
        score: result.score,
        whyRelevant: result.whyRelevant,
        sources: result.sources,
        relations: result.relations,
        ...(result.body !== undefined ? { body: result.body } : {}),
      }));

      return ok({ query: input.query, effectiveMode, degradedFrom, results });
    },
  );
}
