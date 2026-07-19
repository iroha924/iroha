import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CryptoRandomSource, FixedClock, makeTypedId } from "@iroha/domain";
import { afterEach, describe, expect, it } from "vitest";
import { scanCanonicalDirectory } from "./scan-canonical-directory.js";
import { writeCanonicalDocument } from "./write-canonical-document.js";

const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const repositoryId = makeTypedId("repo", clock, new CryptoRandomSource());
const sessionId = makeTypedId("ses", clock, new CryptoRandomSource());

interface TypeFixture {
  idPrefix: "ses" | "dec" | "rul" | "con" | "ins" | "inc" | "pat" | "rev";
  type: string;
  typeSpecificKey: string;
  typeSpecific: Record<string, unknown>;
  sections: string[];
}

// WP-04 acceptance criteria: "all canonical type round trips" — one fixture
// per canonical-schema.md §7 body template / schemas/canonical-v1.schema.json
// `$defs` entry, so every type is actually exercised through
// write→scan→parse, not just eyeballed as "the switch branch looks right."
const FIXTURES: TypeFixture[] = [
  {
    idPrefix: "ses",
    type: "session_summary",
    typeSpecificKey: "session",
    typeSpecific: { platforms: ["claude_code"], run_count: 1, outcome: "completed" },
    sections: [
      "Objective",
      "Outcome",
      "Changes",
      "Validation",
      "Decisions",
      "Unresolved",
      "References",
    ],
  },
  {
    idPrefix: "dec",
    type: "decision",
    typeSpecificKey: "decision",
    typeSpecific: { kind: "architecture" },
    sections: ["Context", "Decision", "Rationale", "Consequences", "Alternatives considered"],
  },
  {
    idPrefix: "rul",
    type: "rule",
    typeSpecificKey: "rule",
    typeSpecific: { enforcement: "advisory", severity: "info" },
    sections: ["Rule", "Scope", "Rationale", "Examples", "Exceptions"],
  },
  {
    idPrefix: "con",
    type: "concept",
    typeSpecificKey: "concept",
    typeSpecific: { domain: "storage" },
    sections: ["Definition", "Domain context", "Examples", "Related concepts"],
  },
  {
    idPrefix: "ins",
    type: "insight",
    typeSpecificKey: "insight",
    typeSpecific: { category: "implementation" },
    sections: ["Observation", "Evidence", "Implication", "Recommended action"],
  },
  {
    idPrefix: "inc",
    type: "incident",
    typeSpecificKey: "incident",
    typeSpecific: { severity: "low", resolution: "resolved" },
    sections: ["Summary", "Impact", "Timeline", "Root cause", "Resolution", "Prevention"],
  },
  {
    idPrefix: "pat",
    type: "pattern",
    typeSpecificKey: "pattern",
    typeSpecific: { maturity: "established" },
    sections: ["Problem", "Pattern", "When to use", "When not to use", "Examples"],
  },
  {
    idPrefix: "rev",
    type: "review_learning",
    typeSpecificKey: "review_learning",
    typeSpecific: { category: "correctness" },
    sections: ["Review finding", "Why it matters", "Resolution", "Generalized learning"],
  },
];

function bodyFor(title: string, sections: string[]): string {
  return [`# ${title}`, ...sections.flatMap((section) => [`## ${section}`, "", "Content."])].join(
    "\n\n",
  );
}

describe.each(FIXTURES)("canonical type round trip: $type", (fixture) => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("writes, is found by a directory scan, and re-parses to the same type", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "iroha-canonical-roundtrip-"));
    const id = makeTypedId(fixture.idPrefix, clock, new CryptoRandomSource());
    const title = `Round trip for ${fixture.type}`;
    const candidate = {
      frontmatter: {
        schema_version: 1,
        id,
        type: fixture.type,
        title,
        status: "approved",
        revision: 1,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        created_by: { provider: "git", display_name: "Example Developer" },
        approved_by: { provider: "git", display_name: "Example Reviewer" },
        approved_at: "2026-01-01T00:00:00.000Z",
        labels: [],
        scope: { repository: repositoryId, paths: [], symbols: [] },
        sources: [{ type: "session", ref: sessionId }],
        relations: [],
        [fixture.typeSpecificKey]: fixture.typeSpecific,
      },
      body: bodyFor(title, fixture.sections),
    };

    const written = await writeCanonicalDocument(candidate, tempDir, new CryptoRandomSource());
    expect(written.ok).toBe(true);

    const scan = await scanCanonicalDirectory(tempDir);
    expect(scan.ok).toBe(true);
    if (scan.ok) {
      expect(scan.value.errors).toEqual([]);
      expect(scan.value.entries.length).toBe(1);
      expect(scan.value.entries[0]?.document.frontmatter.type).toBe(fixture.type);
      expect(scan.value.entries[0]?.document.frontmatter.id).toBe(id);
    }
  });
});
