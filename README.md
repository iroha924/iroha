<p align="center">
  <img src="apps/dashboard/public/iroha-lockup-horizontal.svg" alt="iroha" width="320">
</p>

<p align="center">
  English | <a href="./README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/iroha924/iroha/actions/workflows/ci.yml"><img src="https://github.com/iroha924/iroha/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24%20%3C25-6E7B57" alt="Node >=24 <25">
  <img src="https://img.shields.io/badge/license-Apache--2.0-6F675A" alt="License Apache-2.0">
</p>

**iroha** is a local-first Engineering Memory Graph for Claude Code and Codex. It turns the decisions, rules, and hard-won lessons from your agent sessions into a searchable, git-tracked knowledge base your whole team shares — and nothing is written to it until a human approves it.

Every approved item keeps its provenance: the session, pull request, commit, or review it came from. Your agents can then search that memory over MCP, so the next session starts already knowing why the code is the way it is.

## Why iroha

- **Your agents stop forgetting.** Decisions and conventions captured in one session are available — with sources — in the next, across Claude Code *and* Codex.
- **A human is always in the loop.** Agents propose *candidate* knowledge; you approve what's worth keeping. Approved knowledge becomes canonical Markdown under `.iroha/`, committed to git and shared with your team.
- **Local-first, private by default.** No cloud account, no telemetry, no data leaves your machine. Raw prompts and transcripts are never written to your knowledge base. The one optional network call is embeddings, which you enable with your own key.
- **Search that works with zero config.** Full-text and graph search run out of the box (including Japanese and other CJK text). Add an embedding key for semantic search; without one, iroha degrades to lexical search rather than failing.

iroha is **not** a surveillance or productivity-ranking tool, and it has no hosted backend. It is a memory graph you own.

## Requirements

- **Node.js** `>=24 <25`
- **Git** — iroha operates on a Git repository
- **Claude Code** `>=2.1.198` and/or **Codex** `>=0.144.5` (either or both)

## Install

iroha ships as one npm package, `@iroha-labs/iroha`, which provides the `iroha` binary. That binary is the runtime for everything — the CLI, the lifecycle hooks, and the MCP server — so installing it is the one required step.

```bash
npm install -g @iroha-labs/iroha
```

Then, in any Git repository:

```bash
iroha init      # create .iroha/ and the local index (safe to rerun; commit the result)
iroha doctor    # check Node, Git, detected agents, and database capabilities
```

The `iroha` CLI (`init | sync | search | dashboard | doctor`) is fully functional on its own — the plugins below add editor integration on top of it.

## Set up your agent

The plugin registers iroha's skills, lifecycle hooks, and MCP server with your agent. Both plugins call the globally installed `iroha` binary, so keep the step above done first.

### Claude Code

```text
/plugin marketplace add iroha924/iroha
/plugin install iroha@iroha
```

Skills are then available as `/iroha:init`, `/iroha:sync`, `/iroha:search`, `/iroha:checkpoint`, `/iroha:dashboard`, and `/iroha:doctor`.

### OpenAI Codex

```bash
codex plugin marketplace add iroha924/iroha
```

Install the `iroha` plugin from that marketplace with your Codex version's plugin flow (`/plugins` in the Codex CLI). Codex does **not** trust plugin hooks until you review them explicitly — run `/hooks` and trust them. Until then the MCP server and CLI still work; Codex skills are invoked as `$init`, `$sync`, and so on.

Full install, update, and uninstall details — including the Codex hook-trust flow — live in [docs/install.md](./docs/install.md).

## Quick start

Once a plugin is set up, the loop is: work as usual, then curate.

```bash
# 1. Work with your agent. iroha's hooks observe the session and, when something
#    worth remembering emerges (a decision, a rule, a lesson), your agent
#    proposes it as a candidate through the MCP server.

# 2. Review and approve candidates in the local dashboard:
iroha dashboard
#    → opens http://127.0.0.1:<port>/#token=… ; approve what's worth keeping.

# 3. Approved knowledge is now canonical Markdown under .iroha/ — commit it:
git add .iroha && git commit -m "chore: approve knowledge"

# 4. Search your memory any time (agents do this over MCP; you can from the CLI):
iroha search "why do we use the repository pattern"
```

A teammate who clones the repo runs `iroha init` then `iroha sync --rebuild` to rebuild their local index from the committed `.iroha/`.

## The approval dashboard

`iroha dashboard` serves a local, single-origin app from one loopback port and hands your browser a one-time launch token. It is where you review candidate knowledge, see each item's provenance and relationships, and approve or reject it. Approval is a human action — it lives only in the dashboard and the CLI, never in an agent's reach. The dashboard binds to loopback only; nothing is exposed off your machine.

## Configuration

`iroha init` writes `.iroha/config.yaml`. It records **environment-variable names**, never secret values — the values are read from your environment at runtime and are never stored, logged, or committed.

| Environment variable | Purpose | Required | Without it |
|---|---|---|---|
| `VOYAGE_API_KEY` | Semantic (vector) search embeddings via Voyage | No | Search degrades to full-text + graph only |
| `GITHUB_TOKEN` | GitHub forge sync (pull requests, reviews) | No | Forge sync is simply off |

Key `config.yaml` settings:

- `default_language` — `en` (default) or `ja`; the dashboard's startup locale.
- `canonical.require_human_approval` — keep `true` so nothing becomes authoritative without review.
- `privacy.*` — whether prompt/transcript content may ever reach canonical files (off by default).

## How it works

1. **Adapters normalize both agents.** Claude Code and Codex sessions become the same domain events, so one memory graph serves both.
2. **Knowledge is captured during work,** through a Turn/Checkpoint lifecycle rather than a single session-end summary (Codex has no session-end hook).
3. **Candidates carry provenance.** Each proposed decision, rule, or insight links back to its source and to related items.
4. **A human approves.** Approved knowledge is written to canonical Markdown under `.iroha/` and committed — the team-shared source of truth.
5. **A local libSQL index makes it searchable** (lexical always; semantic when a key is set). The index is disposable and rebuildable from `.iroha/` at any time — it is never the sole source of approved knowledge.

## FAQ

**Does anything leave my machine?** No. iroha is local-first with no cloud account and no telemetry. The only optional outbound call is Voyage embeddings, which you turn on with your own `VOYAGE_API_KEY`.

**I don't have an embedding key.** Search still works. Full-text and graph search run with zero configuration, including Japanese and other CJK queries; semantic search is an opt-in enhancement.

**How is my knowledge stored?** As plain, git-tracked Markdown under `.iroha/`. You can read, diff, and review it like any other source. The libSQL index under `.git/iroha/` is a disposable cache.

**Rebuild the index?** `iroha sync --rebuild`. On a fresh clone, run `iroha init` first.

**What does the name mean?** *iroha* (いろは) is the opening of a classic Japanese poem that uses each kana once — it has come to mean "the ABCs," the fundamentals.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development setup and workflow. The full product specification lives in [docs/product/](./docs/product/).

## Security

Hook enforcement is a guardrail, not a complete security boundary — hard enforcement belongs in CI. To report a vulnerability, please open a [security advisory](https://github.com/iroha924/iroha/security/advisories/new) rather than a public issue.

## License

[Apache-2.0](./LICENSE) © iroha labs
