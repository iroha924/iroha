import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodegenConfig } from "@graphql-codegen/cli";

/**
 * Offline typed-GraphQL codegen for the GitHub provider. The schema is read from
 * the committed SDL that `@octokit/graphql-schema` ships (no network), and typed
 * operations are generated from `src/queries/**.graphql` into a single committed
 * module. `documentMode: "string"` emits each operation as a branded query
 * string so the runtime needs no `graphql`/`print()` — it is passed straight to
 * `octokit.graphql`. Regenerate with `pnpm --filter @iroha/forge-github codegen`.
 */
// `@octokit/graphql-schema`'s `exports` map exposes only the `import` condition
// (no `require`, no `./package.json`), so it cannot be located via
// `require.resolve`. Read the committed SDL directly through pnpm's per-package
// symlink, anchored to this config file's directory so cwd does not matter.
const packageDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(packageDir, "node_modules/@octokit/graphql-schema/schema.graphql");

const config: CodegenConfig = {
  schema: schemaPath,
  documents: "src/queries/**/*.graphql",
  generates: {
    "src/generated/graphql.ts": {
      // No `typescript` base plugin: `preResolveTypes` inlines scalar/enum types
      // straight into the two operation types, so the committed file stays small
      // instead of dumping every one of GitHub's hundreds of schema enums.
      plugins: ["typescript-operations", "typed-document-node"],
      config: {
        documentMode: "string",
        preResolveTypes: true,
        enumsAsTypes: true,
        skipTypename: true,
        useTypeImports: true,
        scalars: { DateTime: "string", URI: "string" },
      },
    },
  },
};

// biome-ignore lint/style/noDefaultExport: graphql-codegen loads its config from the module's default export.
export default config;
