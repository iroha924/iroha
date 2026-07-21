---
name: init
description: Initialize iroha in the current Git repository so agents share approved engineering memory. Use when the user asks to set up, install, or initialize iroha in a repo. Do not use for unrelated project scaffolding or for repositories that are already initialized (rerunning is safe but unnecessary).
---

# Initialize iroha

Run the iroha CLI to create the local index and shared `.iroha/` layout:

```bash
iroha init
```

`iroha init` is non-destructive and idempotent — rerunning it produces no changes. Add `--scan` to import `CLAUDE.md`, `AGENTS.md`, and `.claude/rules/**/*.md` as local candidates for later human review (it never copies them into `.iroha/`):

```bash
iroha init --scan
```

The git-tracked `.iroha/` directory is the team-shared source of truth; the local database is a rebuildable index. After init, commit `.iroha/` so teammates share it.
