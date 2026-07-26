/**
 * The two MCP tools behind the `/iroha:digest` skill: hand an agent the period's
 * facts, take back sentences.
 *
 * Anti-surveillance is enforced by what the payload *is*, not by asking the model
 * to behave. `DigestData` has no field named or typed as actor, author, email, or
 * session owner anywhere in it, so per-person narration is not something the
 * composing agent could produce even if instructed to — the person data never
 * arrives. Any free text it quotes comes from already-approved canonical titles
 * and summaries, never from a prompt, a transcript, or raw tool input.
 */
import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, ok } from "@iroha/domain";
import { upsertDigestIssue } from "@iroha/storage";
import {
  computeDigest,
  type DigestData,
  type DigestPeriod,
  type DigestSelection,
  digestProseSchema,
  redactProse,
  validateFactReferences,
} from "../dashboard/index.js";
import { verifySessionToken } from "./verify-session-token.js";
import { withMcpRepository } from "./with-repository.js";

export interface McpGetDigestDataInput extends DigestSelection {
  cwd: string;
  clock: Clock;
  random: RandomSource;
}

/**
 * The period's aggregates and its fact table (`get_digest_data`).
 *
 * Read-only and unauthenticated, like `search` and `get_active_rules`: it exposes
 * counts already derivable from the tools an agent has, and requiring a session
 * token would stop the skill from being runnable outside a live Run.
 */
export async function mcpGetDigestData(
  input: McpGetDigestDataInput,
): Promise<Result<DigestData, IrohaError>> {
  return withMcpRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random, tool: "get_digest_data" },
    (ctx) => computeDigest(ctx, input),
  );
}

export interface McpSaveDigestProseInput extends DigestSelection {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  sessionToken: string;
  /** The agent's composition, before validation and redaction. */
  prose: unknown;
}

export interface McpSaveDigestProseData {
  period: DigestPeriod;
  composedAt: string;
}

/**
 * Store a composition for one period (`save_digest_prose`).
 *
 * Four gates, in order: a valid session token, the same one every local write
 * requires (contracts/mcp.md §5); the shape must match `digestProseSchema`; every
 * `{{factId}}` must be one *this period* issued; and every free-text field is
 * secret-scanned before it reaches the database. The middle two are what make the
 * number/prose seam hold — an agent cannot cite authority iroha did not grant —
 * and the last is the at-rest requirement for any local store of agent text.
 *
 * The shape check runs before the repository is opened, so malformed input costs
 * no connection. Recomposing overwrites the period's previous issue: the numbers
 * are recomputed on every read, so an older narration of the same period is
 * stale, not history.
 */
export async function mcpSaveDigestProse(
  input: McpSaveDigestProseInput,
): Promise<Result<McpSaveDigestProseData, IrohaError>> {
  const validated = digestProseSchema.safeParse(input.prose);
  if (!validated.success) {
    return err(
      new IrohaErrorClass("INVALID_INPUT", "Digest prose does not match the expected shape", {
        details: { fields: [...new Set(validated.error.issues.map((i) => i.path.join(".")))] },
      }),
    );
  }
  return withMcpRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random, tool: "save_digest_prose" },
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
      const digest = await computeDigest(ctx, input);
      if (!digest.ok) {
        return digest;
      }
      const references = validateFactReferences(validated.data, digest.value.facts);
      if (!references.ok) {
        return references;
      }
      const redacted = await redactProse(validated.data);
      if (!redacted.ok) {
        return redacted;
      }
      const composedAt = ctx.clock.now().toISOString();
      const stored = await upsertDigestIssue(ctx.db, {
        repositoryId: ctx.repo.repositoryId,
        periodUnit: digest.value.period.unit,
        periodKey: digest.value.period.key,
        proseJson: JSON.stringify(redacted.value),
        composedAt,
      });
      if (!stored.ok) {
        return stored;
      }
      return ok({ period: digest.value.period, composedAt });
    },
  );
}
