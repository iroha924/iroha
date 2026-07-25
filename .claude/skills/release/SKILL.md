---
name: release
description: Cut an iroha npm release — bump the version, verify locally, dispatch the human-gated Release workflow, and confirm the publish. iroha ships to npm as `@irohalabs/iroha` via OIDC trusted publishing (no npm token). Use when preparing or cutting a release (a new `@irohalabs/iroha` version), or when asked "how do we release / publish iroha". Not for day-to-day development.
user-invocable: true
allowed-tools: Bash(pnpm *) Bash(node -p *) Bash(npm view *) Bash(curl *) Read Grep
---

# Cutting an iroha release

iroha publishes to npm as **`@irohalabs/iroha`**. Publishing is **human-gated**: the
`release.yml` workflow is `workflow_dispatch`-only and defaults to a dry run, and it
authenticates with **OIDC trusted publishing** — there is no `NPM_TOKEN` and there must
never be one (decision-log ID-071, which supersedes ID-040's token auth). This skill does
the local preparation and verification; the actual publish is a human dispatching the workflow.

## Preconditions

- On `main`, clean working tree, CI green.
- The npm trusted publisher is configured once for GitHub org `iroha924` / repo `iroha` /
  workflow `release.yml` (already set up; nothing to do per-release).

## 1. Bump the version

Update **all four** to the same semver value — `manifests.test.ts` asserts they match, so
a missed one fails CI:

- `PLUGIN_VERSION` in `packages/plugin/src/metadata.ts`
- `version` in `packages/plugin/package.json`
- `CLI_VERSION` in `packages/cli/src/index.ts` (the `iroha --version` string)
- `SERVER_VERSION` in `packages/mcp/src/server.ts` (the MCP handshake version)

Commit as its own PR (`chore(release): vX.Y.Z`), let CI go green, and merge.

## 2. Local sanity check

```bash
pnpm check:package   # builds the release, then validates it with publint + attw
node -p "const p=require('./packages/plugin/release/package.json'); p.name+'@'+p.version"
# expect: @irohalabs/iroha@X.Y.Z
(cd packages/plugin/release && npm publish --dry-run --access public)
```

Confirm the assembled name/version and the file list look right. `check:package` (also a CI job and a
`release.yml` step) must pass — publint "All good", and attw's "does not contain types" is expected for
this CLI package (see [[dev-tooling]]). Do **not** run a real `npm publish` locally — the release goes
through the workflow so it is attested.

## 3. Dry-run the Release workflow

GitHub → **Actions** → **Release** → **Run workflow**: `version: X.Y.Z`, `publish: false`.
It builds the tarball, SHA-256 checksums, SBOM, and the GitHub build-provenance
attestation **without publishing**; the version-consistency step fails fast if `version`
does not match the built package. Confirm the run is green.

## 4. Publish

Run the **Release** workflow again: `version: X.Y.Z`, `publish: true`. It publishes
`@irohalabs/iroha@X.Y.Z` to npm over OIDC (trusted publishing → provenance is generated
automatically) and creates the GitHub Release `vX.Y.Z`. No token is involved.

## 5. Verify

```bash
# Cache-busting the registry directly (the npm CLI may cache an older 404):
curl -s "https://registry.npmjs.org/@irohalabs%2Firoha" | grep -o '"latest":"[^"]*"'
npm view @irohalabs/iroha version
```

Check the provenance badge on the npmjs.com package page.

## Notes

- OIDC trusted publishing needs npm **>= 11.5.1**; the workflow upgrades npm before
  publishing, so the runner's bundled version does not matter.
- The very first publish (`v0.1.0`) was done manually and locally, because npm cannot
  configure a trusted publisher before a package exists ([npm/cli#8544](https://github.com/npm/cli/issues/8544));
  that one version has no provenance badge. Every workflow-published version since does.
- If a dispatch fails on auth, check the trusted-publisher config on npm (org / repo /
  workflow filename must match exactly) — do **not** "fix" it by adding an `NPM_TOKEN`.
