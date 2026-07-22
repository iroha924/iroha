import { err, IrohaError, ok, type Result } from "@iroha/domain";
import { createEngine } from "@secretlint/node";

export interface SecretScanFinding {
  ruleId: string;
  /** Already masked by secretlint's `maskSecrets` option — never the raw matched value. */
  message: string;
  severity: string;
  line: number;
  column: number;
}

export interface SecretScanReport {
  clean: boolean;
  findings: SecretScanFinding[];
}

interface SecretlintMessage {
  ruleId: string;
  message: string;
  severity: string;
  loc: { start: { line: number; column: number } };
}

interface SecretlintFileResult {
  messages: SecretlintMessage[];
}

// Lazily created once and reused: `createEngine` is async (loads/resolves
// rule packages), and this scanner may run over many documents in one
// process (e.g. `iroha sync` re-scanning a whole `.iroha/` tree).
let enginePromise: ReturnType<typeof createEngine> | undefined;

async function getEngine(): Promise<Awaited<ReturnType<typeof createEngine>>> {
  enginePromise ??= createEngine({
    formatter: "json",
    color: false,
    // Never let a found secret's actual value reach a report, log, or
    // error detail — confirmed by reproduction that this masks both the
    // `message` and `data` fields in secretlint's own result (but *not*
    // the unrelated `sourceContent` field, which this module never reads).
    maskSecrets: true,
    configFileJSON: {
      rules: [
        { id: "@secretlint/secretlint-rule-preset-recommend" },
        // Coverage boundary (deliberate, not a guarantee): the recommend preset
        // is pattern-based (AWS, GCP, private key, basic-auth URL, Slack, npm,
        // SendGrid, …) and has NO entropy rule, so a bare high-entropy secret
        // with no recognizable prefix/keyword passes this runtime scan. The
        // entropy backstop lives in CI/pre-commit (gitleaks `generic-api-key`,
        // ci.yml). A blanket entropy rule is intentionally NOT added here: this
        // scanner also gates canonical writes (rejected outright on a finding)
        // and checkpoint redaction (fields blanked wholesale), so a high
        // false-positive rate would reject legitimate content — a real
        // operability cost. Instead we add a targeted pattern for the one
        // known high-value in-scope token shape: iroha's own session token
        // (`ist_<43 base64url>`, checkpoint.ts `sessionTokenSchema`), which must
        // never reach a canonical file or a persisted checkpoint free-text
        // field. `maskSecrets` keeps the matched token out of the finding
        // message (verified). See audit issue #43 / decision-log.
        {
          id: "@secretlint/secretlint-rule-pattern",
          options: {
            patterns: [{ name: "iroha session token", patterns: ["/ist_[A-Za-z0-9_-]{43}/"] }],
          },
        },
      ],
    },
  });
  try {
    return await enginePromise;
  } catch (cause) {
    // Let the next call retry: a rejected promise is still a truthy value,
    // so `??=` alone would otherwise pin this failure for the rest of the
    // process's life even after a transient condition (e.g. a filesystem
    // hiccup resolving a rule package) clears — confirmed by review.
    enginePromise = undefined;
    throw cause;
  }
}

/**
 * Scans `content` for secrets before it is written to a canonical file
 * (canonical-schema.md §11 step 2, WP-04 acceptance criteria: "no raw
 * prompt/secret fixture reaches canonical output"). Reports findings
 * rather than silently redacting content — a canonical document requires
 * human approval, and rewriting approved content without a fresh review
 * would defeat that requirement, so the caller (the write primitive)
 * rejects the write when `clean` is `false`.
 */
export async function scanForSecrets(
  content: string,
  filePath = "canonical-document.md",
): Promise<Result<SecretScanReport, IrohaError>> {
  let engine: Awaited<ReturnType<typeof createEngine>>;
  try {
    engine = await getEngine();
  } catch (cause) {
    return err(
      new IrohaError("INTERNAL_ERROR", "Failed to initialize the secret scanner", { cause }),
    );
  }

  let lintResult: { ok: boolean; output: string };
  try {
    lintResult = await engine.executeOnContent({ content, filePath });
  } catch (cause) {
    return err(new IrohaError("INTERNAL_ERROR", "Secret scan failed", { cause }));
  }

  let fileResults: SecretlintFileResult[];
  try {
    fileResults = JSON.parse(lintResult.output) as SecretlintFileResult[];
  } catch (cause) {
    return err(new IrohaError("INTERNAL_ERROR", "Failed to parse secret scan output", { cause }));
  }

  const findings: SecretScanFinding[] = fileResults.flatMap((fileResult) =>
    fileResult.messages.map((message) => ({
      ruleId: message.ruleId,
      message: message.message,
      severity: message.severity,
      line: message.loc.start.line,
      column: message.loc.start.column,
    })),
  );

  return ok({ clean: findings.length === 0, findings });
}
