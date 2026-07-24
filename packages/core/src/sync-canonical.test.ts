import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeCanonicalDocument } from "@iroha/canonical";
import { CryptoRandomSource, FixedClock, makeTypedId } from "@iroha/domain";
import {
  closeDatabase,
  type Database,
  getCanonicalDocumentByEntityId,
  getEntityById,
  getKnowledgeItemById,
  getNeighbors,
  getSearchDocumentByEntityId,
  insertRelation,
  insertRepository,
  listApprovedRulesForRepository,
  listOpenDirtyMarkers,
} from "@iroha/storage";
import { afterEach, describe, expect, it } from "vitest";
import { syncCanonicalToDatabase } from "./sync-canonical.js";
import { openMigratedTestDb, removeTempDir } from "./test-helpers/tmp-db.js";

const CLOCK = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const REPOSITORY_ID = makeTypedId("repo", CLOCK, new CryptoRandomSource());

function decisionCandidate(id: string, title: string, revision: number, relations: unknown[] = []) {
  return {
    frontmatter: {
      schema_version: 1,
      id,
      type: "decision",
      title,
      status: "approved",
      revision,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      created_by: { provider: "git", display_name: "Example Developer" },
      approved_by: { provider: "git", display_name: "Example Reviewer" },
      approved_at: "2026-01-01T00:00:00.000Z",
      labels: [],
      scope: { repository: REPOSITORY_ID, paths: [], symbols: ["fooBar"] },
      sources: [{ type: "url", ref: "https://example.com" }],
      relations,
      decision: { kind: "architecture" },
    },
    body: [
      `# ${title}`,
      "## Context",
      "",
      "Context.",
      "## Decision",
      "",
      "Decision.",
      "## Rationale",
      "",
      "Rationale.",
      "## Consequences",
      "",
      "Consequences.",
      "## Alternatives considered",
      "",
      "None.",
    ].join("\n\n"),
  };
}

interface RuleSpec {
  enforcement: "advisory" | "guardrail";
  severity: "info" | "warning" | "error";
  guard?: { tools: string[]; paths: string[]; deny_commands?: string[] };
}

function ruleCandidate(id: string, title: string, rule: RuleSpec) {
  return {
    frontmatter: {
      schema_version: 1,
      id,
      type: "rule",
      title,
      status: "approved",
      revision: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      created_by: { provider: "git", display_name: "Example Developer" },
      approved_by: { provider: "git", display_name: "Example Reviewer" },
      approved_at: "2026-01-01T00:00:00.000Z",
      labels: [],
      scope: { repository: REPOSITORY_ID, paths: rule.guard?.paths ?? [], symbols: [] },
      sources: [{ type: "url", ref: "https://example.com" }],
      relations: [],
      rule,
    },
    body: [
      `# ${title}`,
      "## Rule",
      "",
      "Do not edit generated files by hand.",
      "## Scope",
      "",
      "Applies under src/generated/**.",
      "## Rationale",
      "",
      "Generated files are overwritten on the next build.",
      "## Examples",
      "",
      "None.",
      "## Exceptions",
      "",
      "None.",
    ].join("\n\n"),
  };
}

