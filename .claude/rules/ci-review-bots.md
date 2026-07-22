# CI review bots (Greptile / Codex): monitoring and response

Every PR in this repo is reviewed by two AI reviewers: **Greptile** and **OpenAI Codex**. They are observed in fundamentally different ways. In particular, **Codex is invisible to CI**, so judging "the review passed" from `gh pr checks` alone silently misses every Codex finding. After a push, do not report the work as done until you have actually seen both reviewers' verdicts (an extension of `~/.claude/rules/ci-discipline.md`, "see CI through to completion"). The discipline of reading every finding without skipping is [[code-review-triage]].

## Greptile

- **Triggers**: on PR open, and on **every push** (observed in this repo). The public default is `triggerOnUpdates: false` (initial PR only), but this repo enables review-on-push via dashboard settings — there is no `greptile.json` in the repo; it is dashboard-managed. Manual re-trigger: comment `@greptileai` on the PR (no rate limits).
- **Signals (three channels)**:
  1. A **CI status check named "Greptile Review"** — observable with `gh pr checks <PR>` (dashboard `statusCheck: true`). This check **passes regardless of whether findings were posted** (it is advisory and does not block merge). "pass" does NOT mean "no findings".
  2. **PR reaction emoji**: 👀 while analyzing → 👍 when complete → 😕 on failure (official docs).
  3. **Posted output**: a top-level "Greptile Summary" comment (Confidence Score N/5, per-file breakdown) plus inline comments, most with an applyable suggestion.
- **Severity badges**: **P0 Critical** (must fix before merge: vulnerabilities, data loss, crashes) / **P1 High** (bugs, incorrect behavior, edge cases) / **P2 Medium** (quality, maintainability).
- **Re-review behavior (observed)**: an additional push does not post a new Summary — it **updates the existing Summary in place** (its `updated_at` becomes later than the push) and re-anchors inline comments to the new commit. Threads whose findings it judges resolved may be auto-set to `resolved=true` by Greptile.
- **How to monitor**: `gh pr checks <PR> | grep -i greptile`, wait pending→pass → read the Summary and **every inline comment, including collapsed `<details>` sections** → always triage P0/P1, and read P2 before deciding to accept or dismiss ([[code-review-triage]]).

## Codex (`@codex review`)

- **Not observable from CI.** The hosted Codex reviewer appears in **no GitHub status check / Checks API entry** (official docs position it as separate from CI: "Leave mechanical checks in CI"). `gh pr checks` never shows Codex. **This is the main trap.**
- **Triggers**: **only on PR open** for automatic review (the docs do not document push-triggered auto-review — a push does NOT re-run Codex). Any further review must be requested on demand (below).
- **Bot account**: `chatgpt-codex-connector[bot]`. Filter reactions/reviews by this login.
- **Actively poll for it — nothing notifies you.** Because Codex is invisible to CI, YOU must watch for it; do not wait to be told it's running. Whenever a PR is open (and again after you push to one), check its reactions for `chatgpt-codex-connector[bot]`. A 👀 means a review is **in progress** — do not treat the PR as reviewed, and do not merge, while Codex is still 👀. Wait for it to resolve (a posted review, or the 👀 giving way to 👍). **Bounded wait, not forever**: a Codex review normally finishes within a few minutes; if a 👀 is still unresolved after ~10 minutes, treat the run as stalled — note "Codex appears stalled" and proceed on the other signals rather than blocking indefinitely.
- **How to observe**: (a) **PR reaction emoji** — 👀 while reviewing; in this repo's observation, 👍 on completion-with-no-issues and **the 👍 is removed (no emoji) on completion-with-issues**. NOTE: official docs only guarantee the working-state 👀 and a posted review; the completion 👍 / 👍-removal is an **observed convention in this repo, not a documented guarantee** — do not rely on it blindly; always check both the reaction and the posted review. (b) **The posted PR review** — on completion Codex posts a standard GitHub review with summary + inline comments (on GitHub it flags **P0/P1 only**).

