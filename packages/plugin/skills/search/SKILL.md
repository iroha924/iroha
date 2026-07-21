---
name: search
description: Search approved iroha engineering memory — decisions, rules, incidents, patterns, and session summaries — across Japanese, English, and code. Use when the user asks what iroha knows, why a past decision was made, or which rules apply here. Do not use for general web search or for searching source files directly.
---

# Search iroha memory

Query the approved engineering memory graph:

```bash
iroha search "why do we use the repository pattern"
```

Add `--json` for structured output when you need to parse the results:

```bash
iroha search "session token expiry" --json
```

Search works offline with lexical (FTS) ranking; when embeddings are configured it also uses vector recall. Only human-approved knowledge is returned — pending candidates are excluded.
