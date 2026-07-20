## Summary

<!-- The goal of this PR in one sentence. If you can't say it in one sentence, or unrelated changes touch more than ~5 files, consider splitting. -->

## What changed

<!-- Scope and the main changes (what and why). Don't fold in unrequested "while I was here" edits. -->

## How verified

<!--
Paste the commands you ran and their output — evidence, not a self-attested checkbox.
CLAUDE.md: record any skipped verification with the command and the reason. Where possible,
include a reproduction test that is red before the fix.
-->

```
$ pnpm lint && pnpm typecheck && pnpm test && pnpm build
(paste results)
```

When affected, also run and paste `pnpm test:contracts` / `test:integration` / `test:e2e` / `test:package`.

## Links

- Related issue:
- Spec / ADR (a `docs/product/...` path, a `decision-log.md` ID):

## Risks and rollback

<!-- Unresolved risks, follow-ups, how to revert. -->

## Checklist (only things CI can't verify)

- [ ] Self-reviewed (a human read the AI-authored changes)
- [ ] Prose and machine contracts stay in sync (`schemas/*.json` / `packages/domain/src/schemas/*.ts` / `migrations/*.sql`)
- [ ] If a security-sensitive package was touched (credential / subprocess / path handling), ran an adversarial review via `security-diff-reviewer`
- [ ] No secrets or local absolute paths in the diff

<!-- PR title follows Conventional Commits (feat: / fix: / docs: / refactor: / test: / chore: / ci: / perf: / build:). -->