describe("syncCanonicalToDatabase", () => {
  let tempDir: string | undefined;
  let canonicalDir: string | undefined;
  let db: Database | undefined;
  const repositoryId = REPOSITORY_ID;

  afterEach(async () => {
    if (db) {
      await closeDatabase(db);
      db = undefined;
    }
    if (tempDir) {
      await removeTempDir(tempDir);
      tempDir = undefined;
    }
  });

  async function setup(): Promise<void> {
    const opened = await openMigratedTestDb();
    tempDir = opened.dir;
    db = opened.db;
    canonicalDir = join(tempDir, ".iroha");
    await mkdir(canonicalDir, { recursive: true });
    const inserted = await insertRepository(db, {
      id: repositoryId,
      rootFingerprint: "fp-sync",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    if (!inserted.ok) {
      throw new Error(`failed to seed repository: ${inserted.error.message}`);
    }
  }

  it("imports a newly added canonical document", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    const id = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    const written = await writeCanonicalDocument(
      decisionCandidate(id, "Use libSQL", 1),
      canonicalDir,
      new CryptoRandomSource(),
    );
    expect(written.ok).toBe(true);

    const result = await syncCanonicalToDatabase(
      db,
      repositoryId,
      canonicalDir,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ added: 1, changed: 0, unchanged: 0, deleted: 0 });
    }

    const entity = await getEntityById(db, id);
    expect(entity.ok).toBe(true);
    if (entity.ok) {
      expect(entity.value?.authority).toBe(100);
      expect(entity.value?.entityType).toBe("decision");
    }
    const canonicalDoc = await getCanonicalDocumentByEntityId(db, id);
    expect(canonicalDoc.ok).toBe(true);
    if (canonicalDoc.ok) {
      expect(canonicalDoc.value?.revision).toBe(1);
    }
    const searchDoc = await getSearchDocumentByEntityId(db, id);
    expect(searchDoc.ok).toBe(true);
    if (searchDoc.ok) {
      expect(searchDoc.value?.codeTerms).toBe("fooBar");
    }
  });

  it("projects approved rules and decisions into knowledge_items (WP-10, ID-033)", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    const advisoryId = makeTypedId("rul", CLOCK, new CryptoRandomSource());
    const guardrailId = makeTypedId("rul", CLOCK, new CryptoRandomSource());
    const decisionId = makeTypedId("dec", CLOCK, new CryptoRandomSource());

    await writeCanonicalDocument(
      ruleCandidate(advisoryId, "Prefer the repository pattern", {
        enforcement: "advisory",
        severity: "warning",
      }),
      canonicalDir,
      new CryptoRandomSource(),
    );
    await writeCanonicalDocument(
      ruleCandidate(guardrailId, "Do not edit generated files", {
        enforcement: "guardrail",
        severity: "error",
        guard: { tools: ["Edit", "Write"], paths: ["src/generated/**"] },
      }),
      canonicalDir,
      new CryptoRandomSource(),
    );
    await writeCanonicalDocument(
      decisionCandidate(decisionId, "Use libSQL", 1),
      canonicalDir,
      new CryptoRandomSource(),
    );

    const result = await syncCanonicalToDatabase(
      db,
      repositoryId,
      canonicalDir,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);

    // A Decision projects as an advisory knowledge item (no guard).
    const decisionItem = await getKnowledgeItemById(db, decisionId);
    expect(decisionItem.ok).toBe(true);
    if (decisionItem.ok && decisionItem.value) {
      expect(decisionItem.value.enforcement).toBe("advisory");
      expect(decisionItem.value.guardSpecJson).toBeNull();
    }

    // A guardrail Rule carries its machine-evaluable guard spec verbatim.
    const guardrailItem = await getKnowledgeItemById(db, guardrailId);
    expect(guardrailItem.ok).toBe(true);
    if (guardrailItem.ok && guardrailItem.value) {
      expect(guardrailItem.value.enforcement).toBe("guardrail");
      expect(guardrailItem.value.guardSpecJson).not.toBeNull();
      expect(JSON.parse(guardrailItem.value.guardSpecJson as string)).toEqual({
        tools: ["Edit", "Write"],
        paths: ["src/generated/**"],
      });
      expect(guardrailItem.value.canonicalPath).toContain(`${guardrailId}.md`);
    }

    // Both rules are visible as approved rules (SessionStart / get_active_rules).
    const rules = await listApprovedRulesForRepository(db, repositoryId);
    expect(rules.ok).toBe(true);
    if (rules.ok) {
      expect(rules.value.map((row) => row.id).sort()).toEqual([advisoryId, guardrailId].sort());
      // #30: the Rule's frontmatter severity survives the projection.
      const bySeverity = new Map(rules.value.map((row) => [row.id, row.severity]));
      expect(bySeverity.get(advisoryId)).toBe("warning");
      expect(bySeverity.get(guardrailId)).toBe("error");
    }
  });

  it("is a no-op on a second sync with no on-disk changes", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    const id = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    await writeCanonicalDocument(
      decisionCandidate(id, "Use libSQL", 1),
      canonicalDir,
      new CryptoRandomSource(),
    );
    await syncCanonicalToDatabase(db, repositoryId, canonicalDir, CLOCK, new CryptoRandomSource());

    const second = await syncCanonicalToDatabase(
      db,
      repositoryId,
      canonicalDir,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value).toMatchObject({ added: 0, changed: 0, unchanged: 1 });
    }
  });

  it("re-imports a document whose revision changed", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    const id = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    await writeCanonicalDocument(
      decisionCandidate(id, "Use libSQL", 1),
      canonicalDir,
      new CryptoRandomSource(),
    );
    await syncCanonicalToDatabase(db, repositoryId, canonicalDir, CLOCK, new CryptoRandomSource());

    await writeCanonicalDocument(
      decisionCandidate(id, "Use libSQL v2", 2),
      canonicalDir,
      new CryptoRandomSource(),
    );
    const result = await syncCanonicalToDatabase(
      db,
      repositoryId,
      canonicalDir,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ added: 0, changed: 1, unchanged: 0 });
    }
    const canonicalDoc = await getCanonicalDocumentByEntityId(db, id);
    expect(canonicalDoc.ok).toBe(true);
    if (canonicalDoc.ok) {
      expect(canonicalDoc.value?.revision).toBe(2);
    }
  });

  it("resolves a relation between two documents synced in the same pass", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    const idA = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    const idB = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    await writeCanonicalDocument(
      decisionCandidate(idB, "Decision B", 1),
      canonicalDir,
      new CryptoRandomSource(),
    );
    await writeCanonicalDocument(
      decisionCandidate(idA, "Decision A", 1, [{ type: "RELATED_TO", target: idB }]),
      canonicalDir,
      new CryptoRandomSource(),
    );

    const result = await syncCanonicalToDatabase(
      db,
      repositoryId,
      canonicalDir,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.unresolvedRelations).toBe(0);
    }
  });

  it("prunes a canonical edge removed on re-sync but keeps other-source edges", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    const idA = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    const idB = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    const idC = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    for (const [id, title] of [
      [idB, "Decision B"],
      [idC, "Decision C"],
    ] as const) {
      await writeCanonicalDocument(
        decisionCandidate(id, title, 1),
        canonicalDir,
        new CryptoRandomSource(),
      );
    }
    // A relates to both B and C.
    await writeCanonicalDocument(
      decisionCandidate(idA, "Decision A", 1, [
        { type: "RELATED_TO", target: idB },
        { type: "RELATED_TO", target: idC },
      ]),
      canonicalDir,
      new CryptoRandomSource(),
    );
    await syncCanonicalToDatabase(db, repositoryId, canonicalDir, CLOCK, new CryptoRandomSource());

    // A human-sourced edge from A must survive the canonical prune.
    const humanEdge = await insertRelation(db, {
      id: makeTypedId("rel", CLOCK, new CryptoRandomSource()),
      repositoryId,
      fromEntityId: idA,
      relationType: "RELATED_TO",
      toEntityId: idC,
      sourceKind: "human",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(humanEdge.ok).toBe(true);

    // Re-sync A at a higher revision with C removed from its relations.
    await writeCanonicalDocument(
      decisionCandidate(idA, "Decision A", 2, [{ type: "RELATED_TO", target: idB }]),
      canonicalDir,
      new CryptoRandomSource(),
    );
    await syncCanonicalToDatabase(db, repositoryId, canonicalDir, CLOCK, new CryptoRandomSource());

    const neighbors = await getNeighbors(db, idA, { direction: "outgoing" });
    expect(neighbors.ok).toBe(true);
    if (!neighbors.ok) return;
    const edges = neighbors.value.map((r) => `${r.sourceKind}:${r.toEntityId}`);
    expect(edges).toContain(`canonical:${idB}`); // still declared → re-inserted
    expect(edges).not.toContain(`canonical:${idC}`); // removed → pruned
    expect(edges).toContain(`human:${idC}`); // other source → untouched
  });

  it("tiers authority below 100 by lifecycle status, at or above the search floor", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    // Both non-approved tiers stay >= DEFAULT_MINIMUM_AUTHORITY (60) so they are
    // not excluded from default search after the candidate cap; they rank lower
    // only via the missing 80+ boost.
    for (const [status, expected] of [
      ["superseded", 70],
      ["archived", 60],
    ] as const) {
      const id = makeTypedId("dec", CLOCK, new CryptoRandomSource());
      const doc = decisionCandidate(id, `${status} decision`, 1);
      doc.frontmatter.status = status;
      await writeCanonicalDocument(doc, canonicalDir, new CryptoRandomSource());
      await syncCanonicalToDatabase(
        db,
        repositoryId,
        canonicalDir,
        CLOCK,
        new CryptoRandomSource(),
      );

      const entity = await getEntityById(db, id);
      expect(entity.ok && entity.value?.authority, `entity authority for ${status}`).toBe(expected);
      const searchDoc = await getSearchDocumentByEntityId(db, id);
      expect(searchDoc.ok && searchDoc.value?.authority, `sdoc authority for ${status}`).toBe(
        expected,
      );
    }
  });

  it("records a dirty marker for a relation whose target does not exist locally", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    const idA = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    const missingTarget = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    await writeCanonicalDocument(
      decisionCandidate(idA, "Decision A", 1, [{ type: "RELATED_TO", target: missingTarget }]),
      canonicalDir,
      new CryptoRandomSource(),
    );

    const result = await syncCanonicalToDatabase(
      db,
      repositoryId,
      canonicalDir,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.unresolvedRelations).toBe(1);
    }
    const markers = await listOpenDirtyMarkers(db, repositoryId, "sync_required");
    expect(markers.ok).toBe(true);
    if (markers.ok) {
      expect(markers.value.length).toBe(1);
    }
  });

  it("tombstones the entity for a deleted canonical file", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    const id = makeTypedId("dec", CLOCK, new CryptoRandomSource());
    const written = await writeCanonicalDocument(
      decisionCandidate(id, "Use libSQL", 1),
      canonicalDir,
      new CryptoRandomSource(),
    );
    expect(written.ok).toBe(true);
    await syncCanonicalToDatabase(db, repositoryId, canonicalDir, CLOCK, new CryptoRandomSource());
    if (written.ok) {
      await rm(written.value.path);
    }

    const result = await syncCanonicalToDatabase(
      db,
      repositoryId,
      canonicalDir,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deleted).toBe(1);
    }
    const entity = await getEntityById(db, id);
    expect(entity.ok).toBe(true);
    if (entity.ok) {
      expect(entity.value?.status).toBe("tombstoned");
    }
  });

  it("records a dirty marker for a malformed file without aborting the sync", async () => {
    await setup();
    if (!db || !canonicalDir) return;
    await mkdir(join(canonicalDir, "decisions"), { recursive: true });
    await writeFile(
      join(canonicalDir, "decisions", "dec_broken.md"),
      "not valid frontmatter at all",
      "utf8",
    );

    const result = await syncCanonicalToDatabase(
      db,
      repositoryId,
      canonicalDir,
      CLOCK,
      new CryptoRandomSource(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.scanErrors).toBe(1);
    }
    const markers = await listOpenDirtyMarkers(db, repositoryId, "canonical_db_divergence");
    expect(markers.ok).toBe(true);
    if (markers.ok) {
      expect(markers.value.length).toBe(1);
    }
  });
});
