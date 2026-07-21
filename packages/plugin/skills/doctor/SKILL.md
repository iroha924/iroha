---
name: doctor
description: Diagnose the iroha installation — platform integration, hook trust, MCP connectivity, database capabilities, and Git access. Use when iroha behaves unexpectedly, a hook or the MCP server seems inactive, or the user asks to check or verify the iroha setup. Do not use for unrelated environment diagnostics.
---

# Diagnose iroha

Run the diagnostic checks:

```bash
iroha doctor
```

Add `--json` for machine-readable output:

```bash
iroha doctor --json
```

`iroha doctor` reports each check as `ok`, `warning`, `error`, or `blocked` and never prints secret values. On Codex, remember that installing or enabling the plugin does not trust its hooks — if hooks are untrusted, review and trust them with the `/hooks` command in the Codex CLI.
