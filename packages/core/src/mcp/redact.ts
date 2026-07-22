import { scanForSecrets } from "@iroha/canonical";
import type { IrohaError, KnowledgeProposal, Result } from "@iroha/domain";
import { err, ok } from "@iroha/domain";

export interface FieldRedaction {
  field: string;
  reason: string;
}

const REDACTED_PLACEHOLDER = "[redacted: secret detected]";
// A `url`-shaped placeholder, so a redacted reference still satisfies the
// `z.url()` contract if the candidate is later re-validated at approval time.
const REDACTED_URL_PLACEHOLDER = "https://redacted.invalid/";

/** A checkpoint/proposal reference (`referenceSchema`): the `sources[]`/`references[]` element. */
type Reference = KnowledgeProposal["sources"][number];

async function scanFinding(value: string): Promise<Result<string | null, IrohaError>> {
  if (value.length === 0) {
    return ok(null);
  }
  const scan = await scanForSecrets(value);
  if (!scan.ok) {
    return err(scan.error);
  }
  if (scan.value.clean) {
    return ok(null);
  }
  return ok([...new Set(scan.value.findings.map((finding) => finding.ruleId))].join(", "));
}

/**
 * Scans one local checkpoint/proposal free-text field for secrets. A Checkpoint
 * is a candidate, not canonical, so — unlike a canonical write, which rejects on
 * a finding (secret-scan.ts) — a flagged field is redacted wholesale and the
 * redaction is reported (mcp-contract.md §6.6 step 2 / §8). Coarse field-level
 * redaction favours safety over preserving partial context. A scanner failure
 * propagates as an error: an unscanned field is never stored.
 */
export async function redactField(
  field: string,
  value: string,
  placeholder: string = REDACTED_PLACEHOLDER,
): Promise<Result<{ value: string; redaction?: FieldRedaction }, IrohaError>> {
  const reason = await scanFinding(value);
  if (!reason.ok) {
    return err(reason.error);
  }
  if (reason.value === null) {
    return ok({ value });
  }
  return ok({ value: placeholder, redaction: { field, reason: reason.value } });
}

/** Scans each element of a free-text string array, redacting flagged entries in place. */
export async function redactStringArray(
  field: string,
  values: readonly string[],
): Promise<Result<{ values: string[]; redactions: FieldRedaction[] }, IrohaError>> {
  const out: string[] = [];
  const redactions: FieldRedaction[] = [];
  for (const [index, value] of values.entries()) {
    const result = await redactField(`${field}[${index}]`, value);
    if (!result.ok) {
      return err(result.error);
    }
    out.push(result.value.value);
    if (result.value.redaction) {
      redactions.push(result.value.redaction);
    }
  }
  return ok({ values: out, redactions });
}

/**
 * Scans a reference's free-text `ref`, `url`, and `path`. A `url` is a prime
 * credential carrier (userinfo, presigned-URL signatures), so it is scanned and,
 * if flagged, replaced with a still-valid placeholder URL. `path` is a
 * `relativePath` — which rejects only absolute/drive/`..` values and still
 * accepts a credential-shaped substring (e.g. `config/x-https://u:tok@h/y`,
 * verified) — so it is scanned too, not assumed safe.
 */
export async function redactReference(
  reference: Reference,
  prefix: string,
): Promise<Result<{ reference: Reference; redactions: FieldRedaction[] }, IrohaError>> {
  const redactions: FieldRedaction[] = [];
  const next: Reference = { ...reference };

  const ref = await redactField(`${prefix}.ref`, reference.ref);
  if (!ref.ok) {
    return err(ref.error);
  }
  next.ref = ref.value.value;
  if (ref.value.redaction) {
    redactions.push(ref.value.redaction);
  }

  if (reference.url !== undefined) {
    const url = await redactField(`${prefix}.url`, reference.url, REDACTED_URL_PLACEHOLDER);
    if (!url.ok) {
      return err(url.error);
    }
    next.url = url.value.value;
    if (url.value.redaction) {
      redactions.push(url.value.redaction);
    }
  }

  if (reference.path !== undefined) {
    const path = await redactField(`${prefix}.path`, reference.path);
    if (!path.ok) {
      return err(path.error);
    }
    next.path = path.value.value;
    if (path.value.redaction) {
      redactions.push(path.value.redaction);
    }
  }

  return ok({ reference: next, redactions });
}

