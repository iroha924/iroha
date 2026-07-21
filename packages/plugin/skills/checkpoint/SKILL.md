---
name: checkpoint
description: Save a structured Checkpoint of the current work as a local iroha candidate for later human approval. Use after a meaningful unit of work — a decision reached, a bug fixed, a reusable rule or pattern discovered. Do not use for trivial edits, and never treat a Checkpoint as approved knowledge (a human approves candidates in the dashboard).
---

# Save an iroha Checkpoint

Do NOT run a CLI command for this. Call the iroha MCP tool **`create_checkpoint`** exposed by the `iroha` MCP server. Provide:

- **intent** — what this unit of work was trying to achieve;
- **changes** — what actually changed (files, behavior);
- **decisions** — choices made and why, with alternatives considered;
- **unresolved** — open questions or follow-ups;
- **proposals** — reusable knowledge (decisions, rules, patterns) worth keeping.

A Checkpoint becomes a **local, pending candidate** — it is never authoritative and is excluded from retrieval until a human approves it in the iroha dashboard. Do not write raw prompts, transcripts, secrets, or credentials into a Checkpoint.
