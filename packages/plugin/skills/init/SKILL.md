---
name: init
description: Initialize iroha in the current Git repository so agents share approved engineering memory. Use when the user asks to set up, install, or initialize iroha in a repo. Do not use for unrelated project scaffolding or for repositories that are already initialized (rerunning is safe but unnecessary).
---

# Initialize iroha

Run the iroha CLI to create the local index and shared `.iroha/` layout:

```bash
iroha init
```

`iroha init` is non-destructive and idempotent — rerunning it produces no changes.

It also imports `CLAUDE.md`, `AGENTS.md`, and `.claude/rules/**/*.md` into the local index as knowledge at status `imported`. These need no review: they are already committed to the repository. They are not copied into `.iroha/` — the source file stays authoritative, and `iroha sync` re-reads it when it changes.

The git-tracked `.iroha/` directory is the team-shared source of truth; the local database is a rebuildable index. After init, commit `.iroha/` so teammates share it.
