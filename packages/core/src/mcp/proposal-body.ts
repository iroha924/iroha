import { validateBodyForType } from "@iroha/canonical";
import type { IrohaError, KnowledgeProposal, Result } from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, ok } from "@iroha/domain";
import type { FieldRedaction } from "./redact.js";

/**
 * Whether the secret scan replaced either field the body template compares. A
 * replaced field is a placeholder, so the proposal can no longer satisfy §7 —
 * the two write paths differ only in what they do about that.
 */
export function proposalWasRedacted(
  redactions: readonly FieldRedaction[],
  redactionField: string,
): boolean {
  return (["title", "body"] as const).some((field) =>
    redactions.some((redaction) => redaction.field === `${redactionField}.${field}`),
  );
}

/**
 * Rejects a proposal whose body cannot become a canonical document
 * (contracts/canonical.md §7) while the agent that wrote it is still there to
 * rewrite it; at approval there is no agent left and the candidate is stuck.
 *
 * Shared by both write paths on purpose: the two tools must reject the same
 * bodies for the same stated reason.
 *
 * Redaction is handled by the caller, not here — `propose_knowledge` has only
 * the proposal to return, so it rejects; `create_checkpoint` has a checkpoint
 * worth keeping, so it omits the proposal and saves the rest.
 */
export function validateProposalBody(
  proposal: KnowledgeProposal,
  redactionField: string,
  messagePrefix: string,
): Result<void, IrohaError> {
  const body = validateBodyForType(proposal.type, proposal.title, proposal.body);
  if (!body.ok) {
    return err(
      new IrohaErrorClass("INVALID_INPUT", `${messagePrefix}${body.error.message}`, {
        ...(body.error.details === undefined ? {} : { details: body.error.details }),
      }),
    );
  }
  return ok(undefined);
}
