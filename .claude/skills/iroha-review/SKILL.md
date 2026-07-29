---
name: iroha-review
description: |
  The self-review pipeline for this repository — the only one. Targets committed changes (default: everything since the merge-base with main), reviewing them through a multi-stage pipeline: deterministic checks (lint/typecheck/test/build/secret grep) → launch fresh-context reviewers (security-reviewer / spec-compliance-reviewer / adversarial-reviewer, plus security-diff-reviewer when the diff touches packages/git, packages/forge*, or packages/adapter-*) in parallel → reproduce-and-verify HIGH/CRITICAL findings with finding-validator. Can be invoked at any time, with or without a PR, and is what to run before pushing a fix to a security-sensitive package. If the working tree has uncommitted changes, use AskUserQuestion to confirm whether to include them. No commit, push, or PR creation — its only write is the PR-comment draft inside `.git/`, which is never committed. fail-open (this skill itself does not block the merge; it only reports findings). Invoked by "self-review this", "review this", or "/iroha-review". Not for reviewing a GitHub pull request — use `/review` for that; this reviews the local branch's diff and needs no PR.
user-invocable: true
allowed-tools: Bash(git rev-parse *) Bash(git symbolic-ref *) Bash(git show-ref *) Bash(git merge-base *) Bash(git diff *) Bash(git status *) Bash(pnpm lint) Bash(pnpm lint:packages) Bash(pnpm knip) Bash(pnpm typecheck) Bash(pnpm test) Bash(pnpm build) Bash(grep *) Read Grep Glob AskUserQuestion Agent(security-reviewer) Agent(spec-compliance-reviewer) Agent(adversarial-reviewer) Agent(security-diff-reviewer) Agent(finding-validator) ReportFindings
---

# iroha-review — whole-project self-review

The one review pipeline for this repository: it targets the entire iroha monorepo, can be invoked at any time, and deepens itself for a security-sensitive diff rather than deferring to a second skill (Step 3). It is designed on the basis of the state of the art as of July 2026 (independent review by each specialist agent → per-finding adjudication is the most effective way to suppress false positives) and of `~/.claude/rules/code-review-triage.md` (verification by reproduction).

The *thinking* that belongs before a security-sensitive change — what a pattern change newly lets through, whether a fix generalizes to sibling call sites, which platform behavior a hand-rolled replacement drops, whether the value can simply be left out — lives in the path-scoped rules, which auto-load whenever you open a matching file: `.claude/rules/secure-subprocess-and-credentials.md` and `.claude/rules/path-and-symlink-safety.md`. This skill is the mechanical pass that runs after the change is written; it does not restate those rules.

## Approach

- **By default, only committed changes are in scope**. If there are uncommitted changes, always confirm with the user (do not include or exclude them on your own).
- **One write, nothing else**. The only file this skill creates is the Step 6 PR-comment draft inside `.git/`, which is never committed. Do not create state files like `.mumei`, and do not commit, push, or create a PR.
- **fail-open**. This skill itself is not what decides "whether the merge is allowed". It presents the severity of the findings and the verification results; the user decides whether to act on them.
- **fresh-context principle**. Each reviewer Agent is invoked without the context of this conversation (why this change was made). Reviewing within the same context introduces confirmation bias (the same reason as `.claude/agents/security-diff-reviewer.md`).
- **The tree stays frozen while reviewers run.** They are given a commit range and read it with `git diff`, so uncommitted edits are outside their scope — but a reviewer that also opens a file sees whatever is on disk *now*. Do not edit tracked files between launching Step 3 and collecting its results; if you must, commit first and re-run against the new range.
- **Report before fixing.** Findings are reported first, always. Whether fixing follows immediately depends on what the user already asked for (Step 5) — the point of the default is that a review never becomes an unrequested rewrite, not that a standing instruction gets ignored.

## Step 1 — Determine the target diff

