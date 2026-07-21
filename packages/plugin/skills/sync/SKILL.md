---
name: sync
description: Rebuild the local iroha index from the Git-tracked .iroha/ canonical files. Use when the user asks to sync, refresh, or rebuild iroha memory — typically after pulling teammate changes or resolving a merge. Do not use for unrelated file synchronization or version control operations.
---

# Sync iroha memory

Import changed canonical files into the local index:

```bash
iroha sync
```

For a full, deterministic rebuild from `.iroha/` and Git (for example after a conflicting pull or a corrupted index):

```bash
iroha sync --rebuild
```

The local database is disposable — a rebuild reconstructs the same approved entity graph from the canonical files, so it never loses approved knowledge.
