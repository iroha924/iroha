# iroha implementation instructions

**iroha** is a local-first Engineering Memory Graph for Claude Code and Codex. It ships as
`@irohalabs/iroha` on npm; every work package is implemented.

## Where the contracts are

Read the one that governs what you are touching — not all of them.

| Touching | Read |
|---|---|
| Anything (overall shape, package boundaries, data flow, the ADR table) | `docs/architecture.md` |
| Runtime, versions, OS support, which package may depend on which | `docs/contracts/compatibility.md` |
| `.iroha/` file format, the approval transaction | `docs/contracts/canonical.md` |
| DB schema, search, rebuild | `docs/contracts/database.md` |
| An MCP tool | `docs/contracts/mcp.md` |
| A Hook | `docs/contracts/hooks.md` |
| The dashboard or its API | `docs/contracts/dashboard-api.md` |

Machine-readable contracts live at the repository root: `schemas/` and `migrations/`. When prose and
a machine-readable contract disagree, stop and report the conflict. Do not silently choose one.

## Product invariants

- Product, plugin, MCP server, and CLI name: `iroha`.
- Publisher: `iroha labs`; npm package: `@irohalabs/iroha`.
- TypeScript and Node.js `>=24 <25` only.
- Git-tracked `.iroha/` is the team-shared canonical source.
- libSQL is a local, disposable, rebuildable index. It is never the sole source of approved knowledge.
- Candidate knowledge is not authoritative until a human approves it.
- Raw prompts and transcripts are not written to canonical files.
- Claude Code and Codex adapters normalize into the same domain events.
- Session-end-only summarization is forbidden. Use Turn/Checkpoint lifecycle.
- Advisory rules and machine-enforceable Guardrails are different types.
- Hook enforcement is a guardrail, not a complete security boundary.
- No individual productivity ranking or surveillance feature.
- No cloud account, Supabase, or realtime synchronization in v0.1.

## Implementation behavior

- Use pnpm workspace dependencies with `workspace:*`.
- Keep domain code independent from platform SDK types and filesystem/database implementations.
- Validate every external boundary with Zod.
- Use parameterized SQL only.
- Do not parse agent transcripts in core code.
- Do not add an ORM or Graph DB.
- Do not add a daemon, hosted backend, telemetry upload, or external LLM call without a new ADR.
- Embedding failure must degrade to lexical search.
- Forge failure must not fail canonical sync.
- Hook internal failure is fail-open unless an approved Guardrail explicitly denies the action.
- Never log credentials, raw prompt content, full tool input/output, or model reasoning.

## Required verification for every change

Run the smallest relevant subset during development, then before completing a work package run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

When affected, also run:

```bash
pnpm test:contracts
pnpm test:integration
pnpm test:e2e
pnpm test:package
```

Do not claim a command passed unless it was executed. Record skipped verification and the reason in the final response and in the Checkpoint fixture when applicable.

Immediately after `gh pr create`, post the development self-review as a PR comment — a posted
self-review is evidence, a checkbox is not:

```bash
bash .claude/skills/iroha-review/post-summary.sh
```

That script is the only place the posting rules live, so the two do not drift. It exits quietly when
`/iroha-review` left no draft (the review is optional — no draft means no comment, never an empty
placeholder), refuses when the draft is not current with `HEAD` rather than attaching a summary that
misdescribes the diff, and identifies the existing comment by its hidden
`<!-- iroha-review-summary -->` marker so a later run updates it in place, and deletes the draft once
the post succeeds so nothing accumulates in `.git/`. Do not reach for `gh pr comment --edit-last`
instead: it targets your *last* comment, which after a `@codex review` or a triage reply is not the
summary. Format: `.claude/skills/iroha-review/pr-comment-template.md`.

After pushing to a pull request, a green `gh pr checks` is not the whole verdict: the Codex reviewer
appears in no status check at all. Run the `pr-review-status` skill before reporting the work as
done — it also decides whether a re-review is worth its rate limit, and how to reply without
accidentally opening a cloud chat.

## Decision rule

If a specification leaves a detail open:

1. prefer an existing invariant or accepted ADR;
2. prefer a reversible implementation behind a port;
3. record the assumption where it takes effect — a comment at the code or config that embodies it,
   or the relevant `.claude/rules/` file when it is a convention rather than one site;
4. stop for human input only if the choice changes canonical data, security/privacy, public API, or distribution compatibility.

Do not change an accepted ADR merely to simplify the current task.

## Definition of done

A work package is complete only when:

- acceptance tests from the implementation plan pass;
- generated or machine-readable contracts are synchronized with prose;
- migrations are forward-only and rebuild tests pass;
- no secrets or local absolute paths appear in fixtures or artifacts;
- affected documentation is updated;
- the change can be explained by files changed, behavior, verification, and unresolved risks.

## Security-sensitive package conventions

Packages doing subprocess execution, credential/secret handling, or path/symlink validation
(`packages/git` and similar) have dedicated rules:

- `.claude/rules/typescript-conventions.md` — module resolution, `Result<T,E>` error handling, Zod 4 patterns, test/build conventions.
- `.claude/rules/secure-subprocess-and-credentials.md` — env var allowlisting, never putting raw values in errors, locale-independent stderr parsing.
- `.claude/rules/path-and-symlink-safety.md` — the `..`-before-symlink-resolution invariant and how to avoid re-breaking it.

All three are path-scoped to the source they govern and auto-load when you open a matching file, so
there is nothing to invoke. Every rule under `.claude/rules/` works this way except the few that must
apply before any file is open — they carry no `paths` and are always loaded.

To review a change, run the `iroha-review` skill (`.claude/skills/iroha-review/`) — the repository's
single review pipeline. It runs the deterministic gate, then launches fresh-context reviewers in
parallel, scaled to what the diff touches, and adds the `security-diff-reviewer` subagent when the
diff reaches `packages/git`, `packages/forge*`, or `packages/adapter-*` — the pass that catches a
narrow fix leaving the same defect at a sibling call site, or trading one false-negative for
another. Run it before pushing a fix to one of these packages. A `PreToolUse` hook on `git push`
(`.claude/hooks/check-path-safety-diff.sh`) also flags any newly added
`path.resolve`/`path.join`/`path.normalize` call in `*paths*.ts`/`*credential*.ts` files for manual
approval — this is a deterministic backstop, not a substitute for the review pass.
