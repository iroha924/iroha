<p align="center">
  <img src="apps/dashboard/public/iroha-lockup-horizontal.svg" alt="iroha" width="320">
</p>

<p align="center">
  English | <a href="./README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/iroha924/iroha/actions/workflows/ci.yml"><img src="https://github.com/iroha924/iroha/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@irohalabs/iroha"><img src="https://img.shields.io/npm/v/@irohalabs/iroha?color=6E7B57&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24%20%3C25-6E7B57" alt="Node >=24 <25">
  <img src="https://img.shields.io/badge/license-Apache--2.0-6F675A" alt="License Apache-2.0">
</p>

**iroha** is a local-first Engineering Memory Graph for Claude Code and Codex. It takes the decisions, rules, and hard-won lessons from your agent sessions and turns them into a searchable, git-tracked knowledge base your whole team shares — and nothing gets written to it until a human says yes.

AI is astonishingly smart, yet forgets everything the two of you decided the moment the session ends. iroha fixes that amnesia. Every approved item keeps its provenance — the session, pull request, commit, or review it came from — so your agent can search that memory over MCP and start the next session already knowing *why* the code is the way it is.

## Why iroha

- **Your agents stop forgetting.** A decision or convention captured in one session shows up — with sources — in the next, across Claude Code *and* Codex.
- **A human always has the last word.** Agents propose *candidate* knowledge; you approve what's worth keeping. No agent quietly writing "this seems important!" into your knowledge base behind your back. Only approved items become canonical Markdown under `.iroha/`, committed to git and shared with your team.
- **Local-first, private by default.** No cloud account, no telemetry, no server somewhere. Raw prompts and transcripts never touch your knowledge base. The only things that reach the network are two features *you* opt into: embedding generation (Voyage) and GitHub forge sync — and neither moves a byte until you turn it on with your own key.
- **Search works with zero config.** Full-text and graph search run out of the box (Japanese and other CJK text included!). Enable semantic search in your config and add an embedding key and you get that too; without them, iroha quietly stays on lexical search instead of falling over.

And to be clear: iroha is not a surveillance or productivity-ranking tool, and there's no hosted backend. It's a memory graph *you* own.

## Requirements

- **Node.js** `>=24 <25`
- **Git** — iroha works on a Git repository
- **Claude Code** `>=2.1.198` and/or **Codex** `>=0.144.5` (either or both)

## Install

iroha ships as one npm package, `@irohalabs/iroha`, which provides the `iroha` binary. That binary *is* everything — the CLI, the lifecycle hooks, and the MCP server — so installing it is the one step you can't skip.

```bash
npm install -g @irohalabs/iroha
```

Then, in any Git repository:

```bash
iroha init      # create .iroha/ and the local index (rerun any time; commit the result)
iroha doctor    # check Node, Git, detected agents, and database capabilities
```

The `iroha` CLI (`init | sync | search | dashboard | doctor`) works entirely on its own — the plugins below just add editor integration on top.

## Set up your agent

The plugin registers iroha's skills, lifecycle hooks, and MCP server with your agent. Both plugins call the globally installed `iroha` binary, so do the step above first.

### Claude Code

```text
/plugin marketplace add iroha924/iroha
/plugin install iroha@iroha
```

Skills then show up as `/iroha:init`, `/iroha:sync`, `/iroha:search`, `/iroha:checkpoint`, `/iroha:dashboard`, and `/iroha:doctor`.

### OpenAI Codex

```bash
codex plugin marketplace add iroha924/iroha
```

Install the `iroha` plugin from that marketplace with your Codex version's plugin flow (`/plugins` in the Codex CLI). Codex won't trust plugin hooks until you say so — run `/hooks` and trust them. Until you do, the MCP server and CLI still work fine; Codex skills are invoked as `$init`, `$sync`, and so on.

Full install, update, and uninstall details — including the Codex hook-trust flow — live in [docs/install.md](./docs/install.md).

## Quick start

Once a plugin is set up, the whole loop is: work as usual, then curate.

