import { scanForSecrets } from "@iroha/canonical";
import type { IrohaError, KnowledgeProposal, Result } from "@iroha/domain";
import { err, ok } from "@iroha/domain";

export interface FieldRedaction {
  field: string;
  reason: string;
}

const REDACTED_PLACEHOLDER = "[redacted: secret detected]";

/**
 * Scans one local checkpoint/proposal text field for secrets. A Checkpoint is a
 * candidate, not canonical, so — unlike a canonical write, which rejects on a
 * finding (secret-scan.ts) — a flagged field is redacted wholesale and the
 * redaction is reported (mcp-contract.md §6.6 step 2 / §8). Coarse field-level
 * redaction favours safety over preserving partial context. A scanner failure
 * propagates as an error: an unscanned field is never stored.
 */
export async function redactField(
  field: string,
  value: string,
): Promise<Result<{ value: string; redaction?: FieldRedaction }, IrohaError>> {
  if (value.length === 0) {
    return ok({ value });
  }
  const scan = await scanForSecrets(value);
  if (!scan.ok) {
    return err(scan.error);
  }
  if (scan.value.clean) {
    return ok({ value });
  }
  const reason = [...new Set(scan.value.findings.map((finding) => finding.ruleId))].join(", ");
  return ok({ value: REDACTED_PLACEHOLDER, redaction: { field, reason } });
}

/**
 * Redacts a proposal's free-text fields (`title`/`summary`/`body`), collecting
 * any redactions under `<prefix>.<field>`. The constrained fields (labels,
 * scope paths/symbols, source refs) are not scanned: their formats
 * (`[a-z0-9-]` labels, relative paths) cannot carry a credential.
 */
export async function redactProposal(
  proposal: KnowledgeProposal,
  prefix: string,
): Promise<Result<{ proposal: KnowledgeProposal; redactions: FieldRedaction[] }, IrohaError>> {
  const redactions: FieldRedaction[] = [];
  const fields: Array<"title" | "summary" | "body"> = ["title", "summary", "body"];
  const redacted = { ...proposal };
  for (const field of fields) {
    const result = await redactField(`${prefix}.${field}`, proposal[field]);
    if (!result.ok) {
      return err(result.error);
    }
    redacted[field] = result.value.value;
    if (result.value.redaction) {
      redactions.push(result.value.redaction);
    }
  }
  return ok({ proposal: redacted, redactions });
}
