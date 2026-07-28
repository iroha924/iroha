# Changelog

Every published version of `@irohalabs/iroha`. `docs/contracts/compatibility.md` §13
requires a release's version to match the package, the manifests, this file, and the
Git tag; `release.yml` fails the release if the version being published has no entry
here.

Entries are written by hand as part of the release, alongside the four version
strings (`PLUGIN_VERSION`, the plugin `package.json`, `CLI_VERSION`, `SERVER_VERSION`)
that `manifests.test.ts` asserts agree.

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
