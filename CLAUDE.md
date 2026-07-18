# iroha implementation instructions

You are implementing **iroha**, a local-first Engineering Memory Graph for Claude Code and Codex.

## Read first

Resolve `<spec-root>` first:

- in this handoff bundle: the directory containing this `CLAUDE.md`;
- after WP-00 repository setup: `docs/product`.

Before changing code, read these files under `<spec-root>` in order:

1. `background.md`
2. `research.md`
3. `requirements.md`
4. `design.md`
5. `implementation/compatibility.md`
6. `implementation/canonical-schema.md`
7. `implementation/database-schema.md`
8. `implementation/mcp-contract.md`
9. `implementation/hooks-contract.md`
10. `implementation/dashboard-api.md`
11. `implementation/vertical-slice.md`
12. `implementation/decision-log.md`
13. `implementation/implementation-plan.md`

Machine-readable contracts live under `<spec-root>/schemas/` and `<spec-root>/migrations/`. When prose and a machine-readable contract disagree, stop and report the conflict. Do not silently choose one.

## Product invariants

- Product, plugin, MCP server, and CLI name: `iroha`.
- Publisher: `iroha labs`; npm package: `@iroha-labs/iroha`.
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

- Work in the order defined by `<spec-root>/implementation/implementation-plan.md`.
- Complete one work package and its tests before starting the next.
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

## Decision rule

If a specification leaves a detail open:

1. prefer an existing invariant or accepted ADR;
2. prefer a reversible implementation behind a port;
3. record the assumption in `implementation/decision-log.md`;
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
(`packages/git` and similar) have dedicated, always-loaded rules:

- `.claude/rules/typescript-conventions.md` — module resolution, `Result<T,E>` error handling, Zod 4 patterns, test/build conventions.
- `.claude/rules/secure-subprocess-and-credentials.md` — env var allowlisting, never putting raw values in errors, locale-independent stderr parsing.
- `.claude/rules/path-and-symlink-safety.md` — the `..`-before-symlink-resolution invariant and how to avoid re-breaking it.

Before pushing a fix to one of these packages, run the `self-review` skill
(`.claude/skills/self-review/`) — it exists specifically to catch a narrow fix that leaves the
same defect at a sibling call site, or that trades one false-negative for another. It calls the
`security-diff-reviewer` subagent for an independent, fresh-context adversarial pass. A
`PreToolUse` hook on `git push` (`.claude/hooks/check-path-safety-diff.sh`) also flags any newly
added `path.resolve`/`path.join`/`path.normalize` call in `*paths*.ts`/`*credential*.ts` files for
manual approval — this is a deterministic backstop, not a substitute for the self-review pass.