```bash
# Codex reaction state (eyes = reviewing, +1 = done/clean)
gh api repos/<owner>/<repo>/issues/<PR>/reactions \
  --jq '.[] | select(.user.login=="chatgpt-codex-connector[bot]") | .content'
# Codex posted review, if any
gh api repos/<owner>/<repo>/pulls/<PR>/reviews \
  --jq '.[] | select(.user.login=="chatgpt-codex-connector[bot]") | {state, submitted_at}'
```
- **Rate limits**: Codex code review is metered in a separate "Code Reviews / 5h" bucket; exact per-plan counts are unpublished. **When exhausted it stops responding** (in this repo Codex is often unavailable due to hitting the limit).
- **Review-guidance entry point**: the repo-root `AGENTS.md` §"Reviewing a diff (PR review in CI)" is Codex's review guidance and points it at `.claude/agents/{security,spec-compliance,adversarial}-reviewer.md`.

### Deciding whether Codex re-review is needed is YOUR (Claude's) job

Codex spends its 5h bucket on every re-review, and firing it mechanically on every push **drains the limit before it matters**. So decide whether *this* push warrants a Codex re-review yourself — do not ask the user each time, and do not request one on every push.

**Request a re-review** when the diff since Codex's last review contains any of:
- New non-trivial logic in security-sensitive areas (credential/secret handling, path/symlink validation, subprocess execution, external boundaries) → scope it with **`@codex review for security regressions`**.
- A new external boundary, parser, string-built query, auth path, or redaction path.
- A change to the threat surface or a security-relevant invariant.
- Substantial new behavior a fresh reviewer has not seen.

**Do not request** (default; preserve the limit) when the push is:
- The exact fix another reviewer already requested (no new surface).
- Formatting / lint / comment / rename only.
- Tests only or docs only.
- A mechanical refactor with no behavior change.

**Trigger syntax** (PR comment): whole PR `@codex review`; scoped `@codex review for security regressions` or `@codex review for missing tests and risky behavior changes`. `@codex <anything other than review>` opens a PR-context cloud chat instead of a review, so avoid it. When unsure and the diff is security-sensitive, prefer the scoped `for security regressions` over a full review (predictable spend).

- If Codex was **down (rate-limited) at PR-open**, its automatic pass may not have fired. But **"down at open" does not mean "never reviews"**: once the limit recovers, Codex has been observed to pick up an already-open PR on its own (a 👀 appears late) — so keep polling its reaction/review before concluding it skipped the PR. If, after the limit is known to be clear, it still has not reacted and the PR is security-sensitive, request one pass under the criteria above.

## Resolve and close comment threads after pushing a fix

When you push a fix that addresses a review comment, **resolve and close that review thread** (bots do not always auto-resolve). Leaving threads open invites the next review round — or a different reviewer — to re-raise the same point.

```bash
# 1) List threads (id / isResolved / path / first comment author)
gh api graphql -f query='query { repository(owner:"<owner>", name:"<repo>") {
  pullRequest(number:<PR>) { reviewThreads(first:50) { nodes {
    id isResolved path line comments(first:1){nodes{author{login}}} } } } }' \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | "\(.id) resolved=\(.isResolved) \(.path):\(.line)"'

# 2) Resolve an addressed thread
gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:"<THREAD_ID>"}) { thread { isResolved } } }'
```

Before resolving a finding you judged INVALID, leave a PR comment with the evidence (repro log / primary-source URL) first ([[code-review-triage]], cyclic false positives).

## Pre-completion checklist

After a push, do not say "review passed" until you have actually confirmed:

- [ ] `gh pr checks <PR>` shows Greptile Review passing, AND you read the Summary + every inline comment and triaged them.
- [ ] Codex checked: you polled its reaction/review and it is **not mid-review** (no lingering 👀 from `chatgpt-codex-connector[bot]`) — waited for it to resolve, never merged under a 👀. Only after the limit is confirmed clear and no reaction appears do you state "Codex did not run" and decide re-review necessity by the criteria above.
- [ ] Threads for the findings you addressed are resolved.

## Related

- Read every finding, prove INVALID by reproduction, handle cyclic false positives: [[code-review-triage]].
- See CI through to completion after a push: `~/.claude/rules/ci-discipline.md`.
- The review standard this repo holds Codex to: repo-root `AGENTS.md`.
