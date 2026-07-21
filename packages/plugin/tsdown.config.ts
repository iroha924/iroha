import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts", "src/build-archive-cli.ts"],
  format: "esm",
  platform: "node",
  dts: true,
  // Bundle the private `@iroha/*` workspace packages into the published binary
  // (only `@iroha-labs/iroha` is published — ID-011), and keep every npm
  // dependency external. The npm deps are declared in this package's
  // `dependencies`, so `npm install` resolves them — including the native
  // `@libsql/client` binding, which cannot be inlined into a single `.mjs`
  // (decision-log ID-038, Option A).
  deps: {
    alwaysBundle: [/^@iroha\//],
  },
});
