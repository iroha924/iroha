---
paths:
  - "packages/*/src/**/*.test.ts"
  - "packages/*/src/test-helpers/**/*.ts"
---

# Windows CI compatibility (test code)

`windows-2025` is not included in CI's `verify` matrix (`compatibility.md` §6 puts Windows at Tier 2 / best effort). For the reason, see "Windows post-close file locks cannot be resolved from application code" below. **Do not delete this file** — use it as reference material for test code run locally on Windows, and for when Windows CI is reconsidered in the future. Below are the classes of defect that test code verified only on macOS/Linux is highly likely to introduce.

## Do not hardcode path separators

- `path.join`/`path.dirname` (the default export, `path.win32`) return `\` on Windows. Hardcoding a `/`-separated absolute path directly in a test, like `expect(...).toBe("/repo/.git/iroha/index.db")`, will fail only on Windows.
- The implementation side (functions that use `path.join`/`path.dirname`) is generally correct — the bug is often in the test's expected value. The fix is not to change the implementation but to build the expected value with `join(...)` too, making it OS-independent.
- How to confirm: the `createSiblingDatabasePath` test in `packages/storage/src/rebuild.test.ts` is a concrete example. Assemble from relative path fragments like `join("repo", ".git", "iroha")`, and compute the expected value with the same `join(...)`.

## Windows post-close file locks cannot be resolved from application code

**Fact** (confirmed in the official SQLite documentation https://sqlite.org/tempfiles.html, and across several major Node SQLite bindings including Bun ([oven-sh/bun#25964](https://github.com/oven-sh/bun/issues/25964)) and better-sqlite3 ([JoshuaWise/better-sqlite3#376](https://github.com/JoshuaWise/better-sqlite3/issues/376))): in SQLite's WAL mode, when the last connection `close()`s it performs the sequence acquire exclusive lock → run checkpoint → delete `-wal`/`-shm` → release lock. This exclusive lock can, on Windows, persist for a while after `close()` has returned to the JS side (sometimes for a long time, occasionally not released until the process exits). `@libsql/client`'s local driver is no exception.

- Doing an `rm()`/`rename()` on the file immediately afterward results in `EBUSY: resource busy or locked`. This wait time is indeterminate, and **the same test may need 1.5 seconds on one run and not even 20 seconds on another** — no matter how large you make the retry budget, there is no guarantee that Windows CI turns green reliably.
- `closeDatabase()` in `packages/storage/src/connection.ts` switches to `PRAGMA journal_mode = DELETE` right before `close()` to try to avoid the exclusive-lock–checkpoint–delete sequence itself, but this is not a reliable solution either (caveat: if any other connection remains, the switch itself has no effect).
- `renameWithRetry` in `packages/storage/src/rebuild.ts` and `removeSiblingDatabase` in `packages/core/src/rebuild-database.ts` are **realistic mitigations** for this problem (retries within a reasonable range), not a solution. They are effective for users actually running on Windows, but do not guarantee passing on CI with 100% reproducibility.
- **Do not try to resolve this class of `EBUSY` by growing the retry budget alone.** If it still occurs in places where retries within a reasonable range (a few to a dozen-odd seconds) are already implemented, it is highly likely that increasing the retry count further will not converge. Unless there is new primary-source information that this limitation itself has been resolved (a fix on the SQLite/libSQL side, etc.), do not pursue 100% reproducibility in Windows CI.

The same caution applies to `fs.rm`'s own retry mechanism:

- **Do not trust `fs.rm`'s own `maxRetries`/`retryDelay` options** — documentation-wise they exist for exactly this purpose (linear-backoff retries against transient errors such as `EBUSY`/`EPERM`), but as confirmed reproducibly in CI, in the Node 24 + Windows combination these options do not work correctly, and it can fail to return until vitest's hook timeout (default 10000ms) is exhausted. The cause is unidentified (dependent on Node's internal `fs.rm` implementation).
- Countermeasure: do not rely on `fs.rm`'s `maxRetries`; write **your own short bounded retry** (`removeTempDir` in `packages/storage/src/test-helpers/tmp-db.ts` is a concrete example). Give up after a few attempts / a few hundred ms of waiting, and even if it ultimately cannot be deleted, **return silently without erroring** (best-effort). Because each test uses a unique directory every time via `mkdtemp`, leftover undeleted files never affect subsequent tests.
- If "Hook timed out in 10000ms" appears repeatedly in a specific file's `afterEach` in CI, first suspect this pattern (the cleanup retry hanging).

## Always reconcile the worst case of a test's own retry loop with vitest's timeout

Do the same arithmetic as `~/.claude/rules/ci-discipline.md`'s "Retry budget must be sufficiently smaller than the job timeout", **not only per CI job but also per test**.

- When you write your own retry loop (`for (attempt=1; attempt<=N; attempt++) { ... await sleep(backoff) }`) in a test's `afterEach`/body, compute its **worst-case cumulative wait time** (`Σ backoff`).
- vitest's default test timeout is **5000ms**. Because this monorepo has a policy of not placing a `vitest.config.ts` ([[typescript-conventions]]), this default value applies unless you override it explicitly via the third argument of `it(name, fn, timeoutMs)`.
- When the retry worst case approaches/exceeds the default timeout, the intended retry processing itself turns into a **different failure**: `Error: Test timed out in 5000ms`. This looks at first glance like a "hang" but is actually evidence that the retry is working; the cause is not a bug in the code but a **mismatch between the retry budget and the timeout**.
- Countermeasure: when a test itself calls processing that includes retries, pass an explicit timeout value to that test's `it(...)`. A rule of thumb is to leave a margin of about 1.5–2× `Σ backoff` (because the setup processing itself also takes several hundred ms to a few seconds).
- Redo this reconciliation every time you grow the retry budget. "The test failed with a timeout after I increased the retry count" is often a sign not that the retry is ineffective, but that **you forgot to update this timeout**.

## When a CI failure is in a different package or the cause is unknown

- On a Windows job, a test in a package you did not touch may fail, or `typecheck`/`build` may exit 1 with no error message. This is usually a flake on the CI infrastructure side, not a problem in the code.
- Rather than changing code on speculation, check the CI run history to see whether the same test passed in a recent run before deciding. For details, see `~/.claude/rules/ci-discipline.md`'s "Confirm whether a CI failure is new or pre-existing from the history before acting".

## Related

- General CI verification discipline is `~/.claude/rules/ci-discipline.md`.
- Path resolution and symlink safety is [[path-and-symlink-safety]] (a separate concern from this file — that one is about the security boundary, this one is about cross-platform compatibility).
- The full record of the background is `implementation/decision-log.md` ID-026(12)-(14).
