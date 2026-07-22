# TypeScript / Zod / Node conventions (iroha)

Implementation conventions specific to this repository. Not general TS practices — only the ways of writing that have actually been verified in this monorepo.

## Module resolution

- `packages/*` inherit `module`/`moduleResolution: "nodenext"` from `tsconfig.base.json`. Relative imports **must be written with a `.js` extension** (`./foo.js`; the source may be `.ts` — TypeScript resolves it to the source via `file extension substitution`, an official specification since Node16/NodeNext). `apps/dashboard` uses `moduleResolution: "bundler"`, so the `.js` extension is not required.
- `path.resolve`/`path.join` **collapse `..` lexically internally** (before resolving symlinks). Never use them on untrusted/externally-sourced strings that may contain `..`. See [[path-and-symlink-safety]] for details.
- The inter-package dependency boundaries (`implementation/compatibility.md` §4 "which package may depend on which package") are **mechanically enforced** by the `overrides` in `biome.json` (per-package `noRestrictedImports`). Writing a disallowed `@iroha/*` import makes `pnpm lint` fail with an error, and the message includes the allowed dependency targets. There is no need to check the §4 table by hand — just run `pnpm lint` and you will know. When changing §4 itself, update the corresponding override in `biome.json` in the same commit.

## Type definitions

- Use `interface` for object-shape types (not `type`). `biome.json`'s `useConsistentTypeDefinitions` enforces this.
- Exception: contract types derived via `z.infer<typeof xxxSchema>` (described below) stay as `type` (`interface` cannot directly express the result of a type operation). In this case `type` is not a rule violation but the only way to write it.
- Use named exports only. Do not use default exports (`biome.json`'s `noDefaultExport` enforces this).
- File names are kebab-case (`biome.json`'s `useFilenamingConvention` enforces this for `packages/*/src/**`. `apps/dashboard` is excluded because React components have a PascalCase convention).

## Error handling

- Use `@iroha/domain`'s `Result<T, E>` type (`ok`/`err`/`isOk`/`isErr`). Throwing exceptions is only for internal implementation details that do not cross a package boundary (e.g. `safeRealpath`'s symlink-loop detection). Every public function that crosses a boundary returns a `Result`.
- Choose `IrohaError`'s `code` from `ERROR_CODES` in `packages/domain/src/errors/error-code.ts`. When a new code is needed, first check consistency with `implementation/mcp-contract.md` §4.
- **Do not include raw absolute paths, raw argument values, or credentials** in an error's `message`/`details`/`cause`. See [[secure-subprocess-and-credentials]] for details.
- **`JSON.stringify(irohaError)` does not include `message`/`cause`/`stack`** — `IrohaError` extends `Error`, and because `message`/`cause` are set with `enumerable: false` by the `Error` constructor, `JSON.stringify` only outputs `code`/`retryable`/`details` (the fields assigned directly). When you want to inspect the contents of `Result.error` in a test's failure assertion message, stringify it explicitly, like `` `${error.code}: ${error.message} (cause: ${String(error.cause)})` ``.

## Zod 4 (packages/domain, packages/config, etc.)

- When validating a boundary, **always use `.safeParse()`**. Do not use `.parse()` because it throws — this codebase does not allow exceptions to cross boundaries anywhere in the repository (the `Result<T, E>` policy in "Error handling" above). Branch on the `safeParse()` result with `if (!result.success)`, wrap it in an `IrohaError`, and return it as a `Result`.
- Schema variable names are `<name>Schema` (`actorRefSchema`, `scopeSchema`, etc.). For schemas that mirror the `$defs` of a JSON Schema, following the existing files in `packages/domain/src/schemas/*.ts`, attach a one-line docstring: `Mirrors schemas/<file>.schema.json \`$defs.<name>\``.
- **The schemas in `packages/domain/src/schemas/*.ts` are mirrors of the repo-root `schemas/*.schema.json` (JSON Schema)** (there used to be an identical copy under `docs/product/schemas/` as well, but ID-029 consolidated the repo root as the single source of truth). Fixing only one and leaving the other alone makes the runtime validation (Zod) and the contract documentation (JSON Schema) silently diverge. When adding or changing a schema, update both (the Zod `.ts` and `schemas/*.schema.json`) in the same commit. `pnpm test:contracts` (the `@iroha/domain` `*.contract.test.ts` files, run as their own task in CI) guards this: it validates a set of positive/negative fixtures against **both** the Zod schema and the committed JSON Schema (via AJV) and asserts they agree on accept/reject, so a change to one representation but not the other fails the contract gate. **The guard is fixture-based** — it only catches drift a fixture actually exercises, so when you add or change a constraint, add a fixture that covers it (a positive case and a targeted negative) alongside updating both representations. `pnpm test` excludes `*.contract.test.ts`; run `pnpm test:contracts` when you touch a schema (also listed in `CLAUDE.md`).
- Derive contract types (types of schemas that mirror a JSON Schema) via `type X = z.infer<typeof xSchema>`. Do not hand-write a separate `interface` and maintain it in two places — change the schema and the type follows automatically.
- Use `z.strictObject()` for object schemas (its intent is clearer than `.strict()`).
- Use `z.discriminatedUnion()` for discriminated unions.
- For date-times use `z.iso.datetime()`. Note that the default `offset: false` requires a literal uppercase `"Z"` terminator (to allow ISO strings with an offset, set `offset: true` explicitly).
- `.refine()`/`.superRefine()` return the same class in Zod 4 (unlike Zod 3's `ZodEffects` wrapping). Confirm that no type hole is introduced, including under `noUncheckedIndexedAccess`.
- When verifying a parse→serialize round-trip, compare structurally with `node:util`'s `isDeepStrictEqual` rather than by string/JSON comparison. An object reconstructed by Zod does not necessarily preserve the original key-insertion order, even if it is semantically identical.

## Parsing structured text

- When validating a structured format such as Markdown or YAML, do not make do with a hand-written regex parser. Use a real parser like `mdast-util-from-markdown` — a naive `#`-prefix regex falsely detects heading-like lines inside a fenced code block, but a real CommonMark AST parser correctly ignores them.

## Testing

- Use `vitest` with its CLI default configuration as-is (`vitest.config.ts` is not needed for now). Before adding a config file, consider whether the package really needs it.
- Do not mock external dependencies (actual subprocesses, the real filesystem). The tests in `packages/git` follow the policy of actually creating a temporary git repository to verify (consistent with `~/.claude/rules/testing.md`'s "keep mocking to a minimum").
- Before claiming "I confirmed that X happens", write a reproduction test that **actually goes red** on the pre-fix code. If it cannot be reproduced (e.g. behavior that depends on a different OS), state so explicitly in the test comment, commit message, and PR comment.

## Build

- `tsdown` (rolldown) handles the build, and `tsc` is for type-checking only (`noEmit: true`). tsdown reads tsconfig's `paths` automatically via rolldown, so path aliases (`apps/dashboard`) work with no additional configuration.
- TypeScript 7.0 (Corsa / the native compiler) has an experimental API. The `WARN` during the tsdown build is known.