```bash
# 1. Work with your agent as usual. iroha's hooks watch the session, and when
#    something worth remembering shows up (a decision, a rule, a lesson), your
#    agent proposes it as a candidate through the MCP server.

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

`iroha dashboard` serves a local, single-origin app from one loopback port and hands your browser a one-time launch token. It's where you review candidate knowledge, see each item's provenance and relationships, and approve or reject it. The dashboard is the *only* place approval happens — it's a human's call, never an agent's. It binds to loopback only, so nothing is exposed off your machine.

## Configuration

The two features that reach the network are **off by default**, and turning one on takes two steps: put the key in your environment, then flip the flag in `.iroha/config.yaml`.

**1. Set the key in your shell** (e.g. in `~/.zshrc` or `~/.bashrc`):

```bash
export VOYAGE_API_KEY="your-voyage-key"   # for semantic search
export GITHUB_TOKEN="your-github-token"   # for GitHub sync
```

**2. Turn the feature on in `.iroha/config.yaml`** — `iroha init` already created this file, so you're just flipping a flag:

```yaml
search:
  embedding:
    enabled: true    # semantic search — reads VOYAGE_API_KEY
forge:
  enabled: true      # GitHub sync — reads GITHUB_TOKEN
```

`config.yaml` only ever records the **name** of an environment variable, never the secret value itself — the value is read from your environment at runtime and is never stored, logged, or committed.

| Environment variable | Turns on | Without it |
|---|---|---|
| `VOYAGE_API_KEY` | Semantic (vector) search via Voyage | Search stays full-text + graph only |
| `GITHUB_TOKEN` | GitHub sync (pull requests, reviews) | GitHub sync is simply off |

**Where the keys come from — and what they cost:**

- **`VOYAGE_API_KEY`** — sign up at [voyageai.com](https://www.voyageai.com/) and create a key. The cost is next to nothing: iroha uses `voyage-4-large` at **$0.12 per million tokens**, and every account gets its **first 200 million tokens free** ([Voyage pricing](https://docs.voyageai.com/docs/pricing)). A whole team's knowledge base is a few million tokens at most, so in practice you never leave the free tier — and even past it, embedding ~10,000 notes of ~500 tokens each (5M tokens) costs about **$0.60**.
- **`GITHUB_TOKEN`** — create a [personal access token](https://github.com/settings/tokens) with read access to the repo: a classic token with the `repo` scope, or a fine-grained token granting **Contents: Read** and **Pull requests: Read**. Then point `GITHUB_TOKEN` at it.

Two other settings worth knowing:

- `default_language` — `en` (default) or `ja`; the language the dashboard opens in.
- `canonical.require_human_approval` — keep it `true` so nothing joins your knowledge base without a human approving it first.

## How it works

1. **Adapters normalize both agents.** Claude Code and Codex sessions become the same domain events, so one memory graph serves both.
2. **Knowledge is captured *during* work,** through a Turn/Checkpoint lifecycle rather than one session-end summary (Codex has no session-end hook, for one).
3. **Candidates carry provenance.** Each proposed decision, rule, or insight links back to its source and to related items.
4. **A human approves.** Approved knowledge is written to canonical Markdown under `.iroha/` and committed — the team-shared source of truth.
5. **A local libSQL index makes it searchable** (lexical always; semantic once you enable embeddings with a key). The index is disposable and rebuildable from `.iroha/` any time — break it, delete it, whatever; it's never the sole source of approved knowledge.

## FAQ

**Does anything leave my machine?** By default, no. iroha is local-first with no cloud account and no telemetry. Two features reach the network only when you opt in with your own key — semantic-search embeddings (Voyage) and GitHub forge sync — and until then, not a single byte goes out.

**I don't have an embedding key.** No problem — search still works. Full-text and graph search run with zero configuration, Japanese and other CJK queries included; semantic search is a nice-to-have on top.

**How is my knowledge stored?** As plain, git-tracked Markdown under `.iroha/`. Read it, diff it, review it like any other source. The libSQL index under `.git/iroha/` is just a disposable cache.

**Rebuild the index?** `iroha sync --rebuild`. On a fresh clone, run `iroha init` first.

**What's with the name?** *iroha* (いろは) is the opening of a classic Japanese poem that uses each kana exactly once — it's come to mean "the ABCs," the fundamentals. Your engineering memory, from first principles.

## Contributing

Contributions are very welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development setup and workflow. The full product specification lives in [docs/](./docs/).

## Security

Hook enforcement is a guardrail, not a complete security boundary — hard enforcement belongs in CI. Found a vulnerability? Please open a [security advisory](https://github.com/iroha924/iroha/security/advisories/new) rather than a public issue.

## License

[Apache-2.0](./LICENSE) © iroha labs