/**
 * Redacts every unconstrained free-text field of a proposal: the prose
 * (`title`/`summary`/`body`), `scope.symbols`, `scope.paths`, the `guard.tools`/
 * `guard.paths`/`guard.denyCommands`, each `relations[]` edge's `type`/`target`,
 * and each source's `ref`/`url`/`path`. A relative-path field is NOT safe to
 * skip: `relativePathSchema` rejects only absolute/drive/`..` values, so it
 * still accepts a credential-shaped substring (e.g. `config/x-https://u:tok@h/y`,
 * verified). The only fields left unscanned are the ones whose character set
 * genuinely cannot express a credential: `labels` (`[a-z0-9]+(?:-[a-z0-9]+)*`),
 * `scope.languages` (`[a-z0-9+#.-]{1,32}`), and the enum `type`/`enforcement`.
 */
export async function redactProposal(
  proposal: KnowledgeProposal,
  prefix: string,
): Promise<Result<{ proposal: KnowledgeProposal; redactions: FieldRedaction[] }, IrohaError>> {
  const redactions: FieldRedaction[] = [];
  const redacted: KnowledgeProposal = { ...proposal };

  for (const field of ["title", "summary", "body"] as const) {
    const result = await redactField(`${prefix}.${field}`, proposal[field]);
    if (!result.ok) {
      return err(result.error);
    }
    redacted[field] = result.value.value;
    if (result.value.redaction) {
      redactions.push(result.value.redaction);
    }
  }

  const symbols = await redactStringArray(`${prefix}.scope.symbols`, proposal.scope.symbols);
  if (!symbols.ok) {
    return err(symbols.error);
  }
  const scopePaths = await redactStringArray(`${prefix}.scope.paths`, proposal.scope.paths);
  if (!scopePaths.ok) {
    return err(scopePaths.error);
  }
  redacted.scope = {
    ...proposal.scope,
    paths: scopePaths.value.values,
    symbols: symbols.value.values,
  };
  redactions.push(...scopePaths.value.redactions, ...symbols.value.redactions);

  if (proposal.guard !== undefined) {
    const tools = await redactStringArray(`${prefix}.guard.tools`, proposal.guard.tools);
    if (!tools.ok) {
      return err(tools.error);
    }
    redactions.push(...tools.value.redactions);
    const paths = await redactStringArray(`${prefix}.guard.paths`, proposal.guard.paths);
    if (!paths.ok) {
      return err(paths.error);
    }
    redactions.push(...paths.value.redactions);
    const guard = { ...proposal.guard, tools: tools.value.values, paths: paths.value.values };
    if (proposal.guard.denyCommands !== undefined) {
      const denyCommands = await redactStringArray(
        `${prefix}.guard.denyCommands`,
        proposal.guard.denyCommands,
      );
      if (!denyCommands.ok) {
        return err(denyCommands.error);
      }
      guard.denyCommands = denyCommands.value.values;
      redactions.push(...denyCommands.value.redactions);
    }
    redacted.guard = guard;
  }

  const sources: Reference[] = [];
  for (const [index, source] of proposal.sources.entries()) {
    const result = await redactReference(source, `${prefix}.sources[${index}]`);
    if (!result.ok) {
      return err(result.error);
    }
    sources.push(result.value.reference);
    redactions.push(...result.value.redactions);
  }
  redacted.sources = sources;

  if (proposal.relations !== undefined) {
    const relations: NonNullable<KnowledgeProposal["relations"]> = [];
    for (const [index, relation] of proposal.relations.entries()) {
      const type = await redactField(`${prefix}.relations[${index}].type`, relation.type);
      if (!type.ok) {
        return err(type.error);
      }
      if (type.value.redaction) {
        redactions.push(type.value.redaction);
      }
      const target = await redactField(`${prefix}.relations[${index}].target`, relation.target);
      if (!target.ok) {
        return err(target.error);
      }
      if (target.value.redaction) {
        redactions.push(target.value.redaction);
      }
      relations.push({ type: type.value.value, target: target.value.value });
    }
    redacted.relations = relations;
  }

  return ok({ proposal: redacted, redactions });
}
