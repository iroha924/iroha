import { FixedClock, FixedRandomSource, makeTypedId } from "@iroha/domain";
import { describe, expect, it } from "vitest";
import { validateBodyTemplate } from "./body-template.js";
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
    // Regression test (confirmed by review): the same visible text typed
    // as precomposed (NFC, common from most editors/APIs) vs. a base
    // letter + combining accent (NFD) is byte-different but semantically
    // identical, and must not be falsely rejected.
    // Built from explicit code points, not a literal accented character in
    // source, since an editor could silently normalize a typed character
    // to one form or the other.
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
