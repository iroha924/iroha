---
paths:
  - "packages/*/src/**/*.ts"
  - "packages/*/*.ts"
  - "apps/*/src/**/*.ts"
  - "apps/*/src/**/*.tsx"
  - "apps/*/*.ts"
  - "apps/e2e/tests/**/*.ts"
  - "schemas/*.schema.json"
  - "docs/contracts/compatibility.md"
  - "biome.json"
---

# TypeScript / Zod / Node conventions (iroha)

Implementation conventions specific to this repository. Not general TS practices — only the ways of writing that have actually been verified in this monorepo.

## Module resolution

- `packages/*` inherit `module`/`moduleResolution: "nodenext"` from `tsconfig.base.json`. Relative imports **must be written with a `.js` extension** (`./foo.js`; the source may be `.ts` — TypeScript resolves it to the source via `file extension substitution`, an official specification since Node16/NodeNext). `apps/dashboard` uses `moduleResolution: "bundler"`, so the `.js` extension is not required.
- `path.resolve`/`path.join` **collapse `..` lexically internally** (before resolving symlinks). Never use them on untrusted/externally-sourced strings that may contain `..`. See [[path-and-symlink-safety]] for details.
- The inter-package dependency boundaries (`contracts/compatibility.md` §4 "which package may depend on which package") are **mechanically enforced** by the `overrides` in `biome.json` (per-package `noRestrictedImports`). Writing a disallowed `@iroha/*` import makes `pnpm lint` fail with an error, and the message includes the allowed dependency targets. There is no need to check the §4 table by hand — just run `pnpm lint` and you will know. When changing §4 itself, update the corresponding override in `biome.json` in the same commit.

## Type definitions

