---
name: pr-review-status
description: Find out what the AI reviewers said about a pull request, and respond to them. Two run here — hosted OpenAI Codex and Gemini Code Assist — and Codex is invisible to CI, appearing in no status check, so `gh pr checks` being green says nothing about whether a review ran, is still running, or left findings. Use after pushing to a PR and before reporting the work as done, when deciding whether a re-review is worth its rate limit, and when replying to or resolving a review thread. Not for reviewing a diff yourself — that is `iroha-review`.
user-invocable: true
allowed-tools: Bash(curl *) Bash(gh api *) Bash(gh pr *) Read Grep
---

# Reading and answering the AI reviewer on a PR

**Two reviewers run here: Codex and Gemini Code Assist.** Both must be read before calling a PR
reviewed. **Greptile is disabled** — waiting for a "Greptile Review" check that will never appear
stalls the whole post-push check, so the Greptile section at the bottom is kept for the day it is
re-enabled and should not be acted on until then.

## 1. Find Codex's state

Codex appears in **no GitHub status check** (the official docs position it as separate from CI:
"Leave mechanical checks in CI"), so nothing notifies you and `gh pr checks` never shows it. Poll it.

```bash
# Reaction state: eyes = reviewing, +1 = done/clean
gh api repos/iroha924/iroha/issues/<PR>/reactions \
  --jq '.[] | select(.user.login=="chatgpt-codex-connector[bot]") | .content'
# The posted review, including its summary body — `/comments` returns only the
# inline threads, so dropping `body` here loses the verdict-level guidance entirely
gh api repos/iroha924/iroha/pulls/<PR>/reviews \
  --jq '.[] | select(.user.login=="chatgpt-codex-connector[bot]") | {state, submitted_at, body}'
# The findings themselves
gh api repos/iroha924/iroha/pulls/<PR>/comments --jq '.[] | {user: .user.login, path, line, body}'
```

Reading the result:

- **👀 means a review is in progress.** Do not treat the PR as reviewed and do not merge while it
  stands. **Bounded wait**: a review normally finishes within a few minutes; if a 👀 is unresolved
  after ~10 minutes, call the run stalled, say so, and proceed on the other signals.
- **A cleared reaction (no emoji) means completed *with* findings**, and 👍 means completed clean —
  but this is an **observed convention in this repo, not a documented guarantee**. The docs promise
  only the working-state 👀 and a posted review. Always check both the reaction and the posted review.
- Codex reviews **only on PR open**. A push does *not* re-run it (no push-triggered auto-review is
  documented). Anything further is on demand.
- Codex is metered in a separate "Code Reviews / 5h" bucket with unpublished per-plan counts. **When
  exhausted it simply stops responding**, which in this repo is common.
- **Down at PR-open does not mean "never".** Once the limit recovers, Codex has been observed to pick
  up an already-open PR on its own (a late 👀). Keep polling before concluding it skipped the PR.

Read **every** finding, including collapsed `<details>` sections, and prove an INVALID verdict by
reproduction — `~/.claude/rules/code-review-triage.md`.

## 2. Decide whether a re-review is warranted — this is your call, not the user's

Every re-review spends from the same 5-hour bucket. Firing one on each push drains the limit before
it matters, so judge *this* push yourself; do not ask each time, and do not request on every push.

**Request** when the diff since Codex's last pass contains any of:

- New non-trivial logic in a security-sensitive area (credential/secret handling, path/symlink
  validation, subprocess execution, external boundaries) → scope it: `@codex review for security regressions`
- A new external boundary, parser, string-built query, auth path, or redaction path
- A change to the threat surface or a security-relevant invariant
- Substantial new behavior a fresh reviewer has not seen

**Do not request** (the default — preserve the limit) when the push is:

- The exact fix another reviewer already asked for (no new surface)
- Formatting, lint, comments, or a rename only
- Tests only or docs only
- A mechanical refactor with no behavior change

## 3. Trigger syntax — `@codex` is a trigger, not a way to address the bot

Whole PR: `@codex review`. Scoped: `@codex review for security regressions`, or
`@codex review for missing tests and risky behavior changes`. When the diff is security-sensitive and
you are unsure, prefer the scoped form — the spend is predictable.

