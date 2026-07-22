---
name: iroha-review
description: |
  iroha-specific whole-project self-review. Targets committed changes (default: everything since the merge-base with main), reviewing them through a multi-stage pipeline: deterministic checks (lint/typecheck/test/build/secret grep) → launch multiple fresh-context reviewers (security-reviewer / spec-compliance-reviewer / adversarial-reviewer) in parallel → reproduce-and-verify HIGH/CRITICAL findings with finding-validator. Can be invoked at any time, with or without a PR. If the working tree has uncommitted changes, use AskUserQuestion to confirm whether to include them. Zero side effects (no commit, push, or state writes), fail-open (this skill itself does not block the merge; it only reports findings). Invoked by "self-review this", "review this", or "/iroha-review". Distinct from the existing `self-review` skill, which is narrowed to security-sensitive packages such as packages/git (pre-push only, specialized for 4-pattern regression checks) — this skill is for the whole repository, at any time.
user-invocable: true
allowed-tools: Bash(git rev-parse *) Bash(git symbolic-ref *) Bash(git show-ref *) Bash(git merge-base *) Bash(git diff *) Bash(git status *) Bash(pnpm lint) Bash(pnpm typecheck) Bash(pnpm test) Bash(pnpm build) Bash(grep *) Read Grep Glob AskUserQuestion Agent(security-reviewer) Agent(spec-compliance-reviewer) Agent(adversarial-reviewer) Agent(finding-validator) ReportFindings
---

# iroha-review — whole-project self-review

A review pipeline that is broader than `self-review` (which is limited to packages/git and the like, pre-push only), targets the entire iroha monorepo, and can be invoked at any time. It is designed on the basis of the state of the art as of July 2026 (independent review by each specialist agent → per-finding adjudication is the most effective way to suppress false positives) and of `~/.claude/rules/code-review-triage.md` (verification by reproduction).

## Approach

- **By default, only committed changes are in scope**. If there are uncommitted changes, always confirm with the user (do not include or exclude them on your own).
- **Zero side effects**. Do not create state files like `.mumei`, and do not commit or push. Report the findings and stop.
- **fail-open**. This skill itself is not what decides "whether the merge is allowed". It presents the severity of the findings and the verification results; the user decides whether to act on them.
- **fresh-context principle**. Each reviewer Agent is invoked without the context of this conversation (why this change was made). Reviewing within the same context introduces confirmation bias (the same reason as `.claude/agents/security-diff-reviewer.md`).
- No auto-fixing. After reporting the findings, wait for the user's instructions on whether and how to fix them.

## Step 1 — Determine the target diff

```bash
git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repository"; exit 0; }

base="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
if [ -z "$base" ]; then
  git show-ref --verify --quiet refs/heads/main && base="main"
fi
if [ -z "$base" ]; then
  git show-ref --verify --quiet refs/heads/master && base="master"
fi
if [ -z "$base" ]; then
  echo "cannot resolve base ref; a main or master branch is required."
  exit 0
fi

merge_base="$(git merge-base "$base" HEAD 2>/dev/null)"
committed_files="$(git diff --name-only "$merge_base"..HEAD)"
uncommitted_status="$(git status --porcelain)"
```

- If `committed_files` is empty, report "no diff against `$base`, nothing to review" and stop.
- If `uncommitted_status` is non-empty, confirm with **AskUserQuestion**: "Should the uncommitted changes (present the list) also be included in the review scope?"
  - Include → the target diff is `git diff "$merge_base"` (includes the working tree; one-dot, not two-dot)
  - Do not include → the target diff is `git diff "$merge_base"..HEAD` (committed only)
- Report the list of changed files and the size of the target diff (line count) up front, and make the review scope explicit.

## Step 2 — Deterministic checks (ground truth, no LLM judgment needed)

Depending on the scope, run these from the repository root (the same suite as "Required verification for every change" in `CLAUDE.md`):

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If any of them fails, treat that in itself as a **confirmed (no-verification-needed) finding** — include the output of the failed command directly in the findings. Because this is an execution result and not speculation, re-verification with finding-validator is unnecessary.

Additionally, run a lightweight secret-pattern grep against the changed files (do not assume a dedicated scanner):

```bash
grep -nE "AKIA[0-9A-Z]{16}|gh[ps]_[A-Za-z0-9]{36,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|(api[_-]?key|secret|password|token)[\"']?\s*[:=]\s*[\"'][A-Za-z0-9_\-]{16,}[\"']" $(echo "$committed_files")
```

