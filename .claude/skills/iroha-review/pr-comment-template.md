# PR comment template — the iroha-review summary

Step 6 of `SKILL.md` renders this into the draft file; `post-summary.sh` posts it after
`gh pr create`. The rendered comment is English, like every other comment in this repository.

## Severity levels

`ReportFindings` has no `severity` field — its `level` is the effort the review ran at — so severity
exists only in this comment and in the order the report is sorted. The reviewer agents describe a
finding's consequence in prose and do not name a level; the orchestrator assigns one, and these are
the definitions it applies:

| Severity | What belongs here |
|---|---|
| CRITICAL | Reachable from untrusted input, or it loses or corrupts approved canonical data: a credential reaching a log or an error, a write outside the repository boundary, a string-built query. |
| HIGH | A wrong result, a crash, or a security control that does not hold — on an input the code is expected to meet, not a contrived one. |
| MEDIUM | A real defect confined to an edge case, a safe-but-degraded behaviour, or a prose/contract discrepancy with no data consequence. |
| LOW | Correct today but fragile: a claim the diff makes with no test behind it, an error a reader cannot act on, a comment that no longer matches the code. |

Severity decides whether a finding is adjudicated at all — Step 4 sends a CRITICAL or HIGH finding to
`finding-validator` **when it arrived without a reproduction**, and never sends MEDIUM or LOW. So the
levels are pinned here rather than left to four adjectives an implementer guesses at. Read this table
at Step 4, not only at Step 6.

## Template

Two SHAs, with different jobs:

- The **reviewed range** is what the reviewer agents actually read. It never changes once they ran.
- The hidden **`iroha-review-draft-head`** marker is the commit the draft is current as of, and it is
  what `post-summary.sh` compares against `HEAD`. Re-render it every time the draft is updated —
  including after each fix commit. Without that, a review that fixed anything could never be posted.

Both are full 40-character SHAs in the marker; the visible line may abbreviate for readability.

````markdown
<!-- iroha-review-summary -->
<!-- iroha-review-draft-head: 0000000000000000000000000000000000000000 -->
## iroha-review (development self-review)

reviewed `<merge-base sha>..<reviewed head sha>` · N files, +A/-B · scope: committed only
reviewers: adversarial (xhigh), spec-compliance (medium), security (medium)
security-diff-reviewer: skipped — diff outside `packages/git|forge*|adapter-*`

### Findings

2 HIGH · 1 MEDIUM — 2 fixed, 1 open

1. **HIGH** · `packages/core/src/x.ts:42` · CONFIRMED · fixed in `abc1234`
   <concrete input/state → observable consequence, one or two sentences>

2. **MEDIUM** · `packages/api/src/routes/y.ts:88` · open
   <…>

Excluded: 1 — finding-validator returned invalid (<one-line reason>)
Duplicates collapsed: 2 — two reviewers reported the same defect, counted once (corroborated)
Fix commits `abc1234`, `def5678` landed after the reviewed head and were not themselves reviewed.

### Not covered

- Windows behaviour unverified (ran on macOS; Windows is out of the verify matrix per
  `.claude/rules/windows-ci-compat.md`)
- No live Voyage credentials, so the embedding path was exercised only through recorded vectors

<details><summary>Deterministic checks</summary>

```text
pnpm lint / typecheck / test / build — pass (test: 34/34 tasks, 0 cached)
pnpm lint:md — 0 issues in 39 files
```

</details>
````

Filling it in:

- **Findings are a list, not a table.** A failure scenario is variable-length prose, and GitHub sizes
  table columns by content: put ten of them in a six-column table and every cell wraps to a few words
  per line, so the table runs for screens and nothing is readable. One line of metadata per finding
  plus an indented sentence stays compact however long the prose is.
- The metadata line is severity, then `file:line`, then verdict, then outcome, joined by `·`.
  **Verdict** and **Outcome** reuse `ReportFindings`' own enums — `CONFIRMED` / `PLAUSIBLE`, and
  `fixed` / `skipped` / `no_change_needed` — rendered as `fixed in <short sha>`, `skipped (<reason>)`,
  or `no change needed`. A finding nobody has acted on yet is `open`. MEDIUM/LOW omit the verdict
  entirely rather than carrying a placeholder, since Step 4 does not validate them.
- Open with a one-line tally (`2 HIGH · 1 MEDIUM — 2 fixed, 1 open`) so a reader gets the shape
  before the detail. It counts what was found; it does not rate the change.
