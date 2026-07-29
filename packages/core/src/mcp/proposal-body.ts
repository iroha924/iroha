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
  // The secret scan replaces the *whole* field with a placeholder. Both fields the
  // template compares can be replaced, and either one makes the check blame a
  // heading — false, not fixable by editing headings, and it buries the only fact
  // the caller can act on.
  const replaced = (["title", "body"] as const).filter((field) =>
    redactions.some((redaction) => redaction.field === `${redactionField}.${field}`),
  );
  if (replaced.length > 0) {
    return err(
      new IrohaErrorClass(
        "INVALID_INPUT",
        `${messagePrefix}${replaced.join(" and ")} ${replaced.length > 1 ? "were" : "was"} replaced because a secret was detected; resubmit without the secret`,
      ),
    );
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