If there is a match, treat it as a confirmed finding (false positives are possible, so present the matching lines so the user / downstream reviewers can judge).

## Step 3 — Launch reviewers in parallel (fresh context)

Pass each reviewer **only the diff itself and the changed file paths**. Do not pass why the change was made or what conversation took place (fresh-context principle).

```text
Agent(security-reviewer, prompt: "<diff> <changed files>")
Agent(spec-compliance-reviewer, prompt: "<diff> <changed files>")
Agent(adversarial-reviewer, prompt: "<diff> <changed files>")
```

The three have independent perspectives (security / spec & invariant compliance / correctness & edge cases), so they may be launched in parallel (three Agent calls in a single message).

## Step 4 — Verify HIGH/CRITICAL findings (adjudication)

Of the candidate findings gathered in Step 3, have `finding-validator` independently verify the HIGH/CRITICAL ones, one at a time. MEDIUM/LOW may be skipped (even in 2026-era practice, verifying every finding has poor cost-effectiveness, and narrowing to the high-severity ones is standard).

```text
Agent(finding-validator, prompt: "<one finding: file, line, failure scenario>")
```

`finding-validator`'s verdict:
- `valid` → include in `ReportFindings` with `verdict: CONFIRMED`
- `invalid` → drop it (leave a one-line reason under "excluded findings" in the final report — to prevent recurrence of a cyclic false positive)
- `unsure` → include with `verdict: PLAUSIBLE`, and state explicitly that it "could not be verified"

For MEDIUM/LOW findings whose verification was skipped, include them without a `verdict` (or as PLAUSIBLE).

## Step 5 — Report

Call the `ReportFindings` tool once, passing the final list of findings sorted by descending severity (if the array is empty, "no findings"). `level` is usually `"high"` because multiple agents plus a verification pass are run.

In addition to the `ReportFindings` output, state the following explicitly in the conversation:

1. The review scope (committed only / including uncommitted, diff line count, base ref).
2. The result of the Step 2 deterministic checks (whether everything passed, what failed).
3. **What is not covered** (e.g., "Windows-specific behavior could not be verified in this environment", "dedicated tools such as semgrep/osv-scanner are not installed, so pattern grep only"). Do not paper over what you do not know with a pretense of knowing it (the evaluation-honesty principle in `~/.claude/CLAUDE.md`).
4. That this skill changed nothing (no commit, no push).

## What this skill does not do

- Do not commit, push, or create a PR.
- Do not create state files like `.mumei`.
- Do not auto-fix findings (wait for the user's instructions for the next action).
- Do not treat high-severity findings as confirmed without verification (Step 4 is mandatory; do not skip it).
- When nothing is found, do not invent plausible-looking findings (honestly report an empty array).

## Troubleshooting

- **Exits with "not a git repository"** — the current directory is not under git. Run from the root of the iroha repository (or a directory under it).
- **Exits with "cannot resolve base ref"** — none of `origin/HEAD`, `main`, or `master` can be found. Create a local main branch, or set origin/HEAD with `git remote set-head origin -a`, then re-run.
- **Exits immediately with "no diff"** — the current HEAD is the same as the base ref (usually main) or older than it. Check whether the changes you want to review are committed on a different branch / in an unpushed state.
- **spec-compliance-reviewer flagged a discrepancy with decision-log.md or schemas/, but it is unclear which is correct** — do not adopt either on your own; present the contradiction as-is to the user (`~/.claude/rules/investigate-before-asking.md`).
- **finding-validator keeps returning `unsure`** — the tools needed for verification (specific OS-dependent behavior, access to an external service, etc.) are likely absent in this environment. Report it as `unsure`, and note which tools/environment would be needed to verify it.

## Usage examples

Invocation: "self-review this", "/iroha-review", "review the changes on this branch".

Skeleton of a typical output:

```
Scope: committed changes since the merge-base with main (2 uncommitted changes: asked whether to include → chose not to)
diff: 8 files changed, +640/-12

Step 2 deterministic checks: lint OK / typecheck OK / test OK (83 passed) / build OK / secret patterns: none detected

[ReportFindings output: 1 finding (MEDIUM, verdict: CONFIRMED), or "no findings"]

Not covered: Windows-specific newline/path behavior was not verified in this environment (macOS).

This skill changed nothing (no commit, no push).
```
