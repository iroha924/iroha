# Security policy

Thanks for helping keep iroha and the people who use it safe.

## Reporting a vulnerability

Please report security vulnerabilities **privately** — don't open a public issue for them.

Use GitHub's private vulnerability reporting: open a [new security advisory](https://github.com/iroha924/iroha/security/advisories/new). That keeps the details between you and the maintainers until a fix ships.

When you report, please include as much of this as you can:

- what the issue is and the impact you think it has;
- the steps (or a small proof of concept) to reproduce it;
- the affected version, commit, or area of the code.

We'll acknowledge your report, dig in, and keep you posted as we work on a fix. iroha is maintained by a small team, so responses are best-effort rather than on a fixed SLA — but security reports jump the queue.

## What's most relevant

iroha is **local-first**: it runs on your machine, against your own Git repository, with no hosted backend, no telemetry, and no cloud account. So the areas where a security report matters most are:

- credential and secret handling (config records environment-variable *names*, never their values);
- path and symlink validation;
- subprocess execution;
- the local dashboard's authentication and same-origin boundaries.

One design note worth calling out: **hook enforcement is a guardrail, not a complete security boundary.** Guardrails make the easy, accidental mistake harder — they aren't a sandbox, and hard enforcement belongs in CI. A guardrail bypass is still worth reporting; just frame it with that intent in mind.

## Supported versions

iroha is pre-1.0 and moves fast. Security fixes land on the latest `main` (and the most recent release, once releases begin). Please test against the latest `main` before reporting.
