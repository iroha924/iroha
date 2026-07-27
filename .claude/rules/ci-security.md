---
paths:
  - ".github/workflows/**"
  - ".semgrep/**"
  - "osv-scanner.toml"
  - ".gitleaksignore"
---

# CI security scanners: what runs, what each covers, and the overlaps

iroha's CI runs several security scanners. They overlap on purpose (defense in depth), but knowing who
owns what avoids duplicate gating and a false "something else already covers it" assumption. All live in
`.github/workflows/ci.yml`; every third-party action is pinned to an immutable commit SHA and every job
runs at least privilege (the default is `contents: read`; a scanner escalates only to
`security-events: write` for SARIF upload).

| Scanner | Job | Covers | Gates the build? |
|---|---|---|---|
| **osv-scanner** | `dependency-scan` | Known CVEs in dependencies (from the lockfile) | **Yes** — fail-on-vuln |
| **gitleaks** | `secrets-scan` | Committed secrets (entropy + patterns) across git history | **Yes** |
| **CodeQL** | `codeql` | SAST for JS/TS (dataflow, injection, unsafe patterns) | No — uploads to the Security tab |
| **Trivy** | `trivy` | Deps + secrets + **config/IaC misconfiguration** | No — advisory (`exit-code: 0`), Security tab |
| **Semgrep** | `semgrep` | iroha's **own** invariants (custom rules, `.semgrep/`) | **Yes** — hard gate (`--error`) |

- **Gating vs advisory.** osv and gitleaks **fail** the build — a real vulnerable dependency or a
  committed secret must block merge. CodeQL and Trivy are **advisory**: they surface findings in the
  GitHub Security tab without blocking, because they overlap the gating scanners (Trivy's dep/secret
  scan duplicates osv/gitleaks) and their unique value (CodeQL's SAST, Trivy's misconfiguration scan) is
  a review signal, not a hard gate. Triage their findings in the Security tab; promote a recurring class
  to a gate only deliberately.
- **Why keep the overlap.** Each tool detects differently — osv is CVE-database-driven, gitleaks is
  entropy+regex, CodeQL is dataflow, Trivy bundles several engines — so a gap in one is often caught by
  another.
- **Local vs CI.** The pre-commit/pre-push hooks run only the gitleaks secret scan; osv/CodeQL/Trivy are
  CI-only (heavy binaries and vulnerability databases). Treat that divergence the same way the rest of
  the CI-only checks are treated (`~/.claude/rules/ci-discipline.md`): a green local run does not prove
  these will pass.

## Semgrep — iroha's own invariants (a hard gate, unlike CodeQL/Trivy)

Unlike the generic scanners above, Semgrep runs a **local, repo-owned ruleset** (`.semgrep/`, no Semgrep
registry or cloud) that encodes conventions only this project knows — so it is a **hard gate**
(`--error`), not advisory. The codebase currently has zero matches, so each rule only prevents a
regression. Each rule maps to a documented rule and was verified to both (a) flag a deliberate violation
and (b) leave the current code clean:

- `zod-use-safeparse` — flags `<name>Schema.parse(...)`; boundaries must use `.safeParse()` and return a
  `Result`, never throw ([[typescript-conventions]]).
- `subprocess-env-no-spread` — flags `{...process.env}`; a subprocess env must be an allowlist copied out
  of an empty environment, not a spread ([[secure-subprocess-and-credentials]]). The pattern matches the
  object spread only, not a legitimate `helper(process.env)` call or `process.env.X` read.
- `no-dynamic-eval` — flags `eval(...)`.

Run locally with `pnpm semgrep` (needs semgrep on PATH — it is a Python tool, `pipx install semgrep`,
not an npm dependency; CI installs a pinned version via pipx). When you add a rule, add it to `.semgrep/`
with a `message` that cites the rule it enforces, and confirm it flags a deliberate violation before
relying on it.

## Related

- Review bots (Greptile / Codex) are a different axis from these scanners: the `pr-review-status` skill.
- Local, non-security dev tooling: [[dev-tooling]].