- **A review that found nothing still gets a draft.** Replace the list with a single line
  `Findings: none`; keep the section. "Not covered" is never empty — it is the part of the comment
  that a human reviewer cannot reconstruct from the diff.
- Drop the `Excluded:` / `Duplicates collapsed:` / `Fix commits` lines when they do not apply.
- Name the reviewers that actually ran with the effort each ran at, and say in one line why
  `security-diff-reviewer` was or was not among them.
- A Step 2 failure is a finding like any other and belongs in the list, not in the `<details>` fold.
  It has no `file:line`, so put the command where the site goes and what it printed in the sentence.

### Never write an `@`-mention in the body

The comment is posted by an account with write access, so every mention in it fires for real. Writing
the Codex trigger phrase — an `@` followed by `codex` — anywhere in the body **starts a cloud chat**,
because the documented rule is that mentioning it "with anything other than `review`" does exactly
that, and a summary is by definition a body full of other text. Reproduced on PR #191: a finding whose
prose quoted the trigger phrase caused a cloud-chat run that authored its own commit in a sandbox and
reported back on the PR. A user or team mention is the same class of mistake, minus the code.

Name the bot and its triggers in prose instead — "the Codex trigger phrase", "a `codex review`
comment" — and never with a literal `@`. Grep the rendered draft for `@` before posting.

### Never paste raw command output

Summarize the deterministic checks; do not paste transcripts. Verified by reproduction: `pnpm test`
opens with `RUN v4.1.10 <absolute path to the package>` and `turbo run build` prints
`config file: <absolute path>/package.json`. Those are local absolute paths, which `AGENTS.md` lists
under **Never** for artifacts and the Definition of done forbids. This body is machine-rendered and
posted verbatim, so no human reads it before it ships; the permission prompt shows the command, not
the file's contents.

- Report each check as one line: the command, pass/fail, and the counts that matter.
- Any path that does survive must be repo-relative.
- **Never quote a secret-grep match.** Step 2 presents matching lines locally so a human can judge
  them; the PR comment names the file and says a candidate matched. Publishing the line to a public
  repository is the one failure this comment must not cause.

## What the format deliberately omits

- **No confidence score, no merge-readiness verdict, no "no issues found" headline.** Greptile
  publishes a 0–5 "Production ready" score and CodeRabbit an "Estimated review effort"; both are
  rejected here. `AGENTS.md` records that framing an LLM reviewer with benign-sounding PR metadata
  measurably suppresses vulnerability detection (Mitropoulos et al., arXiv:2603.18740), this
  repository is public, and Codex reads the PR. Stating evidence costs nothing; stating a verdict is
  exactly the input that study describes. `Findings: none` is on the evidence side of that line — it
  reports what this pipeline found, and the mandatory "Not covered" section next to it keeps the
  reader's attention on what nobody checked.
- **No prose summary of the change.** The PR body carries it, and a duplicate is where the point
  above concentrates.
- **Findings are never inside `<details>`.** Only the check summary collapses.
  `~/.claude/rules/code-review-triage.md` obliges a reader to expand every fold before triage is
  complete, so putting a finding behind one works against the reader it depends on.

### The trade-off this comment accepts

"Not covered" and "Excluded" tell any reader — including an adversarial one, on a public repository —
what this pipeline did not examine and which findings its adjudicator dismissed. That is the same
oracle arXiv:2603.18740 describes, and publishing it is a deliberate choice, not an oversight: a
human reviewer cannot reconstruct coverage gaps from the diff, while an attacker gains only what the
already-public `SKILL.md` reviewer table implies. Revisit this if the reviewer roster ever stops
being public.

## Posting

`bash .claude/skills/iroha-review/post-summary.sh` — one command, and the only place the posting
rules live. It refuses on a stale draft, matches the existing comment by the hidden
`<!-- iroha-review-summary -->` marker so a later run updates in place, and creates one only when no
marked comment exists. **It deletes the draft once the post succeeds** — the comment is the record
from then on, and drafts must not accumulate in `.git/`. A refusal keeps the draft so it can be
inspected or corrected.

The search is scoped to comments the authenticated account owns. That is not "matching by author":
the marker remains the identifier, and ownership is a guard. What made `--edit-last` wrong was picking
your *most recent* comment regardless of its content; what makes marker-alone wrong is that on a
public repository anyone can post a body containing the marker, and a maintainer's token can edit
other people's comments — so the script would overwrite a stranger and never update the real summary.
