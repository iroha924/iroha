# Changelog

Every published version of `@irohalabs/iroha`. `docs/contracts/compatibility.md` §13
requires a release's version to match the package, the manifests, this file, and the
Git tag; `release.yml` fails the release if the version being published has no entry
here.

Entries are written by hand as part of the release, alongside the four version
strings (`PLUGIN_VERSION`, the plugin `package.json`, `CLI_VERSION`, `SERVER_VERSION`)
that `manifests.test.ts` asserts agree.

## 0.6.0

- **Breaking: API keys move out of environment variables and into
  `~/.config/iroha/credentials.json`** (`$XDG_CONFIG_HOME` is honoured).
  `api_key_env` and `forge.api_token_env` are removed from `.iroha/config.yaml`;
  a config written by an earlier version still parses, and `iroha init` rewrites
  it without them. Nothing reads `VOYAGE_API_KEY` or `GITHUB_TOKEN` any more —
  re-register your keys from the dashboard's Settings page, or with
  `pbpaste | iroha credentials voyage`. The CLI reads the key from stdin only,
  never an argument, so it stays out of your shell history and the process list;
  the file is `0600` in a `0700` directory that carries its own `.gitignore`, and
  is read fresh on every request.

  This fixes a defect present since 0.1.0: a process freezes its environment at
  spawn, so the MCP server your agent host started kept using whatever key was
  set when the host launched. Rotating a key, or setting one for the first time,
  did nothing until the whole host restarted — and nothing said so, because a
  rejected key degrades to lexical search by design. If semantic search has been
  silently not working for you, this was why.

- **`iroha doctor` now reports how many documents failed to embed**, alongside
  whether a key is stored. "key set" on its own read as healthy while search
  quietly answered from the lexical index alone. It also warns when a
  pre-0.6.0 `api_key_env` holds something that is not an environment variable
  name — if you pasted the key itself there, it is in your Git history and needs
  rotating.

- **New: `iroha credentials <voyage|github>`** and
  `PUT /api/v1/settings/credentials`. Both are write-only: no endpoint and no
  command returns a stored key, and the dashboard and `doctor` report presence
  only.

## 0.5.0

- **Breaking: the Digest is gone, and with it two MCP tools and a skill.**
  `get_digest_data` and `save_digest_prose` are removed from the MCP server, and
  `/iroha:digest` is removed from both plugin manifests. An agent that calls
  either tool now gets an unknown-tool error. Nothing else replaces them: the
  Digest was a per-period editorial page whose prose your own agent session
  composed, and the page it narrated no longer exists.
- **The dashboard's front page is now the Overview, at `/`.** It carries only
  numbers you can act on: how enforceable your approved Guardrail set actually is
  (a Guardrail that names no paths cannot be enforced at the hook at all), which
  Rules denied what over the last 30 days and where those denials clustered, plus
  the pending review queue and approved-knowledge composition. Activity volumes —
  sessions started, checkpoints written, per-period approval totals — are
  deliberately absent; they were counted but never acted on, and a number nobody
  acts on only teaches you to skip the ones you should read. `/overview` now
  redirects to `/`, as does any unknown path.
- **Markdown in the dashboard renders GitHub-flavored.** Tables and task lists in
  an imported `CLAUDE.md` or `.claude/rules/*.md` rendered as literal pipes and
  brackets before; they now render as tables and checkboxes. Raw HTML in a
  document is still shown as inert text and never as markup.
- **Imported documents get a readable summary.** The one-line summary was taken
  from a document's first *line*, so a paragraph wrapped across source lines was
  cut at whatever column the author's editor wrapped at — this repository's own
  `CLAUDE.md` was summarized as "…for Claude Code and Codex. It ships as". It is
  now taken from the first paragraph, with Markdown emphasis stripped and any
  truncation landing on a sentence boundary. Existing entries keep their old
  summary until the document changes; `iroha sync --rebuild` refreshes them all.
- **Saving, approving, rejecting, and resyncing now confirm themselves.**
  Approving or rejecting a candidate returns you to the queue, and until now that
  navigation discarded the only feedback you would have got.
- **Knowledge detail opens over the list instead of replacing it**, while a
  direct link or a reload still opens the full page, so a shared URL keeps working.
- **Doctor no longer shows an empty "recent problems" table.** That table only
  ever holds failures, so on a healthy repository it was permanently empty; it is
  now a dialog that appears only when there is something in it. A failed read of
  the diagnostics themselves now says so instead of rendering as a clean bill of
  health.
- **`iroha sync` no longer reports pruned digest issues**, and migration `008`
  drops the `digest_issues` table and the `digest.period` local setting. Both were
  local, disposable index state that `sync --rebuild` already discarded, so
  nothing reconstructible is lost.

## 0.4.0

- **`iroha init` and `iroha sync` now index the repository's own instruction
  documents** — `CLAUDE.md`, `AGENTS.md`, and `.claude/rules/**/*.md` — as
  knowledge at `status = 'imported'`. They are not copied into `.iroha/` and they
  never enter the review queue: these files are already committed and already
  binding on whoever works in the repository, so a queue asking a maintainer to
  approve their own `CLAUDE.md` was a rubber stamp. The source file stays the
  single source of truth, and `sync` re-reads it when it changes (ADR-017,
  `docs/contracts/canonical.md` §14).
