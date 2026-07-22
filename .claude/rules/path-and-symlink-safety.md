---
paths:
  - "packages/*/src/**/*.ts"
---

# Path traversal / symlink safety

A rule established after building the same class of defect 4 times in WP-02 (`packages/git/src/paths.ts`). Always apply it when writing/fixing path validation, symlink resolution, or repository-boundary checks.

## Core invariant: don't lexically fold `..` before resolving symlinks

`path.resolve()`/`path.join()`/`path.normalize()` fold `..` as a string operation without looking at the actual filesystem. Doing this on a path that contains a symlink makes `link/../secret.txt` (where `link` is a symlink pointing outside the repository) look like `secret.txt` "inside the repository" — because the `..` should be applied from the location **after** the symlink is followed, but it gets cancelled out at the string level **before** following it.

- In code that handles **untrusted / externally-sourced strings** (a tool target path via MCP, user input, etc.), don't use `path.resolve`/`path.join`/`path.normalize` on a variable that may contain `..`. Assemble it by string concatenation (template literals) and pass it to a symlink-aware resolver
- The above can happen even in **a different branch of the same function** (it actually did: the spot that assembled a symlink's target string used `join()`, breaking the "don't fold `..`" invariant — established on the outside — from the inside). On every fix, grep the whole file for `path.resolve(`/`path.join(`/`.normalize(` to check

## Delegate the work to `fs.realpath()`; keep hand-written code to a minimum

**Fact** (verified in the sources of glibc `stdlib/canonicalize.c` and Node.js `lib/fs.js`): the OS-native `realpath` lstats each segment component-by-component and, if it is a symlink, resolves it immediately before applying the next segment (including `..`) — this is exactly the standard algorithm that satisfies the invariant above, and **Node.js's `fs.promises.realpath()` is already implemented correctly for the case where the whole path exists**. Hand-written code is only needed for the extension that tolerates "the last component doesn't exist yet".

- When writing a new path resolver, first call `fs.realpath()` as a fast path, and only on `ENOENT` fall back to the minimal approach: "walk up to the nearest existing ancestor, delegate that part to `fs.realpath()`, and re-join only the remaining non-existent segments as strings"
- Don't reimplement the whole path yourself component-by-component. The more you implement, the greater the risk of forgetting to reproduce behavior the OS-native function handled implicitly (normalization of Windows short filenames, etc.) (this regression actually happened in this session)

## Before replacing an OS-native function, enumerate the platform differences

When you replace an OS-native function like `fs.realpath` with your own logic — even partially — explicitly enumerate the behaviors the native function may have handled implicitly, and judge them one by one:

- **Windows 8.3 short filenames** (`RUNNER~1`, etc.) — a bug actually reproduced in CI. `fs.realpath()` converts these to the canonical long filename
- **A literal `\` in a POSIX filename** — on POSIX, `\` is not a separator but just an ordinary character. If a path splitter treats both as separators, like `/[/\\]/`, it will wrongly split a legitimate filename containing `\` on POSIX. Make the separator a platform conditional
- **Case sensitivity** (Windows/macOS default to case-insensitive, Linux is case-sensitive)
- Locale-dependent output (out of scope for this file — see [[secure-subprocess-and-credentials]])

For platform behavior you can't reproduce in the local environment (macOS) — Windows short names, etc. — record "can't verify locally" as a risk in itself, and wait for the results of real-hardware CI (when the OS in question is in the Tier 1 matrix). Don't use "can't reproduce locally" as grounds for "no problem".

## When changing pattern matching, verify "what it newly lets through"

After changing a separator, an exclusion set, or a regex, **confirming only the false negative you fixed is not enough**. Come up with and try at least 2–3 **new** false negatives that the same change produces.

Example (actually happened): to fix a problem where two adjacent URLs separated by a comma were wrongly collapsed into a single match, a comma was added to the separators → this time, in the case where "the password itself contains a comma", it cut off before the `@`, and redaction stopped working. Always suspect that a single delimiter character can be both a "separator" and "part of a value".

## OWASP guidance

**Fact** (verified on the official OWASP Path Traversal page): canonicalize-then-prefix-check (this repository's approach) is a valid defense, but OWASP ranks "don't use user input as a file path in the first place" and "validate with a strict allow-list" higher, as stronger options. Prefer those where possible.

Concrete example: `computeCanonicalPath` in `packages/canonical/src/write-canonical-document.ts` does not validate a path passed by the caller; instead it derives the path directly from `id`/`type`/`created_at`, which have already passed Zod's strict ULID pattern. The class of bug where the caller's path and the document's path diverge is eliminated by making it impossible to occur by design, rather than by adding a check. Where you can derive a path deterministically from trusted identifiers, prefer this approach (don't put yourself in the position of validating a received path).

## Related

- Credentials and subprocess topics: [[secure-subprocess-and-credentials]]
- General error-handling conventions: [[typescript-conventions]]