- Use `interface` for object-shape types (not `type`). `biome.json`'s `useConsistentTypeDefinitions` enforces this.
- Exception: contract types derived via `z.infer<typeof xxxSchema>` (described below) stay as `type` (`interface` cannot directly express the result of a type operation). In this case `type` is not a rule violation but the only way to write it.
- Use named exports only. Do not use default exports (`biome.json`'s `noDefaultExport` enforces this).
- File names are kebab-case (`biome.json`'s `useFilenamingConvention` enforces this for `packages/*/src/**`. `apps/dashboard` is excluded because React components have a PascalCase convention).
- When matching a **discriminated union** and every variant must be handled (a renderer, a dispatcher, a normalizer), prefer `ts-pattern`'s `match(x).with({ kind: … }, …).exhaustive()` over a bare `switch`: `.exhaustive()` turns "a new variant was added but not handled here" into a **compile error** instead of a silent `undefined` fall-through, and each `.with` narrows the value to that variant. Example: `renderClaudeOutput`/`renderCodexOutput` in `packages/adapter-*`. A `switch` with a genuine `default` (e.g. `contextEventName`, which maps only two kinds and ignores the rest) does not need this and stays a `switch`.

## Error handling

- Use `@iroha/domain`'s `Result<T, E>` type (`ok`/`err`/`isOk`/`isErr`). Throwing exceptions is only for internal implementation details that do not cross a package boundary (e.g. `safeRealpath`'s symlink-loop detection). Every public function that crosses a boundary returns a `Result`.
- Choose `IrohaError`'s `code` from `ERROR_CODES` in `packages/domain/src/errors/error-code.ts`. When a new code is needed, first check consistency with `contracts/mcp.md` §4.
- **Do not include raw absolute paths, raw argument values, or credentials** in an error's `message`/`details`/`cause`. See [[secure-subprocess-and-credentials]] for details.
- **`JSON.stringify(irohaError)` does not include `message`/`cause`/`stack`** — `IrohaError` extends `Error`, and because `message`/`cause` are set with `enumerable: false` by the `Error` constructor, `JSON.stringify` only outputs `code`/`retryable`/`details` (the fields assigned directly). When you want to inspect the contents of `Result.error` in a test's failure assertion message, stringify it explicitly, like `` `${error.code}: ${error.message} (cause: ${String(error.cause)})` ``.

## Zod 4 (packages/domain, packages/config, etc.)

- When validating a boundary, **always use `.safeParse()`**. Do not use `.parse()` because it throws — this codebase does not allow exceptions to cross boundaries anywhere in the repository (the `Result<T, E>` policy in "Error handling" above). Branch on the `safeParse()` result with `if (!result.success)`, wrap it in an `IrohaError`, and return it as a `Result`.
- Schema variable names are `<name>Schema` (`actorRefSchema`, `scopeSchema`, etc.). For schemas that mirror the `$defs` of a JSON Schema, following the existing files in `packages/domain/src/schemas/*.ts`, attach a one-line docstring: `Mirrors schemas/<file>.schema.json \`$defs.<name>\``.
- **The schemas in `packages/domain/src/schemas/*.ts` are mirrors of the repo-root `schemas/*.schema.json` (JSON Schema)** (the repo root is the single source of truth; an older duplicate under `docs/schemas/` was removed). Fixing only one and leaving the other alone makes the runtime validation (Zod) and the contract documentation (JSON Schema) silently diverge. When adding or changing a schema, update both (the Zod `.ts` and `schemas/*.schema.json`) in the same commit. `pnpm test:contracts` (the `@iroha/domain` `*.contract.test.ts` files, run as their own task in CI) guards this: it validates a set of positive/negative fixtures against **both** the Zod schema and the committed JSON Schema (via AJV) and asserts they agree on accept/reject, so a change to one representation but not the other fails the contract gate. **The guard is fixture-based** — it only catches drift a fixture actually exercises, so when you add or change a constraint, add a fixture that covers it (a positive case and a targeted negative) alongside updating both representations. `pnpm test` excludes `*.contract.test.ts`; run `pnpm test:contracts` when you touch a schema (also listed in `CLAUDE.md`).
- Derive contract types (types of schemas that mirror a JSON Schema) via `type X = z.infer<typeof xSchema>`. Do not hand-write a separate `interface` and maintain it in two places — change the schema and the type follows automatically.
- Use `z.strictObject()` for object schemas (its intent is clearer than `.strict()`).
- Use `z.discriminatedUnion()` for discriminated unions.
- For date-times use `z.iso.datetime()`. Note that the default `offset: false` requires a literal uppercase `"Z"` terminator (to allow ISO strings with an offset, set `offset: true` explicitly).
- `.refine()`/`.superRefine()` return the same class in Zod 4 (unlike Zod 3's `ZodEffects` wrapping). Confirm that no type hole is introduced, including under `noUncheckedIndexedAccess`.
- When verifying a parse→serialize round-trip, compare structurally with `node:util`'s `isDeepStrictEqual` rather than by string/JSON comparison. An object reconstructed by Zod does not necessarily preserve the original key-insertion order, even if it is semantically identical.

## Parsing structured text

- When validating a structured format such as Markdown or YAML, do not make do with a hand-written regex parser. Use a real parser like `mdast-util-from-markdown` — a naive `#`-prefix regex falsely detects heading-like lines inside a fenced code block, but a real CommonMark AST parser correctly ignores them.

## HTTP API routes (`packages/api`)

The dashboard API is built with **`@hono/zod-openapi`** (`OpenAPIHono` + `createRoute`): each route declares its Zod request schema, and `GET /api/doc` serves the generated OpenAPI 3.1 document. When adding or changing a route, follow the patterns already in `app.ts` (they encode constraints that are non-obvious and were verified against the tests):

- **Import `z` from `@hono/zod-openapi`**, not `zod` — it is the same Zod 4 instance extended with `.openapi()` for OpenAPI metadata. Route paths use `{id}` (OpenAPI style), not `:id`; declare each path param in `request.params`.
- **Handlers return `never`.** Every endpoint answers through the shared success/failure envelope whose HTTP status is chosen at runtime from the use-case error code — a dynamic status the literal-typed `responses` union cannot express. `respond()`/`ok()`/`fail()` cast the `Response` to `never` in one place so `.openapi()`'s compile-time response check passes and each handler stays free of per-route response typing. The SPA reads this runtime envelope (`apps/dashboard/src/api/client.ts`), not Hono RPC response types, so `AppType` precision does not matter. `responses` in `createRoute` is **documentation only** (not validated at runtime); document the whole error set with a `default` response, since `respond()` emits 403/404/409/500/503 beyond the explicit 400/401.
- **Two validation paths bypass `defaultHook`; both must reach the envelope.** Body/param/query Zod failures go through the app-level `defaultHook` (which rebuilds the `fieldErrors` envelope, a 400). But a body that is not parseable JSON is rejected by `@hono/zod-openapi`'s validator with a thrown `HTTPException(400)` **before** `defaultHook` runs, so `app.onError` must special-case `HTTPException` → the 400 `INVALID_INPUT` envelope (else it collapses to a 500 and the SPA client, which reads `json.error.code`, throws). A missing mutation header is caught earlier still by the `antiCsrf` middleware (403).
- **Body validation is strict; query validation must stay lenient.** Query params must **not** 400 on a bad value (`?from=not-a-date` lists unfiltered — there is a test), and a duplicated scalar param (`?limit=1&limit=2`) must not 400 either. Hono hands a repeated param back as an **array**, so a plain `z.string()` rejects it; and `.catch(undefined)` (the natural "drop invalid") makes the OpenAPI generator throw `Unknown zod object type`. So declare every scalar query param as `z.union([z.string(), z.array(z.string())]).optional()`, read the first value with the `firstOf` helper, and drop anything invalid with the lenient helpers (`numOpt`/`isoOpt`/`enumOpt`). A **repeatable** filter whose every value matters (like `knowledge` `status`/`type`) is instead read via `c.req.queries()` and documented in the route `description`. A **required** query pair with a custom error (`graph/path` `from`/`to`) is read by hand.
- **Document the anti-CSRF header on every mutation.** Enforcement is the `antiCsrf` middleware, but a client generated from `/api/doc` must know to send `X-Iroha-Request: 1`, so each state-changing route declares it via `request.headers` (the `withCsrf` helper) — otherwise the generated client 403s.

## Testing

- Use `vitest` with its CLI default configuration as-is (`vitest.config.ts` is not needed for now). Before adding a config file, consider whether the package really needs it.
- Do not mock external dependencies (actual subprocesses, the real filesystem). The tests in `packages/git` follow the policy of actually creating a temporary git repository to verify (consistent with `~/.claude/rules/testing.md`'s "keep mocking to a minimum").
- Before claiming "I confirmed that X happens", write a reproduction test that **actually goes red** on the pre-fix code. If it cannot be reproduced (e.g. behavior that depends on a different OS), state so explicitly in the test comment, commit message, and PR comment.
- For an invariant that must hold over a large or open-ended input space — a parse↔serialize round-trip, a refactor that must match a reference implementation, a redaction that must never miss a shape — prefer a **`fast-check` property test** over a hand-written enumeration: it generates inputs (including lengths an enumeration can't reach) and **shrinks a failure to a minimal reproducer**. Example: `packages/git/src/credential-redaction.test.ts` asserts `schemeStartIndices` equals the original unbounded regex over generated `scheme://`-ish strings. Build the input from a focused alphabet with `fc.array(fc.constantFrom(...)).map((cs) => cs.join(""))` (version-stable across fast-check majors), and set an explicit `numRuns` so the run is bounded and deterministic. A property test complements, and does not replace, the targeted reproduction test above.

## Build

- `tsdown` (rolldown) handles the build, and `tsc` is for type-checking only (`noEmit: true`). tsdown reads tsconfig's `paths` automatically via rolldown, so path aliases (`apps/dashboard`) work with no additional configuration.
- TypeScript 7.0 (Corsa / the native compiler) has an experimental API. The `WARN` during the tsdown build is known.