Per the official docs ([developers.openai.com/codex/integrations/github](https://developers.openai.com/codex/integrations/github)
→ learn.chatgpt.com/docs/third-party/github, verified 2026-07-22): *"If you mention `@codex` in a
comment with anything other than `review`, Codex starts a cloud chat using your pull request as
context"* — e.g. `@codex fix the P1 issue` opens a cloud chat that can push a fix to the branch.

So **only ever type `@codex review`** (optionally scoped). To reply to a finding or leave triage
evidence, use a **plain comment with no `@codex` mention**. Opening one with `@codex re …` does not
address the bot; it silently fires a cloud chat (observed 2026-07-22: `@codex re the … finding`
produced a "create an environment for this repo" cloud-chat reply).

## 4. Resolve the threads you addressed

Bots do not reliably auto-resolve. An open thread invites the next round — or a different reviewer —
to re-raise the same point.

```bash
gh api graphql -f query='query { repository(owner:"iroha924", name:"iroha") {
  pullRequest(number:<PR>) { reviewThreads(first:50) { nodes {
    id isResolved path line comments(first:1){nodes{author{login}}} } } } }' \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | "\(.id) resolved=\(.isResolved) \(.path):\(.line)"'

gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:"<THREAD_ID>"}) { thread { isResolved } } }'
```

Before resolving a finding you judged INVALID, post the evidence first (a reproduction log, a
primary-source URL) — again as a plain comment with no `@codex` mention.

## 5. Before saying the review passed

- [ ] `gh pr checks <PR>` green (there is no Greptile check to wait for while it is disabled)
- [ ] Codex polled and **not mid-review** — no lingering 👀. Only after the limit is confirmed clear
      and no reaction appears do you state "Codex did not run" and apply §2
- [ ] Threads for the findings you addressed are resolved

## Gemini Code Assist

Configured in-repo, unlike Codex: `.gemini/config.yaml` sets the behaviour and `.gemini/styleguide.md`
is the review standard (it defers to `AGENTS.md` so both reviewers are held to one bar). Changing how
Gemini reviews is a normal PR, not a dashboard setting.

- **Triggers**: PR opened, and a draft marked ready. `include_drafts: false` in the config means a
  PR that is still a draft is not reviewed. Manual: `/gemini review` (whole PR), `/gemini summary`,
  `/gemini help`.
- **Output**: a summary comment plus inline review comments. The config runs it at
  `comment_severity_threshold: LOW` with `max_review_comments: -1`, so expect a long list on a large
  diff — that is deliberate (the reasoning is in `config.yaml`'s own comments), and the triage rules
  in `~/.claude/rules/code-review-triage.md` are what keep it survivable: read every finding, fix by
  an explicit standard, record every rejection.
- **Re-review**: `/gemini review`, scoped in the same comment if you want a narrower pass. Apply §2's
  judgement — a re-review costs a round trip and re-posts on unchanged code, so do not fire one for a
  formatting or docs-only push.
- **Unverified**: whether Gemini surfaces as a GitHub status check in this repo has not been observed
  yet. Until it has, read its comments directly rather than trusting `gh pr checks` to represent it,
  and correct this line once you have seen a real PR.

Read it the same way as Codex — the same `pulls/<PR>/reviews` and `pulls/<PR>/comments` endpoints
return its output, filtered on its bot login instead of `chatgpt-codex-connector[bot]`.

## Greptile — disabled; reference only

Do not act on this while Greptile is off.

- **Triggers**: PR open, and every push (this repo enables review-on-push via dashboard settings;
  the public default is initial-PR-only, and there is no `greptile.json` in the repo). Manual
  re-trigger: comment `@greptileai`.
- **Three channels**: a CI status check named "Greptile Review" (which **passes whether or not
  findings were posted** — advisory, non-blocking, so "pass" ≠ "no findings"); a PR reaction
  (👀 analyzing → 👍 complete → 😕 failed); and the posted output (a "Greptile Summary" comment with
  a confidence score and per-file breakdown, plus inline comments).
- **Severities**: P0 Critical (vulnerabilities, data loss, crashes — fix before merge), P1 High
  (bugs, wrong behavior, edge cases), P2 Medium (quality, maintainability).
- **Re-review** updates the existing Summary in place rather than posting a new one, and re-anchors
  inline comments to the new commit; threads it judges resolved may be auto-resolved.

## Related

- The review standard this repo holds Codex to: repo-root `AGENTS.md`, which points at
  `.claude/agents/{security,spec-compliance,adversarial}-reviewer.md`.
- Reviewing a diff yourself: the `iroha-review` skill.
- Reading every finding and proving INVALID by reproduction: `~/.claude/rules/code-review-triage.md`.
- Seeing CI through after a push: `~/.claude/rules/ci-discipline.md`.
