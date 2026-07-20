import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { err, ok } from "@iroha/domain";
import { type SearchMode, searchHybrid } from "@iroha/search";
import { type EntityType, getEntityById } from "@iroha/storage";
import { resolveEmbeddingProvider } from "../embedding-sync.js";
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
  sources: string[];
  relations: string[];
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
  minimumAuthority?: number | undefined;
}

export interface McpSearchInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  query: string;
  repositoryPath?: string | undefined;
  mode?: SearchMode | undefined;
  limit?: number | undefined;
  filters?: McpSearchFilters | undefined;
}

const DEFAULT_MINIMUM_AUTHORITY = 60;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function whyRelevantFor(matchedBy: readonly string[], authority: number): string[] {
  const reasons = matchedBy.map((source) => `${source} match`);
  if (authority >= 100) {
    reasons.push("approved canonical");
  } else if (authority >= 80) {
    reasons.push("verified source");
  }
  return reasons;
}

/**
 * `search` (mcp-contract.md §6.1): database-schema.md §9's hybrid retrieval over
 * approved/verified entities. When embedding is configured and the query
 * embedding succeeds, the vector term joins the FTS RRF sum; otherwise the
 * request degrades to lexical (`effectiveMode="lexical"`, `degradedFrom` set to
 * the requested vector-bearing mode) — no error, per CLAUDE.md's "embedding
 * failure must degrade to lexical search". Scope/graph boosts, `sources`/
 * `relations` enrichment, `mode="graph"`, and the richer filters are layered on
 * in Slice 3.
 */
export async function mcpSearch(input: McpSearchInput): Promise<Result<McpSearchData, IrohaError>> {
  return withMcpRepository(
    { cwd: input.repositoryPath ?? input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const requestedMode: SearchMode = input.mode ?? "hybrid";
      // `graph` traversal is Slice 3; until then it rides the hybrid path.
      const runMode: SearchMode = requestedMode === "graph" ? "hybrid" : requestedMode;
      const wantsVector = runMode === "hybrid" || runMode === "vector";

      let queryVector: readonly number[] | undefined;
      let degradedFrom: "hybrid" | "vector" | undefined;
      if (wantsVector) {
        const provider = resolveEmbeddingProvider(ctx.repo.config.search.embedding);
        const embedded = provider === null ? null : await provider.embed([input.query], "query");
        if (embedded !== null && embedded.ok && embedded.value[0] !== undefined) {
          queryVector = embedded.value[0];
        } else {
          degradedFrom = runMode === "vector" ? "vector" : "hybrid";
        }
      }
      const effectiveMode: SearchMode = queryVector !== undefined ? runMode : "lexical";

      const hits = await searchHybrid(ctx.db, {
        query: input.query,
        queryVector,
        mode: effectiveMode,
        limit,
        now: ctx.clock.now().toISOString(),
      });
      if (!hits.ok) {
        return err(hits.error);
      }

      const minimumAuthority = input.filters?.minimumAuthority ?? DEFAULT_MINIMUM_AUTHORITY;
      const statuses = input.filters?.statuses;
      const entityTypes = input.filters?.entityTypes;

      const results: McpSearchResult[] = [];
      for (const hit of hits.value) {
        const entity = await getEntityById(ctx.db, hit.entityId);
        if (!entity.ok) {
          return err(entity.error);
        }
        const e = entity.value;
        if (e === null || e.authority < minimumAuthority) {
          continue;
        }
        if (statuses !== undefined && !statuses.includes(e.status)) {
          continue;
        }
        if (entityTypes !== undefined && !entityTypes.includes(e.entityType)) {
          continue;
        }
        results.push({
          id: e.id,
          type: e.entityType,
          title: e.title,
          summary: e.summary ?? "",
          authority: e.authority,
          status: e.status,
          score: hit.score,
          whyRelevant: whyRelevantFor(hit.matchedBy, e.authority),
          sources: [],
          relations: [],
        });
      }

      return ok({ query: input.query, effectiveMode, degradedFrom, results });
    },
  );
}
