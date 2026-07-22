---
paths:
  - "packages/*/src/**/*.ts"
---

# Subprocess execution and credential handling

Knowledge gained across 6 rounds of Codex review of WP-02 (`packages/git`). Always apply it when writing/fixing code that involves subprocess execution or credentials (`packages/git`, the future `packages/forge*`, `packages/adapter-*`, etc.).

## Environment variables: prefer an allowlist over a denylist

The approach of copying `{...process.env}` and `delete`-ing dangerous variables (a denylist) has a structural flaw: **you can never remove a variable you don't know about**. In this very session we discovered them one at a time, after the fact, over 5 rounds: the `GIT_DIR` family → the `GIT_TRACE` family → `GIT_CEILING_DIRECTORIES` → `GIT_REDIRECT_*`.

- When writing a new subprocess wrapper, prefer an allowlist approach that **copies only the required variables out of an empty environment** (`PATH`, `HOME`, `TEMP`/`TMPDIR`, etc. — only what is actually needed)
- When touching a place already written as a denylist, like the existing `packages/git/src/run-git.ts`, don't settle for adding one new variable — consider replacing it with an allowlist
- **Fact** (Node.js official documentation): on Windows, when the `child_process` `env` option contains multiple keys with the same name differing only in case, the first match in lexicographic order is used. That is about resolving duplicates *within the object you passed*, and **if you forget to `delete` a lowercase form of a parent-process environment variable, it leaks straight through to the child process** (because Windows environment variables are case-insensitive). A denylist implementation that removes environment variables must `delete` using a case-insensitive comparison

## Don't include raw values in error messages (don't redact after the fact)

**Fact** (OWASP Logging Cheat Sheet, CWE-209): passwords, tokens, and connection strings should be removed, masked, or hashed *before they are logged*; after-the-fact filtering (collecting them first, then stripping with a regex) is not a recommended approach. **Fact** (verified against execa's documentation): execa, the most widely used subprocess wrapper in Node.js, deliberately has no redaction feature — its error messages and `verbose` mode include arguments verbatim, delegating the judgment about sensitive values entirely to the caller.

In this project we honed a regex-based redaction (`credential-redaction.ts`) over 6 rounds, but still hit a ceiling: it fundamentally cannot detect a secret value that isn't even in URL form. **Recommended**: in new subprocess wrappers / error-construction code,

1. First ask, "is this value really necessary in the error?" If not, **leave it out** (keep only the subcommand name, the number of arguments, the exit code, and the signal)
2. Only when you truly must include it, consider redacting known shapes (URLs, etc.). But note explicitly in a comment that this is a denylist and is fundamentally bypassable
3. Don't pass a raw exception object (`ExecFileException`, etc.) straight into `error.cause`. Its `.message`/`.cmd` can contain the entire invoked command (confirmed in Node.js). Replace it with a synthetic Error that holds only redacted content

## Pre-storage redaction/sanitization must enumerate every unconstrained free-text field

A defect with the same structure as the opening "a denylist can't remove what it doesn't know about", which recurred in the self-review of WP-07 (`packages/core/src/mcp/redact.ts`). In the implementation that redacts secrets before saving structured input (Checkpoint/Proposal, etc.) to the local DB, it initially only scanned the prose fields (title/summary/body) and let `guard.denyCommands` (a command string), `sources[].url`/`references[].url` (whose userinfo can carry credentials), `scope.symbols`, and `implementation[].symbol` pass straight through. Worse, the docstring made an **unverified safety claim** that "these have format constraints, so they can't carry credentials" (wrong — unlike enums or relative paths, these are unconstrained free-text).

- Look at the schema being redacted/sanitized and **enumerate every single unconstrained free-text field**. Array elements, URLs (userinfo), and nested objects (guard spec, etc.) are all in scope. Even something that *looks* "format-constrained" must be treated as free-text as long as it is **not actually constrained** by a Zod enum / regex / relative path
- **Don't write unverified safety into docstrings/comments**. If you write "this field is safe", attach the evidence that you actually checked that field's schema constraints. An unverified safety claim misleads reviewers and your future self
- When redacting a field that has a format such as a URL, use a **format-valid placeholder** that doesn't break downstream validation (re-validation at approval time, etc.) (e.g. `https://redacted.invalid/`; `.invalid` is an RFC 2606 reserved TLD)
- Don't skip this even when the target is the local disposable DB. Unlike canonical (human-approved, Git commit), we don't **reject** before saving, but if you neglect to redact, plaintext remains in the at-rest store

## stderr pattern matching depends on the locale

When writing code that determines an error type from a CLI tool's human-readable messages (like Git's `fatal: not a git repository`), set `LC_ALL=C` and `LANG=C` in the child process's `env`, and remove `LANGUAGE` (because GNU gettext gives `LANGUAGE` priority over `LC_ALL`/`LANG`, setting those alone is insufficient — you must explicitly unset it). Even if your local git build has no NLS support and can't reproduce the translations, you may act on that basis as long as the official documentation confirms the mechanism (reproduction on real hardware is not required).

## Related

- Path-resolution safety: [[path-and-symlink-safety]]
- General error-handling conventions: [[typescript-conventions]]
