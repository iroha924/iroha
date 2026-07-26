import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts", "src/build-archive-cli.ts", "src/build-release-cli.ts"],
  format: "esm",
  platform: "node",
  dts: true,
  // Bundle the private `@iroha/*` workspace packages into the published binary
  // (only `@irohalabs/iroha` is published), and keep every npm
  // dependency external. The npm deps are declared in this package's
  // `dependencies`, so `npm install` resolves them — including the native
  // `@libsql/client` binding, which cannot be inlined into a single `.mjs`
  // (Option A, the bundled-binary distribution strategy).
  deps: {
    alwaysBundle: [/^@iroha\//],
  },
});
