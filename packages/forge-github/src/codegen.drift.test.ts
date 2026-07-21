import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards that the committed generated module is in sync with the `.graphql`
 * sources without re-running codegen: each operation's body (with GraphQL's
 * insignificant whitespace and commas removed) must appear verbatim inside the
 * generated `TypedDocumentString`s. If a query is edited without regenerating,
 * this fails — run `pnpm --filter @iroha/forge-github codegen`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const queriesDir = join(here, "queries");
const generatedPath = join(here, "generated", "graphql.ts");

/** Strip GraphQL's insignificant tokens (whitespace + commas) for comparison. */
function normalizeGraphql(source: string): string {
  return source.replace(/[\s,]+/g, "");
}

describe("generated GraphQL is in sync with the query sources", () => {
  const generated = normalizeGraphql(readFileSync(generatedPath, "utf8"));
  const queryFiles = readdirSync(queriesDir).filter((file) => file.endsWith(".graphql"));

  it("finds at least one query source", () => {
    expect(queryFiles.length).toBeGreaterThan(0);
  });

  for (const file of queryFiles) {
    it(`embeds the ${file} operation (run the codegen script if this fails)`, () => {
      const source = normalizeGraphql(readFileSync(join(queriesDir, file), "utf8"));
      expect(generated).toContain(source);
    });
  }
});
