# Diminishing returns: keep iterating on fixes, or lock the scope

You may think repeated fixes are lowering risk when in fact they are creating new risk (empirical study: [Security Degradation in Iterative AI Code Generation](https://arxiv.org/pdf/2506.11022), arXiv 2506.11022). On every iteration, question whether each fix of one issue is building in the next one.

## Signs

- The latest fix targets only a narrower edge case than the one before it
- The latest fix produced a new regression (each fix breaks another one)
- You keep tuning parameters (retry count, thresholds, timeouts, etc.) against the same root cause, but it does not converge

## Response

1. When a sign appears, first stop tuning parameters by guesswork and investigate primary sources for the root cause (official documentation, upstream library issues, the specification)
2. If it still does not converge even after root-cause investigation, further iteration is no longer "an act that reduces risk" but "an act that can create new risk". Present the options to a human and lock the scope explicitly (the "Push Back" section of `~/.claude/rules/think-before-coding.md`)
3. Record the locked scope and the reasoning in `implementation/decision-log.md`

## Examples in this repository

- ID-023 (WP-02, `@iroha/git`): credential-redaction fixes reached diminishing returns over dozens of review round-trips, and the scope was cut off at the point where some of the fixes produced new regressions
- ID-026 (12)-(14) (WP-05, `@iroha/storage`/`@iroha/core`): for a file-lock problem on Windows, repeatedly expanding the retry budget did not converge, and once even root-cause investigation (external primary sources) failed to resolve it, Windows CI verification itself was removed from scope

## Related

- For the limits of verification means and checking CI run history, see `~/.claude/rules/ci-discipline.md`
- For the discipline of verifying review findings (including handling cyclic false positives), see `~/.claude/rules/code-review-triage.md`
- For pushing back and presenting multiple interpretations, see `~/.claude/rules/think-before-coding.md`
- For the same class of principle in security fixes, see `.claude/skills/self-review/SKILL.md`
