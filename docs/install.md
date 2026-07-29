# Install, update, and uninstall iroha

iroha ships as one npm package, `@irohalabs/iroha`, which provides the `iroha`
binary. That binary is the runtime for everything — the CLI you run directly, the
lifecycle hooks, and the MCP server — so installing it is the one required step on
both Claude Code and Codex. The Claude and Codex plugins add editor integration
(skills, hooks, MCP wiring) on top of that binary.

## Requirements

- Node.js `>=24 <25`
- Claude Code `>=2.1.198`, and/or Codex `>=0.144.5`
- Git (iroha operates on a Git repository)

## 1. Install the CLI (required)

```bash
npm install -g @irohalabs/iroha
```

This puts `iroha` on your `PATH`. Verify:

```bash
iroha doctor
```

`iroha doctor` checks Node/Git, the detected agent platforms, database
capabilities, and — once a plugin is installed — the plugin manifests and hook
trust. It never prints secret values.

Initialize iroha in a repository (safe to rerun; commit the resulting `.iroha/`):

```bash
cd your-repo
iroha init
```

The `iroha` CLI alone (`iroha init | sync | search | dashboard | doctor |
credentials`) is fully functional without any plugin, and is the reliable
cross-platform path.

Semantic search and GitHub sync each need a key, registered from the dashboard's
Settings page or with `pbpaste | iroha credentials voyage`. Keys are stored per
machine in `~/.config/iroha/credentials.json`, not per repository — see the
Configuration section of the README.

## 2. Add the Claude Code plugin (optional)

```text
/plugin marketplace add iroha924/iroha
/plugin install iroha@iroha
```

Then invoke skills as `/iroha:<skill>`:

- `/iroha:init`, `/iroha:sync`, `/iroha:search`, `/iroha:checkpoint`,
  `/iroha:dashboard`, `/iroha:doctor`

The plugin's hooks and MCP server run `iroha __hook <platform>` / `iroha __mcp`,
so the globally installed `iroha` binary from step 1 must be present.

## 3. Add the Codex plugin (optional)

```bash
codex plugin marketplace add iroha924/iroha
```

Then install the `iroha` plugin from that marketplace using your Codex version's
plugin flow (`/plugins` in the Codex CLI).

Codex does **not** trust plugin hooks on install or enable. Review and trust them
explicitly:

```text
/hooks
```

Until the hooks are trusted, they will not run — but the MCP server and the
`iroha` CLI still work. Codex skills are invoked as `$<skill>` (for example
`$init`); the plugin namespace form is not guaranteed across Codex versions, so
if a skill is not found, use the CLI directly (`iroha init`, `iroha sync`, …),
which always works.

## Update

```bash
npm update -g @irohalabs/iroha
```

Then refresh the plugin metadata:

- Claude Code: `/plugin marketplace update iroha`, then `/plugin update iroha@iroha`
- Codex: `codex plugin marketplace update iroha` (re-trust via `/hooks` if the
  hook definitions changed — trust is recorded against the hook's exact contents)

## Uninstall

Remove the plugin first, then the marketplace, then the CLI:

- Claude Code: `/plugin uninstall iroha@iroha`, then `/plugin marketplace remove iroha`
- Codex: uninstall the plugin via `/plugins`, then
  `codex plugin marketplace remove iroha`

```bash
npm uninstall -g @irohalabs/iroha
```

Uninstalling does not touch a repository's Git-tracked `.iroha/` directory (your
approved knowledge) or delete anything from Git. The local index under
`.git/iroha/` is a disposable cache; remove it manually if you want it gone.

It also leaves any API keys you registered, because they are machine-scoped
rather than part of the package. To remove them:

```bash
rm -rf ~/.config/iroha
```
