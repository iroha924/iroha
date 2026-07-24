import { CryptoRandomSource, FixedClock, makeTypedId } from "@iroha/domain";
import { closeDatabase, insertEntity, openDatabase, upsertKnowledgeItem } from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { setupMcpRepo } from "../test-helpers/mcp-repo.js";
import { removeTempDir } from "../test-helpers/tmp-repo.js";
import { mcpGetActiveRules } from "./get-active-rules.js";

const T0 = new Date("2026-01-01T00:00:00.000Z");

describe("mcpGetActiveRules", () => {
  const clock = new FixedClock(T0);
  const random = new CryptoRandomSource();
  let repoDir: string | undefined;

  afterEach(async () => {
    if (repoDir) {
      await removeTempDir(repoDir);
      repoDir = undefined;
    }
  });

  it("returns approved rules and honours simplified scope matching", async () => {
    const repo = await setupMcpRepo(random);
    repoDir = repo.repoDir;
    const iso = T0.toISOString();
    const ruleId = makeTypedId("rul", clock, random);

    const db = await openDatabase(repo.dbPath);
    if (!db.ok) throw new Error("open failed");
    await insertEntity(db.value, {
      id: ruleId,
      repositoryId: repo.repositoryId,
      entityType: "rule",
      title: "Validate all input",
      summary: "Always validate at boundaries",
      status: "approved",
      authority: 90,
      sourceKind: "canonical",
      createdAt: iso,
      updatedAt: iso,
    });
    await upsertKnowledgeItem(db.value, {
      id: ruleId,
      knowledgeType: "rule",
      body: "Validate every external boundary.",
      scopeJson: JSON.stringify({ paths: ["src/**"], symbols: [] }),
      enforcement: "advisory",
      severity: "warning",
    });
    await closeDatabase(db.value);

    const all = await mcpGetActiveRules({ cwd: repo.repoDir, clock, random });
    expect(all.ok).toBe(true);
    if (all.ok) {
      expect(all.value.rules.map((r) => r.id)).toContain(ruleId);
      expect(all.value.rules[0]?.enforcement).toBe("advisory");
      expect(all.value.rules[0]?.severity).toBe("warning");
      expect(all.value.rules[0]?.explanation).toBe("Always validate at boundaries");
    }

    const scoped = await mcpGetActiveRules({
      cwd: repo.repoDir,
      clock,
      random,
      paths: ["src/app.ts"],
    });
    expect(scoped.ok).toBe(true);
    if (scoped.ok) expect(scoped.value.rules.map((r) => r.id)).toContain(ruleId);

    const offScope = await mcpGetActiveRules({
      cwd: repo.repoDir,
      clock,
      random,
      paths: ["docs/readme.md"],
    });
    expect(offScope.ok).toBe(true);
    if (offScope.ok) expect(offScope.value.rules.map((r) => r.id)).not.toContain(ruleId);
  }, 15000);
});
