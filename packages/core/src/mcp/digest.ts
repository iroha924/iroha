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
  type DigestPeriodUnit,
  type DigestProse,
  type DigestSelection,
  redactProse,
  resolveDigestPeriodByKey,
  validateFactReferences,
} from "../dashboard/index.js";
import type { FieldRedaction } from "./redact.js";
import { verifySessionToken } from "./verify-session-token.js";
import { withMcpRepository } from "./with-repository.js";

/**
 * How far back a composition may name a period. Mirrors the API's own cap so the
 * two boundaries agree on which back issues exist.
 */
const MAX_DIGEST_OFFSET = 520;

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

export interface McpSaveDigestProseInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  sessionToken: string;
  /**
   * The period this composition is *for*, echoed from the `period` that
   * `get_digest_data` returned.
   *
   * Named, never re-derived from an offset. When the save re-resolved a period
   * from its own optional `offset`, an agent that read a back issue and then
   * omitted the argument published last week's narrative as the current issue —
   * a success return, no warning, the wrong week's numbers substituted into it,
   * and the issue it was written for still blank. `validateFactReferences` cannot
   * catch that, because the period-independent ids exist in both fact tables.
   */
  periodUnit: DigestPeriodUnit;
  periodKey: string;
  /** The agent's composition, already validated by the tool's own input schema. */
  prose: DigestProse;
}

export interface McpSaveDigestProseData {
  period: DigestPeriod;
  composedAt: string;
  /**
   * Fields whose content was replaced because the scanner found a secret in it.
   * Empty on a clean save. Reported because redaction blanks a whole field: a bare
   * success would tell the agent its section saved when nothing of it survived.
   */
  redactions: FieldRedaction[];
}

/**
 * Store a composition for one period (`save_digest_prose`).
 *
 * Four gates, in order: a valid session token, the same one every local write
 * requires (contracts/mcp.md §5); the named period must be one this clock can
 * still produce; every `{{factId}}` must be one *that period* issued; and every
 * free-text field is secret-scanned before it reaches the database. The middle two
 * are what make the number/prose seam hold — an agent cannot cite authority iroha
 * did not grant, nor attach a narrative to a period it was not written for — and
 * the last is the at-rest requirement for any local store of agent text.
 *
 * The shape is not re-checked here: the MCP dispatcher strict-parses the tool's
 * `inputSchema`, which embeds `digestProseSchema`, so the handler's argument is
 * already the validated output (`packages/mcp/src/tools/types.ts`). Every sibling
 * use case takes the typed value the same way.
 *
 * Recomposing overwrites the period's previous issue: the numbers are recomputed
 * on every read, so an older narration of the same period is stale, not history.
 */
export async function mcpSaveDigestProse(
  input: McpSaveDigestProseInput,
): Promise<Result<McpSaveDigestProseData, IrohaError>> {
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
      const period = resolveDigestPeriodByKey(
        input.periodUnit,
        input.periodKey,
        ctx.clock,
        MAX_DIGEST_OFFSET,
      );
      if (period === null) {
        return err(
          new IrohaErrorClass(
            "INVALID_INPUT",
            "periodKey does not name a period of this unit; echo the `period` from get_digest_data",
          ),
        );
      }
      const digest = await computeDigest(ctx, { unit: period.unit, offset: period.offset });
      if (!digest.ok) {
        return digest;
      }
      const references = validateFactReferences(input.prose, digest.value.facts);
      if (!references.ok) {
        return references;
      }
      const redacted = await redactProse(input.prose);
      if (!redacted.ok) {
        return redacted;
      }
      const composedAt = ctx.clock.now().toISOString();
      const stored = await upsertDigestIssue(ctx.db, {
        repositoryId: ctx.repo.repositoryId,
        periodUnit: period.unit,
        periodKey: period.key,
        proseJson: JSON.stringify(redacted.value.prose),
        composedAt,
      });
      if (!stored.ok) {
        return stored;
      }
      return ok({ period, composedAt, redactions: redacted.value.redactions });
    },
  );
}
