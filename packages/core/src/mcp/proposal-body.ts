import { validateBodyForType } from "@iroha/canonical";
import type { IrohaError, KnowledgeProposal, Result } from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, ok } from "@iroha/domain";
import type { FieldRedaction } from "./redact.js";

/**
 * Rejects a proposal whose body cannot become a canonical document
 * (contracts/canonical.md §7) while the agent that wrote it is still there to
 * rewrite it; at approval there is no agent left and the candidate is stuck.
 *
 * Shared by both write paths on purpose: the redaction case below is the kind of
 * reasoning that goes wrong when it is copied, and the two tools must reject the
 * same inputs for the same stated reason.
 *
 * @param redactionField the field prefix `redactProposal` was given (`proposal`,
 *   `proposals[0]`, …) — used to recognize this proposal's own redactions.
 * @param messagePrefix prepended to the error, `""` where the contract documents
 *   an unprefixed message.
 */
export function validateProposalBody(
  proposal: KnowledgeProposal,
  redactions: readonly FieldRedaction[],
  redactionField: string,
  messagePrefix: string,
): Result<void, IrohaError> {
  // The secret scan replaces the *whole* field with a placeholder, so the template
  // check would see no headings and reject. Skip it instead of failing: §6.6 says a
  // flagged field is replaced and reported through `redactions[]` on the *successful*
  // response, and this gate exists to catch a body the agent wrote wrong, not one the
  // scanner took away. Failing here would also discard the rest of a checkpoint —
  // objective, implementation, validation — over a secret in one proposal.
  const replaced = (["title", "body"] as const).some((field) =>
    redactions.some((redaction) => redaction.field === `${redactionField}.${field}`),
  );
  if (replaced) {
    return ok(undefined);
  }

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
