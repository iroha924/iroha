import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { err, ok } from "@iroha/domain";
import { searchText } from "@iroha/search";
import { type EntityType, getEntityById } from "@iroha/storage";
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
  effectiveMode: "lexical";
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
  mode?: "hybrid" | "lexical" | "vector" | "graph" | undefined;
  limit?: number | undefined;
  filters?: McpSearchFilters | undefined;
}

const DEFAULT_MINIMUM_AUTHORITY = 60;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/**
 * The FTS-only slice of `search` (mcp-contract.md §6.1). Delegates ranking to
 * `@iroha/search`'s lexical Reciprocal Rank Fusion (`searchText`), then applies
 * the authority/status/entity-type filters. The vector term, the
 * authority/scope/graph boosts, provenance (`sources`) and relation enrichment,
 * `includeBody`, and the label/path/symbol/issueRef/date filters are WP-08's
 * additions — surfaced to the caller as tool `warnings`, never silently dropped.
 */
export async function mcpSearch(input: McpSearchInput): Promise<Result<McpSearchData, IrohaError>> {
  return withMcpRepository(
    { cwd: input.repositoryPath ?? input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const hits = await searchText(ctx.db, input.query, { limit });
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
          whyRelevant: ["lexical match"],
          sources: [],
          relations: [],
        });
      }

      const degradedFrom =
        input.mode === "hybrid" || input.mode === "vector" ? input.mode : undefined;
      return ok({ query: input.query, effectiveMode: "lexical", degradedFrom, results });
    },
  );
}
