import type { Clock, IrohaError, RandomSource, Result, TypedId } from "@iroha/domain";
import { err, ok } from "@iroha/domain";
import { searchHybrid } from "@iroha/search";
import { type EntityType, listCheckpointsBySession } from "@iroha/storage";
import { resolveEmbeddingProvider } from "../embedding-sync.js";
import {
  type QueryScope,
  type RankCandidate,
  type RankedResult,
  rankCandidates,
} from "./ranking.js";
import { verifySessionToken } from "./verify-session-token.js";
import { withMcpRepository } from "./with-repository.js";

export interface McpContextItem {
  id: string;
  type: EntityType;
  title: string;
  summary: string;
  whyRelevant: string;
  sourceLabel: string;
}

export interface McpContextData {
  sessionId: TypedId<"ses">;
  runId: TypedId<"run">;
  items: McpContextItem[];
  unresolved: string[];
  truncated: boolean;
}

export interface McpGetContextInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  sessionToken: string;
  query?: string | undefined;
  activeIssueRefs?: string[] | undefined;
  paths?: string[] | undefined;
  symbols?: string[] | undefined;
  maxItems?: number | undefined;
  maxCharacters?: number | undefined;
}

const DEFAULT_MAX_ITEMS = 12;
const MAX_MAX_ITEMS = 20;
const DEFAULT_MAX_CHARACTERS = 8000;
const MAX_MAX_CHARACTERS = 16000;
const DEFAULT_MINIMUM_AUTHORITY = 60;

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function sourceLabel(result: RankedResult): string {
  const first = result.sources[0];
  if (first !== undefined) {
    return `source: ${first.type} ${first.ref}`;
  }
  return `source: ${result.entity.sourceKind}`;
}

/**
 * Builds a bounded context pack for the current task (mcp-contract.md §6.2):
 * database-schema.md §9's hybrid ranking restricted to approved/verified
 * entities (pending candidates are structurally excluded), scoped by the
 * caller's `paths`/`symbols`/`activeIssueRefs`, capped by `maxItems`/
 * `maxCharacters`, plus the session's latest unresolved items. Embedding is
 * used when configured (this is an MCP tool, not a fail-open hook); it degrades
 * to lexical otherwise.
 */
export async function mcpGetContext(
  input: McpGetContextInput,
): Promise<Result<McpContextData, IrohaError>> {
  return withMcpRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const verified = await verifySessionToken({
        db: ctx.db,
        salt: ctx.salt,
        repositoryId: ctx.repo.repositoryId,
        clock: ctx.clock,
        token: input.sessionToken,
      });
      if (!verified.ok) {
        return verified;
      }
      const { sessionId, runId } = verified.value;

      const maxItems = Math.min(input.maxItems ?? DEFAULT_MAX_ITEMS, MAX_MAX_ITEMS);
      const maxCharacters = Math.min(
        input.maxCharacters ?? DEFAULT_MAX_CHARACTERS,
        MAX_MAX_CHARACTERS,
      );

      const items: McpContextItem[] = [];
      let truncated = false;
      const query = input.query?.trim();
      if (query !== undefined && query.length > 0) {
        const provider = resolveEmbeddingProvider(ctx.repo.config.search.embedding);
        const embedded = provider === null ? null : await provider.embed([query], "query");
        const queryVector =
          embedded !== null && embedded.ok && embedded.value[0] !== undefined
            ? embedded.value[0]
            : undefined;

        const hits = await searchHybrid(ctx.db, {
          query,
          queryVector,
          mode: queryVector !== undefined ? "hybrid" : "lexical",
          now: ctx.clock.now().toISOString(),
        });
        if (!hits.ok) {
          return err(hits.error);
        }
        const candidates: RankCandidate[] = hits.value.map((hit) => ({
          entityId: hit.entityId,
          baseScore: hit.score,
          matchedBy: hit.matchedBy,
        }));
        const scope: QueryScope = {
          paths: input.paths ?? [],
          symbols: input.symbols ?? [],
          issueRefs: input.activeIssueRefs ?? [],
        };
        const ranked = await rankCandidates(ctx.db, ctx.repo.repositoryId, candidates, {
          scope,
          filters: { minimumAuthority: DEFAULT_MINIMUM_AUTHORITY },
          limit: maxItems,
          includeBody: false,
        });
        if (!ranked.ok) {
          return err(ranked.error);
        }

        let characters = 0;
        for (const result of ranked.value) {
          const summary = result.entity.summary ?? "";
          if (characters + summary.length > maxCharacters && items.length > 0) {
            truncated = true;
            break;
          }
          characters += summary.length;
          items.push({
            id: result.entity.id,
            type: result.entity.entityType,
            title: result.entity.title,
            summary,
            whyRelevant: result.whyRelevant.join("; "),
            sourceLabel: sourceLabel(result),
          });
        }
      }

      const checkpoints = await listCheckpointsBySession(ctx.db, sessionId, 1);
      if (!checkpoints.ok) {
        return err(checkpoints.error);
      }
      const last = checkpoints.value[0] ?? null;
      const unresolved = last === null ? [] : parseStringArray(last.unresolvedJson);

      return ok({ sessionId, runId, items, unresolved, truncated });
    },
  );
}
