import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./build-archive.js";
import {
  buildClaudeMarketplace,
  buildCodexMarketplace,
  claudeMarketplaceSchema,
  codexMarketplaceSchema,
} from "./manifests.js";
import { PUBLISHED_PACKAGE_NAME } from "./metadata.js";

async function readCommitted(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(join(REPO_ROOT, relativePath), "utf8"));
}

describe("marketplace generators produce schema-valid output", () => {
  it("Claude marketplace", () => {
    expect(claudeMarketplaceSchema.safeParse(buildClaudeMarketplace()).success).toBe(true);
  });

  it("Codex marketplace", () => {
    expect(codexMarketplaceSchema.safeParse(buildCodexMarketplace()).success).toBe(true);
  });

  it("both resolve the plugin from the published npm package", () => {
    const claude = buildClaudeMarketplace() as { plugins: [{ source: { package: string } }] };
    const codex = buildCodexMarketplace() as { plugins: [{ source: { package: string } }] };
    expect(claude.plugins[0].source.package).toBe(PUBLISHED_PACKAGE_NAME);
    expect(codex.plugins[0].source.package).toBe(PUBLISHED_PACKAGE_NAME);
  });
});

describe("committed marketplaces are in sync with the generators", () => {
  it("Claude .claude-plugin/marketplace.json matches generator output", async () => {
    expect(await readCommitted(".claude-plugin/marketplace.json")).toEqual(
      buildClaudeMarketplace(),
    );
  });

  it("Codex .agents/plugins/marketplace.json matches generator output", async () => {
    expect(await readCommitted(".agents/plugins/marketplace.json")).toEqual(
      buildCodexMarketplace(),
    );
  });
});
