import { FixedClock, FixedRandomSource, makeTypedId } from "@iroha/domain";
import { describe, expect, it } from "vitest";
import { validateBodyForType, validateBodyTemplate } from "./body-template.js";
import { parseCanonicalDocument } from "./parse-canonical-document.js";

const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const random = new FixedRandomSource(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
const decisionId = makeTypedId("dec", clock, random);
const repositoryId = makeTypedId("repo", clock, random);
const sessionId = makeTypedId("ses", clock, random);

function decisionDocument(body: string): string {
  return `---
schema_version: 1
id: ${decisionId}
type: decision
title: Use libSQL as the local index
status: approved
revision: 1
created_at: 2026-01-01T00:00:00.000Z
updated_at: 2026-01-01T00:00:00.000Z
created_by:
  provider: git
  display_name: Example Developer
approved_by:
  provider: git
  display_name: Example Reviewer
approved_at: 2026-01-01T00:00:00.000Z
labels: []
scope:
  repository: ${repositoryId}
  paths: []
  symbols: []
sources:
  - type: session
    ref: ${sessionId}
relations: []
decision:
  kind: architecture
---

${body}
`;
}

const validBody = `# Use libSQL as the local index

## Context

Some context.

## Decision

Use libSQL.

## Rationale

Reasons.

## Consequences

Effects.

## Alternatives considered

Other options.`;

function parseOrThrow(content: string) {
  const result = parseCanonicalDocument(content);
  if (!result.ok) {
    throw new Error(`fixture failed to parse: ${result.error.message}`);
  }
  return result.value;
}

describe("validateBodyForType", () => {
  const ruleBody = (h1: string) =>
    [
      h1,
      "",
      "## Rule",
      "x",
      "",
      "## Scope",
      "x",
      "",
      "## Rationale",
      "x",
      "",
      "## Examples",
      "x",
      "",
      "## Exceptions",
      "x",
    ].join("\n");

  // Equality is exact. A Markdown heading cannot carry surrounding whitespace, so
  // a padded title has no writable H1 — which is why the padding is removed where
  // the title is written (`checkpointInputSchema`) rather than tolerated here.
  // Trimming here instead would publish a document whose frontmatter and H1 differ.
  it("rejects a padded title rather than quietly accepting a different H1", () => {
    const result = validateBodyForType("rule", "  Padded title ", ruleBody("# Padded title"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("must equal the title");
  });

  it("accepts the same title once the padding is gone", () => {
    expect(validateBodyForType("rule", "Padded title", ruleBody("# Padded title")).ok).toBe(true);
  });

  it("still rejects a heading that differs by more than whitespace", () => {
    const result = validateBodyForType("rule", "Padded title", ruleBody("# Padded  title"));
    expect(result.ok).toBe(false);
  });

  // Both sides are trimmed, so without a blank-title guard `" "` matches a bare `#`.
  it.each(["", " ", "\t\n "])("rejects a title that trims to empty: %j", (title) => {
    const result = validateBodyForType("rule", title, ruleBody("#"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("blank");
  });

  // The heading is caller-supplied and reaches the model through the MCP envelope.
  it("bounds the heading it echoes back", () => {
    const heading = "x".repeat(5000);
    const result = validateBodyForType("rule", "Short title", ruleBody(`# ${heading}`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message.length).toBeLessThan(400);
    expect(result.error.details).toEqual({ expected: "Short title", actual: heading });
  });

  it("names every required section when the H1 is missing", () => {
    const result = validateBodyForType("insight", "Some insight", "no headings here");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const section of ["Observation", "Evidence", "Implication", "Recommended action"]) {
      expect(result.error.message).toContain(section);
    }
  });
});

describe("validateBodyTemplate", () => {
  it("accepts a body with a matching H1 and all required H2 sections", () => {
    const document = parseOrThrow(decisionDocument(validBody));
    expect(validateBodyTemplate(document).ok).toBe(true);
  });

  it("rejects a body with no H1 heading", () => {
    const body = validBody.replace("# Use libSQL as the local index\n\n", "");
    const document = parseOrThrow(decisionDocument(body));
    const result = validateBodyTemplate(document);
    expect(result.ok).toBe(false);
  });

  it("rejects a body whose H1 does not match the frontmatter title", () => {
    const body = validBody.replace(
      "# Use libSQL as the local index",
      "# A completely different heading",
    );
    const document = parseOrThrow(decisionDocument(body));
    const result = validateBodyTemplate(document);
    expect(result.ok).toBe(false);
  });

  it("accepts a title/H1 match across Unicode normalization forms (NFC vs NFD)", () => {
    // The NFC and NFD forms of the same title are byte-different but
    // semantically equal and must not be falsely rejected. Built from explicit
    // code points since an editor could silently normalize a typed accented
    // character to one form or the other.
    const titleNfc = `Caf${String.fromCharCode(0x00e9)} configuration`; // precomposed "\u00e9" (U+00E9)
    const titleNfd = `Cafe${String.fromCharCode(0x0301)} configuration`; // "e" + combining acute accent (U+0301)
    expect(titleNfc).not.toBe(titleNfd);
    expect(titleNfc.normalize("NFC")).toBe(titleNfd.normalize("NFC"));

    const content = `---
schema_version: 1
id: ${decisionId}
type: decision
title: ${titleNfc}
status: approved
revision: 1
created_at: 2026-01-01T00:00:00.000Z
updated_at: 2026-01-01T00:00:00.000Z
created_by:
  provider: git
  display_name: Example Developer
approved_by:
  provider: git
  display_name: Example Reviewer
approved_at: 2026-01-01T00:00:00.000Z
labels: []
scope:
  repository: ${repositoryId}
  paths: []
  symbols: []
sources:
  - type: session
    ref: ${sessionId}
relations: []
decision:
  kind: architecture
---

# ${titleNfd}

## Context

Some context.

## Decision

Use libSQL.

## Rationale

Reasons.

## Consequences

Effects.

## Alternatives considered

Other options.
`;
    const document = parseOrThrow(content);
    const result = validateBodyTemplate(document);
    expect(result.ok).toBe(true);
  });

  it("rejects a body missing a required H2 section", () => {
    const body = validBody.replace("## Rationale\n\nReasons.\n\n", "");
    const document = parseOrThrow(decisionDocument(body));
    const result = validateBodyTemplate(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.missing).toEqual(["Rationale"]);
    }
  });

  it("does not mistake a '#'-prefixed line inside a fenced code block for a heading", () => {
    const body = `${validBody}\n\n\`\`\`\n## Rationale\n\`\`\`\n`;
    // Remove the real "## Rationale" section so the ONLY remaining "##
    // Rationale"-looking text is inside the fenced code block — if the
    // validator mistook it for a real heading, this would incorrectly pass.
    const bodyWithoutRealSection = body.replace("## Rationale\n\nReasons.\n\n", "");
    const document = parseOrThrow(decisionDocument(bodyWithoutRealSection));
    const result = validateBodyTemplate(document);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.missing).toEqual(["Rationale"]);
    }
  });
});
