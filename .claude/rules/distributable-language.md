# Language of distributables: English by default

iroha's **distributables and artifacts default to English**. Japanese is "an additional locale we offer," not the default. Conversation (development chat in this repo) may be in Japanese, but anything that stays in the code or reaches a user must default to English.

## Write in English (the default for everything that ships or guides development)

- Product / CLI / package names (`iroha`, `@irohalabs/iroha`).
- CLI output, error messages, help text.
- Source-code comments, docstrings, identifiers.
- **Everything under `.claude/**`** — rules (`.claude/rules/`), skills (`.claude/skills/*/SKILL.md`, incl. the frontmatter `description`), agents (`.claude/agents/`), hooks, and commands. This repo is public and its `.claude/` files are read by English-context reviewers (Codex reads `.claude/rules/*.md` in CI per `AGENTS.md`).
- **Everything under `.gemini/`** — `config.yaml`'s comments and `styleguide.md`, for the same reason: they are instructions to a hosted reviewer, and `styleguide.md` also sets the language its findings are written in.
- `README`, `.github/` templates, and any contract docs that ship with the product.
- Canonical **section headings** written into `.iroha/` (`Observation`, `Evidence`, …). They are contract constants in `packages/canonical/src/body-template.ts`, not prose. The prose between them is governed below, not here.
- **The dashboard UI's default locale** (`apps/dashboard`'s i18n fallback is `en`).
- The `default_language` in the `config.yaml` that `iroha init` writes (default `en`).

When you create or edit any of the above — especially a new `.claude/**` file — write it in English from the start. Do not draft it in Japanese and translate later.

## Canonical knowledge content follows the repository's `default_language`

A canonical document's `title`, `summary`, and `body` are not a distributable. They are one repository's memory, read by whoever works in that repository, so they follow that repository's `config.default_language` rather than the English default above (#164). Write a Checkpoint or a Proposal in the language the config names, whatever language the surrounding session is in.

This repository does not commit its own `.iroha/` (see the root `.gitignore`), so nothing written there reaches a user and the English-artifact default has nothing to bite on. A fresh clone has no `.iroha/` at all until `iroha init` writes one, and `init` writes `en`; the working copy a maintainer accumulates knowledge in is theirs to set.

## Japanese is allowed here

- **`docs/`** (architecture and contract reference). It is maintainer-facing reference, not a shipped artifact, so the Japanese already there is acceptable — do not force `docs/` to English. This exemption means `docs/` is not a *target* of English enforcement; it does not mean new `docs/` prose should be written in Japanese.

## Exempt: intentional Japanese as data, not prose (keep as-is)

These are data or locale content, not documentation to translate — leave the Japanese in place:

- **i18n message catalogs for the `ja` locale** (`apps/dashboard/src/i18n/`). Translating the `ja` catalog to English would destroy the Japanese locale — that is the whole point of offering it.
- **Language endonyms in the UI** — e.g. `<option value="ja">日本語</option>` in the locale picker. `日本語` is the correct native name of the language option; do not render it as "Japanese."
- **Test data / fixtures that deliberately exercise CJK** — FTS tokenization tests, path-handling tests with Japanese filenames, the vertical-slice Japanese query, review-learning CJK examples, eval fixtures. The Japanese there is the input under test, not prose. (Test *descriptions* and comments around such data are still English.)

The dashboard keeps both English and Japanese message catalogs and makes `ja` **selectable** (a repo with `config.default_language: ja` may render in Japanese at startup). The policy is "default English, Japanese opt-in" — not "remove Japanese."

## Discrepancy with the spec

`docs/contracts/dashboard-api.md` §8 prose says "Japanese is the default UI locale," but that is **overridden by this rule** (English default). `iroha init` already writes `default_language: "en"`, so the code and this rule are authoritative. The prose is wrong (to be corrected in a future doc pass).

## Related

- The rationale for "conversation may be Japanese, artifacts are English" is the same as the user memory `iroha-english-artifacts`.
