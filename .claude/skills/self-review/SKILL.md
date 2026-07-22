---
name: self-review
description: Runs a structured self-review before pushing changes to security-sensitive TypeScript code in this monorepo (packages/git and similar packages doing subprocess execution, credential/secret handling, or path/symlink validation). Catches regressions where a narrow fix for one reported bug leaves the same defect class at a sibling call site, silently trades one false-negative for another, violates an invariant the code itself just declared in the same sitting, or drops platform-specific behavior when replacing an OS-native function with hand-rolled logic. Use before every `git push` touching these packages, not only after a review-bot finding. Do not use for general bug fixes outside packages/git, packages/forge*, packages/adapter-* — those aren't in this project's security-sensitive scope.
paths:
  - "packages/git/src/**/*.ts"
  - "packages/forge*/src/**/*.ts"
  - "packages/adapter-*/src/**/*.ts"
user-invocable: true
allowed-tools: Bash(grep *) Bash(pnpm lint) Bash(pnpm typecheck) Bash(pnpm test) Bash(pnpm build) Agent(security-diff-reviewer)
---

# Self-review before push

This skill exists to prevent "fix the one reported issue and be done". That iterative fixes can worsen security is pointed out even in empirical research ([Security Degradation in Iterative AI Code Generation](https://arxiv.org/pdf/2506.11022), arXiv 2506.11022). The causes are mainly (a) local optimization (fixing one issue creates a new weakness somewhere else) and (b) a lack of exhaustive threat modeling. Treat each fix not as "an act that reduces risk" but as "an act that may create new risk".

Run the following steps **only the ones that apply to what you changed**, right before pushing. Not all steps are always necessary.

## Step 1 — Write the nature of the change in one sentence

State in one sentence "what" you fixed and "why". It becomes the basis for judging the next steps.
Example: "Added a comma to the delimiters of `redactUrlLikeCredentials`, fixing an issue where two adjacent URLs were treated as a single match".

## Step 2 — Ask "what does this newly let through?"

When you change a pattern match / regex / exclusion set, **confirming only the false negative you fixed is not enough**. Come up with, on your own, and test at least 2-3 **new** false negatives that the same change produces.

- Added an exclusion character → did you write and confirm a case where that character appears not as a "delimiter" but as "part of a legitimate value"?
- Loosened / tightened a condition → did you test at least one input in the opposite direction (if you loosened it, an input you do not want to let through; if you tightened it, an input you do want to let through)?

This is not the work of "verifying the fix" but of actively hunting for "what the fix sacrificed".

## Step 3 — Cross-check every call site of the same helper/primitive

When you fix one spot, check the other uses of the same helper **not just in that file but across the whole package** ("local optimization" is the main cause of a global weakness).

```bash
# List every call site of the changed function/regex/helper
grep -rn "<changed-function-name>(" src/*.ts | grep -v "\.test\.ts"
```

When a "strict version" and a "lenient version" of a function coexist, always confirm **whether all external call sites use the strict version**.

## Step 4 — Cross-check for violations of an invariant you wrote yourself

If you wrote in a docstring/comment "never use X, because Y", always grep to confirm that you are not using X **within the same commit** in another branch of the same file or the same function.

```bash
# Example: in a file that declared "path.resolve/path.join collapse .. so do not use them"
grep -n "resolve(\|\.join(\|path\.join\|path\.resolve" <changed-file>
```

Violating an invariant right after writing it is the most basic and most easily overlooked pattern. **Another branch of the same function** is especially easy to miss.

## Step 5 — When you replace an OS-native function with your own implementation, explicitly enumerate the platform differences

When you replace an OS-native function such as `fs.realpath` with hand-written logic (or partially bypass it), explicitly enumerate the behaviors that native function may have handled implicitly, and decide for each one whether you "preserved it" or "intentionally left it out of scope".

Starting point for the checklist (details in `.claude/rules/path-and-symlink-safety.md`):
- Case handling (Windows does not distinguish the case of environment variable names or paths)
- Short-name / alias forms (Windows 8.3 form)
- Locale-dependent output (messages translated by gettext, etc.)
- Normalization of newlines, whitespace, and encoding

For behaviors you cannot reproduce in your local environment (Windows short names, NLS translation, etc.), **record the inability to reproduce as a risk in its own right**, and if the platform in question is included in the CI matrix, wait for the results of real-machine CI. Do not use "cannot be reproduced locally" as grounds for "no problem".

## Step 6 — First ask "can it be removed?" (allowlist over denylist)

When you find an issue where sensitive information leaks into an error/log, **first consider "can you stop including the value itself?"**. Redaction by regex is inherently a denylist (detecting known bad patterns) and has the structural limitation of being "trivially bypassable", as the [OWASP Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html) explicitly states. Details in `.claude/rules/secure-subprocess-and-credentials.md`.

Order of judgment:
1. Is that value (the raw argument value, the absolute form of a path, etc.) really needed in the error? → if not, **do not include it**
2. If it must be included (essential for debugging), adopt a redaction strategy that detects and removes known shapes
3. If you adopt a redaction strategy, be aware that it does not in principle close the leak channel, and state its limitations explicitly in a comment

When the thought "just add one more pattern and it will be fixed" comes up for the third time, that is a sign you should doubt the strategy itself.

## Step 7 — Adversarial review from an independent perspective

A review by yourself (in the same conversation context that invoked this skill) is subject to confirmation bias. Have the fresh-context `security-diff-reviewer` subagent (`.claude/agents/security-diff-reviewer.md`) review it independently by passing it the current contents of the changed files.

## Step 8 — Whole-repository verification gate

Always run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before you push. Run it across the whole repository, not just the individual package.

## Step 9 — Record the assumptions

If there are items you "intentionally left out of scope" in Steps 2-5, state them explicitly in the commit message or in an in-code comment. This is so you do not repeat the same discussion in the next review round.

## Troubleshooting

- **The Step 8 verification (lint/typecheck/test/build) fails**: do not proceed with the push. Read the output of the failed command, fix the root cause, and redo Step 8. Do not distort production code just to make tests pass (`~/.claude/rules/testing.md`).
- **The Step 7 `security-diff-reviewer` call returns with zero findings**: because you cannot distinguish "no problems" from "the review whiffed", confirm that the file contents you passed are actually the latest post-change version. Also check that you did not narrow the changed files too far and forget to pass a related caller file.