- **The `--scan` flag is gone, and the candidates it used to create were
  unusable.** `iroha init --scan` wrote a candidate payload in a shape no reader
  understood, so opening one in the dashboard returned a 500 and approving it
  threw the same error — the candidates could be neither viewed nor approved,
  from 0.1.1 (the first release carrying `--scan`) until now. Migration `007` deletes the
  pending ones. `iroha init --scan` still runs: an unknown flag is ignored, and
  plain `init` now does the import anyway.
- The dashboard's **"Approved knowledge" page is now "Knowledge"**, with a status
  filter. Imported documents appear alongside approved knowledge and are told
  apart by their badge; `superseded` and `archived` remain opt-in. Their body and
  source file are shown on the detail page.
- Imported documents are returned by `search` and `get_context` at authority 80,
  carrying a `document` source reference to the file they came from, and are
  embedded on the same terms as approved knowledge. `get_active_rules` does
  **not** serve them: the agent harness already auto-loads those files, and
  pushing the same text again would deliver it twice.
- A repository instruction document is not read if it resolves outside the
  repository once symlinks are followed, and `.claude/rules` is containment-checked
  before it is traversed rather than after. A document whose text trips the secret
  scan is withheld from the index entirely, and any revision of it already indexed
  is retired at the same time.
- Deleting or renaming an instruction document now retires its entry, so a renamed
  rule is no longer served under both names and a deleted one is no longer served
  indefinitely.

## 0.3.6

- **A proposal whose body is not a canonical document is now rejected when it is
  written, not when someone tries to approve it.** The body template
  (`docs/contracts/canonical.md` §7 — an H1 equal to the title, then the required
  H2 sections for that type) was only ever checked at approval, so an agent could
  write anything and a reviewer inherited a candidate no one could approve and no
  agent was still around to fix. In one dogfooding repository this had made the
  entire queue unapprovable: of 64 pending candidates, **zero** could be approved
  — 36 had no H1, 19 had an H1 that did not match the title, 9 were missing a
  required section. `create_checkpoint` and `propose_knowledge` now both reject,
  and the error names the sections the body is missing so the agent can rewrite it.
- A secret found in a proposal's title or body is also a rejection now. The scan
  replaces the whole field, and a placeholder can never satisfy the template, so
  the call fails rather than storing a candidate that is permanently stuck.
  `contracts/mcp.md` §6.6 step 5 previously said nothing about either case.
- **A title may no longer begin or end with whitespace.** A Markdown heading
  cannot carry it, so a padded title had no writable H1 and could never satisfy
  §7. Rejected in the JSON Schemas and the Zod mirrors alike.
- The SessionStart context now tells the agent which language to write a
  Checkpoint or Proposal in, taken from `config.default_language`. It had only
  ever chosen the dashboard's locale; the content language was whatever the agent
  happened to be writing in.
- The context block no longer loses its tail when it is long. It was truncated
  from the end, so ten approved rules with long summaries could cut the closing
  tag and the language instruction entirely.
- Dashboard: candidate and knowledge badges are coloured by knowledge **type**
  rather than by status, so a type reads as the same colour on every page, and
  the seven tones now meet WCAG 2.2 AA on their backgrounds. The review queue is
  called *Knowledge candidates*, the approved-knowledge list has numbered pages,
  a long candidate body is folded with an expand toggle, and a select shows the
  chosen label rather than the stored value (`forever`, `week`, `en`).
- Dashboard: the candidate detail is **read-only**. The reviewer's decision is
  whether the knowledge is worth keeping, not what it should say; approving used
  the stored draft and never the on-screen text, so editing and approving without
  saving discarded the edit silently. The session, run and checkpoint pages are
  removed with it — browsing an activity log is not what this is for.

## 0.3.5

- iroha stops demanding a Checkpoint after every command. It asked for one on
  nearly every turn — measured at 15 Checkpoints across 17 turns in a single
  session, 11 of which recorded only that something was being waited on: a
  reviewer launched, CI in progress, a workflow dispatched with an unknown
  result. Those went into the same review queue you have to read, and into the
  Digest. A Checkpoint saying nothing happened is worse than no Checkpoint.
- What still requires one is unchanged where it matters: a mutation that
  succeeded, and **a command that failed** — a failed `pnpm test` is the turn
  whose unresolved work most needs recording, and that has been true since
  0.3.2. What changes is a command that *succeeded*: iroha now suggests a
  Checkpoint instead of forcing one, and the agent decides. It can tell a test
  run from a status poll; the hook cannot, because distinguishing them needs a
  command classifier that does not exist (the attempt is recorded in
  `packages/core/src/hooks/dispatch.ts`).
- A command that never ran no longer counts. One denied by a Guardrail, or
  cancelled at the permission prompt, used to leave a record that read as "a
  command ran" — so it produced exactly the empty reminder this is meant to
  remove.
