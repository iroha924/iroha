# Changelog

Every published version of `@irohalabs/iroha`. `docs/contracts/compatibility.md` §13
requires a release's version to match the package, the manifests, this file, and the
Git tag; `release.yml` fails the release if the version being published has no entry
here.

Entries are written by hand as part of the release, alongside the four version
strings (`PLUGIN_VERSION`, the plugin `package.json`, `CLI_VERSION`, `SERVER_VERSION`)
that `manifests.test.ts` asserts agree.

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
