import type { Clock, IrohaError, RandomSource, Result, TypedId } from "@iroha/domain";
import { err, ok } from "@iroha/domain";
import { searchText } from "@iroha/search";
import { type EntityType, getEntityById, listCheckpointsBySession } from "@iroha/storage";
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
  maxItems?: number | undefined;
  maxCharacters?: number | undefined;
}

const DEFAULT_MAX_ITEMS = 12;
const MAX_MAX_ITEMS = 20;
const DEFAULT_MAX_CHARACTERS = 8000;
const MAX_MAX_CHARACTERS = 16000;

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

/**
 * Builds a bounded context pack for the current task (mcp-contract.md §6.2).
 * `searchText` scans `search_documents` (approved/canonical entities) only, so
 * pending candidates are structurally excluded. The full context-pack priority
 * ordering and scope filters are WP-08's; this returns the lexical hits capped
 * by `maxItems`/`maxCharacters` plus the session's latest unresolved items.
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
        const hits = await searchText(ctx.db, query, { limit: maxItems + 5 });
        if (!hits.ok) {
          return err(hits.error);
        }
        let characters = 0;
        for (const hit of hits.value) {
          if (items.length >= maxItems) {
            truncated = true;
            break;
          }
          const entity = await getEntityById(ctx.db, hit.entityId);
          if (!entity.ok) {
            return err(entity.error);
          }
          if (entity.value === null) {
            continue;
          }
          const e = entity.value;
          const summary = e.summary ?? "";
          if (characters + summary.length > maxCharacters && items.length > 0) {
            truncated = true;
            break;
          }
          characters += summary.length;
          items.push({
            id: e.id,
            type: e.entityType,
            title: e.title,
            summary,
            whyRelevant: "matches query",
            sourceLabel: e.sourceKind,
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