- **Codex is unaffected**, and keeps the old behaviour. Its adapter reports every
  finished tool as successful, so a failed command is indistinguishable from a
  successful one there; applying the split would have silently downgraded failed
  validations. Every Codex command therefore still requires a Checkpoint until
  the adapter can tell the two apart.

## 0.3.4

- The review queue pages ten candidates at a time instead of growing into one long
  column with a "load more" button. Page numbers and the status filter live in the URL,
  so a page is linkable and reloading keeps your place. Any page is a single request:
  `GET /api/v1/candidates` now takes an `offset` and returns `total` alongside the rows.
  Because an offset names a position rather than a row, a single forward pass through
  the pages can skip or repeat a candidate while the queue changes underneath — the row
  moves to an adjacent page rather than disappearing, and `cursor` paging is still there
  for a client that needs to enumerate every candidate exactly once.
- The reviewer field on a candidate offers the repository's people instead of asking you
  to retype a name every time. It prefills with your local `git config user.name` and
  narrows as you type, and it stays free text, so a name Git has never seen still
  approves. The list comes from recent commit authors across all refs — a teammate who
  has only committed on a feature branch is still there — via the new
  `GET /api/v1/people`. Names are never ordered by how much anyone committed and carry
  no activity counts.
- A name that Git reports is no longer trusted verbatim. Under `log.showSignature` Git
  interleaves signature-verification text into the same output the author names come
  from, which could put a line such as `~/.ssh/allowed_signers:1: invalid key` in front
  of you as a person to credit; under `i18n.logOutputEncoding` it re-encodes the author
  ident, so an accented name arrived as mojibake that would have been committed as
  someone's spelling. Both are closed. Names carrying bidirectional overrides or
  zero-width characters are dropped too, since they are written verbatim into a
  Git-tracked file and would otherwise garble it for every later reader.

## 0.3.3

- The dashboard's Graph tab shows a coming-soon placeholder. The interactive work graph
  was not good enough to look at, and shipping it in that state set the wrong expectation
  for the rest of the dashboard. The tab and its route stay where they were, and the copy
  says what is missing and what already works — relations are recorded and queryable, and
  each knowledge entry lists its own on its detail page.
- The dashboard bundle is smaller: 254 kB of JavaScript and 14 kB of CSS brotlied, down
  from 299 kB and 16 kB, because React Flow no longer ships for a view nobody can reach.
  The placeholder issues no relation query either.

## 0.3.2

- Tool failures are recorded. `tool_events` has modelled a `failure` phase since the
  first migration and nothing ever wrote one, because `PostToolUseFailure` was never
  subscribed — measured at 482 `pre`, 470 `post` and 0 `failure` over a working
  session where lint and test commands failed repeatedly. The Digest's "where you
  stumbled" section could until now only ever see guardrail denials.
- A failed validation command requires a Checkpoint. §6.6 applies its success
  condition to the mutation clause only; a build/test/migration command qualifies
  because it ran, and a failed `pnpm test` is the turn whose unresolved work most
  needs recording.
- `PostToolUseFailure` uses PostToolUse's 375 ms Git-resolution budget instead of the
  250 ms unknown-event default, which could return before persisting anything.
- The dashboard's two navigation landmarks carry an `aria-label`; previously both
  were announced as a bare "navigation" with nothing to tell them apart.
- Added an end-to-end sweep over every dashboard tab and the review detail route.

## 0.3.1

- The published `hooks/claude.json` put the event map at the top level, so Claude
  Code rejected the file and loaded **no hooks at all** — no `SessionStart`,
  `PreToolUse`, `PostToolUse` or `Stop` capture, and therefore no Turn/Checkpoint
  lifecycle and no data behind the Digest. Every version from 0.1.0 shipped that
  shape.

## 0.3.0

- The Digest: an editorial weekly or monthly issue as the dashboard's front page,
  with `get_digest_data` / `save_digest_prose` MCP tools and the `/iroha:digest`
  skill. Numbers come from iroha's index; an agent may write only the surrounding
  prose, and only by referencing iroha's own figures.

## 0.2.4

- Local event-data retention is configurable.

## 0.2.3

- The npm copy of the README gets absolute links, so repo-relative ones do not break
  on the registry page.

## 0.2.2

- The release workflow runs on Node 24 and ships a README on npm.
- The published package carries its keywords and bugs URL.

0.2.1 was bumped and then reverted before publishing, so no such version exists on
npm and no tag was created.

## 0.2.0

- `event_log` wired up for observability.

## 0.1.2

- Packaging and tooling: `publint` + `attw` validation of the published package,
  `knip`, `mise`, `czg`, `sherif`, `taze`, and the CodeQL and Trivy advisory scanners
  in CI.

## 0.1.1

- The first work packages: Git repository identification and path resolution, the
  libSQL storage package, and the canonical parser and publisher.

## 0.1.0

Initial release. Published manually and locally, because npm cannot configure a
trusted publisher before a package exists ([npm/cli#8544](https://github.com/npm/cli/issues/8544)),
so this is the one version without a provenance attestation and without a Git tag.