```bash
git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repository"; exit 0; }
base="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
base="${base:-main}"
git show-ref --verify --quiet "refs/heads/$base" || base=master
merge_base="$(git merge-base "$base" HEAD)"
git diff --stat "$merge_base"..HEAD
git status --porcelain
```

- No `merge_base`, or an empty diff → report "no diff against `$base`, nothing to review" and stop. No `main`/`master`/`origin/HEAD` → report that and stop.
- Uncommitted changes present → confirm with **AskUserQuestion** whether to include them (present the list). Including them means the range becomes `git diff "$merge_base"` (one dot); excluding them keeps `"$merge_base"..HEAD`. **If they are included, commit them first** — reviewers read a commit range, so uncommitted work would otherwise be invisible to the very pass meant to cover it.
- Report the changed-file list and the diff size up front, and state the scope explicitly.

## Step 2 — Deterministic checks (ground truth, no LLM judgment needed)

Depending on the scope, run these from the repository root (the same suite as "Required verification for every change" in `CLAUDE.md`):

```bash
pnpm lint
pnpm lint:packages   # sherif: package.json consistency (run when the diff touches any manifest)
pnpm knip            # dead code / unused deps / unused exports (review-time signal, not a hard gate)
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

Pass each reviewer **the commit range and the changed-file list** — not the diff text, which for a large change does not fit a prompt. Every reviewer has `Bash` and reads the range itself. Do not pass why the change was made or what conversation took place (fresh-context principle).

```text
Agent(security-reviewer,        prompt: "git diff <merge_base>..HEAD ; <changed files>")
Agent(spec-compliance-reviewer, prompt: "git diff <merge_base>..HEAD ; <changed files>")
Agent(adversarial-reviewer,     prompt: "git diff <merge_base>..HEAD ; <changed files>")
```

The three have independent perspectives (security / spec & invariant compliance / correctness & edge cases), so they may be launched in parallel (Agent calls in a single message).

### Scale the pass to the diff

Three reviewers on a three-line change costs more than it can possibly return. Judge by what the diff actually touches, not by line count alone:

| Diff | Reviewers |
|---|---|
| Formatting, comments, a rename, a version bump, docs only | **none** — Step 2 is the whole review; say so and stop |
| One file, one behaviour, no new external boundary | `adversarial-reviewer` only |
| New logic, a new API/MCP surface, a schema change, or several packages | all three |
| Any of the above **plus** `packages/git`, `packages/forge*`, `packages/adapter-*` | all three + `security-diff-reviewer` |

Set `effort` per reviewer rather than letting all three inherit the session's. Precision holds at low effort, and depth pays unevenly: `adversarial-reviewer` is where an exhaustive sweep earns its cost (`xhigh`), while `spec-compliance-reviewer` mostly reads documents and compares them to code (`medium`).

### Add `security-diff-reviewer` when the diff touches a security-sensitive package

Verify the match against the actual changed-file list rather than assuming:

```bash
git diff --name-only "$merge_base"..HEAD | grep -E "^packages/(git|forge[^/]*|adapter-[^/]*)/"
```

`security-reviewer` covers OWASP-class defects across the whole monorepo; `security-diff-reviewer` is narrower and deeper, specialized for the four regression patterns these packages have actually produced (see `.claude/rules/secure-subprocess-and-credentials.md` and `path-and-symlink-safety.md`): a narrow fix that leaves the same defect at a sibling call site, a pattern change that trades one false-negative for another, code violating an invariant it declared in the same sitting, and dropped platform behavior when hand-rolling around an OS-native function. Skip it for a diff outside those packages — it has nothing to add there.

## Step 3.5 — Collapse duplicates and fold findings into each other

The reviewers run blind to each other, so expect overlap — in practice three or four of a dozen findings arrive more than once. Two passes over the collected list:

- **Same defect, several reporters** → keep one entry and note the corroboration. Independent agreement is evidence, so it *raises* confidence; it does not mean two findings.
- **One fix resolves several findings** → say so before fixing anything. Fixes genuinely collapse: removing a redundant validation can settle a documented-gate-order discrepancy at the same time. Missing this produces churn and a diff that looks larger than the change.

## Step 4 — Adjudicate the findings that need it

**Validate only a HIGH/CRITICAL finding that arrived without a reproduction.** A reviewer that ran the failure and pasted the output has already done this work; sending it to `finding-validator` re-derives a demonstrated fact. The reviewers describe consequences, not levels — you assign the severity, using the table in `pr-comment-template.md`, which is what makes this gate reproducible instead of a guess.

```text
Agent(finding-validator, prompt: "<one finding: file, line, failure scenario>")
```

`finding-validator`'s verdict:

- `valid` → include in `ReportFindings` with `verdict: CONFIRMED`
- `invalid` → drop it, and record a one-line reason under "excluded findings" in the final report (so a cyclic false positive does not come back next round)
- `unsure` → include with `verdict: PLAUSIBLE`, and state explicitly that it could not be verified

A finding whose reporter already reproduced it is `CONFIRMED` on that evidence — quote the reproduction rather than re-running it. MEDIUM/LOW are not validated; report them without a `verdict`.

Whatever the severity, for each finding you are going to act on, ask one more thing: **is there an existing test aimed at this, and why did it pass?** A test that exercises zero of the rows it looks like it exercises, or compares two reads of unchanged data, is its own finding and usually the more durable one.

## Step 5 — Report

Call the `ReportFindings` tool **once**, with the final list sorted by descending severity (an empty array when nothing survived). `level` is usually `"high"` because multiple agents plus an adjudication pass ran. Do not also print the findings as prose — the tool call *is* the report.

Alongside it, state in the conversation:

1. The review scope (committed only / including uncommitted, diff size, base ref).
2. The Step 2 deterministic results — what passed, what failed.
3. **What is not covered.** Be specific: "Windows-only behaviour was not verified on this machine (macOS)", "no live Forge credentials, so the GitHub path is untested". Do not paper over what you do not know (the evaluation-honesty principle in `~/.claude/CLAUDE.md`).
4. That this skill made no commit and no push — its only write is the Step 6 draft, and the path to it.

**If the user has already asked for the findings to be fixed** — they said "review and fix", or the review is running inside work they told you to finish — then report first, exactly as above, and continue into the fixes without waiting for a second instruction. The "wait for instructions" default exists so a review does not become an unrequested rewrite; it is not a reason to ignore an instruction you already have. Fix in severity order, apply Step 3.5's folding, and verify each fix goes red on the pre-fix code before claiming it works. Write the draft (Step 6) *before* starting the fixes, then as each fix lands update its Outcome row **and** the draft's `iroha-review-draft-head` marker to the new `HEAD`, and list the fix commits as not themselves reviewed. The reviewed range stays as it was — the reviewers never saw the fixes — so both facts have to be recorded separately, or the comment either cannot be posted or claims coverage it does not have.

## Step 6 — Draft the PR comment

Otherwise the review is gone once the session moves on, and it holds the one thing a human reviewer cannot reconstruct from the diff: what was deliberately **not** covered, and which findings were raised and then fixed.

Render `.claude/skills/iroha-review/pr-comment-template.md` from the same data you just passed to `ReportFindings` — the tool call and the draft must not disagree — and `Write` it to the draft path, then print that path:

```bash
draft="$(git rev-parse --git-path iroha-review-draft.md)"
case "$draft" in /*) ;; *) draft="$PWD/$draft" ;; esac   # Write needs an absolute path
echo "$draft"
```

- Record **two SHAs**, as the template requires: the reviewed range stays whatever the reviewers read, and the hidden `iroha-review-draft-head` marker is the commit the draft is current as of. `post-summary.sh` compares that marker against `HEAD`, so re-render it on every update to the draft.
- `--git-path` is how the product resolves its own local state (`packages/git/src/location.ts`, `docs/contracts/database.md` §2), so the draft stays correct under a linked worktree or a separate git dir and needs no `.gitignore` entry. It deliberately does *not* go under `<git-path iroha>/`, which is the product's local-state namespace — dev tooling does not squat in product state.
- **The write may prompt, and that is not something to engineer away.** `.git/` is a protected path, and permission allow-rules are not consulted for one, so adding `Write` (or `Edit(//…)`) to `allowed-tools` does not reliably suppress the prompt here — what it does reliably is pre-approve unprompted writes to every *other* path for the rest of the turn. Reproduced against Claude Code 2.1.220: a skill granted bare `Write` wrote an out-of-project absolute path unprompted, while the same grant was refused for a path under `.git/`. The observed behaviour depends on the session's permission mode. If the write is refused, no draft means no comment — the documented no-comment case, not a failure.
- **Write no draft when Step 3 launched zero reviewers** (the first row of its table). Step 2's results already belong in the PR body's "How verified" section, and a comment saying no reviewers ran is noise.
- A review that found nothing still gets a draft (`Findings: none`) — "Not covered" is the part worth posting.
- This skill does not post it. Posting is `bash .claude/skills/iroha-review/post-summary.sh`, run after `gh pr create` per `CLAUDE.md` and `AGENTS.md`.

## What this skill does not do

- Do not commit, push, or create a PR.
- Do not create state files like `.mumei`. The Step 6 draft inside `.git/` is the one exception, and it is never committed.
- Do not auto-fix findings **unless the user has already asked for it** (Step 5) — a review must not become an unrequested rewrite.
- Do not treat a high-severity finding as confirmed on reasoning alone. Either its reporter reproduced it or `finding-validator` did (Step 4).
- Do not tell a reviewer to be conservative, to report only high-confidence findings, or to filter its own output. Suppression instructions are followed literally and cost real findings; filtering is Step 4's job, not the reviewer's.
- When nothing is found, do not invent plausible-looking findings (honestly report an empty array).

## Troubleshooting

- **Exits with "not a git repository"** — the current directory is not under git. Run from the root of the iroha repository (or a directory under it).
- **Exits with "cannot resolve base ref"** — none of `origin/HEAD`, `main`, or `master` can be found. Create a local main branch, or set origin/HEAD with `git remote set-head origin -a`, then re-run.
- **Exits immediately with "no diff"** — the current HEAD is the same as the base ref (usually main) or older than it. Check whether the changes you want to review are committed on a different branch / in an unpushed state.
- **spec-compliance-reviewer flagged a discrepancy with the spec or schemas/, but it is unclear which is correct** — do not adopt either on your own; present the contradiction as-is to the user (`~/.claude/rules/investigate-before-asking.md`).
- **finding-validator keeps returning `unsure`** — the tools needed for verification (specific OS-dependent behavior, access to an external service, etc.) are likely absent in this environment. Report it as `unsure`, and note which tools/environment would be needed to verify it.

## Usage examples

Invocation: "self-review this", "/iroha-review", "review the changes on this branch".

Skeleton of a typical output:

```text
Scope: committed changes since the merge-base with main (2 uncommitted changes: asked whether to include → chose not to)
diff: 8 files changed, +640/-12 → new logic in one package, no security-sensitive path: all three reviewers, no security-diff-reviewer

Step 2 deterministic checks: lint OK / typecheck OK / test OK (83 passed) / build OK / secret patterns: none detected

[ReportFindings: 1 finding (HIGH, verdict: CONFIRMED), or an empty array]

Duplicates collapsed: 2 (both reviewers raised the same unchecked boundary — corroborated, counted once)
Not covered: Windows-specific newline/path behavior was not verified in this environment (macOS).

PR comment draft: /path/to/repo/.git/iroha-review-draft.md (post it after `gh pr create`)
This skill made no commit and no push.
```
