# PR comment template — the iroha-review summary

Step 6 of `SKILL.md` renders this into the draft file; the step recorded in `CLAUDE.md` and
`AGENTS.md` posts it after `gh pr create`. The rendered comment is English, like every other comment
in this repository.

## Severity levels

`ReportFindings` has no `severity` field — its `level` is the effort the review ran at — so severity
exists only in this comment and in the order the report is sorted. These four definitions are
authoritative; the reviewer agents defer to "the same severity framing as the project's other review
tooling", and this is it.

| Severity | What belongs here |
|---|---|
| CRITICAL | Reachable from untrusted input, or it loses or corrupts approved canonical data: a credential reaching a log or an error, a write outside the repository boundary, a string-built query. |
| HIGH | A wrong result, a crash, or a security control that does not hold — on an input the code is expected to meet, not a contrived one. |
| MEDIUM | A real defect confined to an edge case, a safe-but-degraded behaviour, or a prose/contract discrepancy with no data consequence. |
| LOW | Correct today but fragile: a claim the diff makes with no test behind it, an error a reader cannot act on, a comment that no longer matches the code. |

CRITICAL and HIGH are exactly the two that Step 4 sends to `finding-validator`. Severity decides
whether a finding is adjudicated at all, so it is pinned here rather than left to four adjectives an
implementer guesses at.

## Template

Both SHAs on the range line are written **in full (40 characters)**: the posting step greps that line
for the head SHA and refuses to post when it is no longer `HEAD`.

````markdown
<!-- iroha-review-summary -->
## iroha-review (development self-review)

`<merge-base sha>..<head sha>` · N files, +A/-B · scope: committed only
reviewers: adversarial (xhigh), spec-compliance (medium), security
security-diff-reviewer: skipped — diff outside `packages/git|forge*|adapter-*`

### Findings

| # | Severity | Verdict | Site | Failure scenario | Outcome |
|---|---|---|---|---|---|
| 1 | HIGH | CONFIRMED | `packages/core/src/x.ts:42` | <concrete input/state → observable consequence> | fixed in `abc1234` |
| 2 | MEDIUM | — | `packages/api/src/routes/y.ts:88` | <…> | open |

Excluded: 1 — finding-validator returned invalid (<one-line reason>)
Duplicates collapsed: 2 — two reviewers reported the same defect, counted once (corroborated)

### Not covered

- Windows behaviour unverified (ran on macOS; Windows is out of the verify matrix per
  `.claude/rules/windows-ci-compat.md`)
- No live Voyage credentials, so the embedding path was exercised only through recorded vectors

<details><summary>Deterministic checks</summary>

```text
$ pnpm lint && pnpm typecheck && pnpm test && pnpm build
<output>
```

</details>
````

Filling it in:

- **Verdict** and **Outcome** reuse `ReportFindings`' own enums — `CONFIRMED`/`PLAUSIBLE`, and
  `fixed`/`skipped`/`no_change_needed` — written as `fixed in <short sha>`, `skipped (<reason>)`, or
  `no change needed`. A finding nobody has acted on yet is `open`. MEDIUM/LOW carry no verdict (`—`),
  since Step 4 does not validate them.
- **A review that found nothing still gets a draft.** Replace the table with a single line
  `Findings: none`; keep the section. "Not covered" is never empty — it is the part of the comment
  that a human reviewer cannot reconstruct from the diff.
- Drop the `Excluded:` / `Duplicates collapsed:` lines when the count is zero.
- Name the reviewers that actually ran, with the effort each ran at, and say in one line why
  `security-diff-reviewer` was or was not among them.

## What the format deliberately omits

- **No confidence score, no merge-readiness verdict, no "no issues found" headline.** Greptile
  publishes a 0–5 "Production ready" score and CodeRabbit an "Estimated review effort"; both are
  rejected here. `AGENTS.md` records that framing an LLM reviewer with benign-sounding PR metadata
  measurably suppresses vulnerability detection (Mitropoulos et al., arXiv:2603.18740), this
  repository is public, and Codex reads the PR. Stating evidence costs nothing; stating a verdict is
  exactly the input that study describes.
- **No prose summary of the change.** The PR body carries it, and a duplicate is where the point
  above concentrates.
- **Findings are never inside `<details>`.** Only command output collapses.
  `~/.claude/rules/code-review-triage.md` forbids a review surface where a finding hides behind a
  fold.

## Posting

One sticky comment, updated in place, rather than a new comment per push. The hidden
`<!-- iroha-review-summary -->` marker is the identifier of record: match on it, never on comment
author, which breaks under a custom token (anthropics/claude-code-action#960).
`gh pr comment --edit-last --create-if-none` covers create and update in one command, but
`--edit-last` targets the current user's *last* comment — once a triage reply sits after the summary,
edit the summary by its comment id instead.
