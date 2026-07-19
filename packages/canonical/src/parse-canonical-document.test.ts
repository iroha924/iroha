import { FixedClock, FixedRandomSource, makeTypedId } from "@iroha/domain";
import { describe, expect, it } from "vitest";
import { parseCanonicalDocument } from "./parse-canonical-document.js";

const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const random = new FixedRandomSource(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
const decisionId = makeTypedId("dec", clock, random);
const repositoryId = makeTypedId("repo", clock, random);
const sessionId = makeTypedId("ses", clock, random);

function validDecisionDocument(): string {
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
labels:
  - architecture
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

# Use libSQL as the local index

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
}

describe("parseCanonicalDocument", () => {
  it("parses a valid decision document", () => {
    const result = parseCanonicalDocument(validDecisionDocument());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.frontmatter.id).toBe(decisionId);
      expect(result.value.frontmatter.type).toBe("decision");
      expect(result.value.body.startsWith("# Use libSQL as the local index")).toBe(true);
    }
  });

  it("rejects CRLF line endings", () => {
    const content = validDecisionDocument().replace(/\n/g, "\r\n");
    const result = parseCanonicalDocument(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("rejects a UTF-8 BOM", () => {
    const result = parseCanonicalDocument(`﻿${validDecisionDocument()}`);
    expect(result.ok).toBe(false);
  });

  it("rejects content that does not start with a frontmatter delimiter", () => {
    const result = parseCanonicalDocument("# Not a canonical document\n");
    expect(result.ok).toBe(false);
  });

  it("rejects a missing closing frontmatter delimiter", () => {
    const result = parseCanonicalDocument("---\nschema_version: 1\n\n# Body\n");
    expect(result.ok).toBe(false);
  });

  it("rejects invalid YAML in the frontmatter", () => {
    const content = "---\nschema_version: [1\n---\n\n# Body\n";
    const result = parseCanonicalDocument(content);
    expect(result.ok).toBe(false);
  });

  it("rejects a document missing a required frontmatter field", () => {
    const content = validDecisionDocument().replace("revision: 1\n", "");
    const result = parseCanonicalDocument(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("rejects a document with an unknown frontmatter field", () => {
    const content = validDecisionDocument().replace(
      "decision:\n  kind: architecture\n",
      "decision:\n  kind: architecture\nunknown_field: true\n",
    );
    const result = parseCanonicalDocument(content);
    expect(result.ok).toBe(false);
  });

  it("rejects a rule frontmatter with enforcement:guardrail but no guard object", () => {
    const ruleId = makeTypedId("rul", clock, random);
    const content = `---
schema_version: 1
id: ${ruleId}
type: rule
title: Example guardrail rule
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
rule:
  enforcement: guardrail
  severity: error
---

# Example guardrail rule

## Rule

Body.

## Scope

Body.

## Rationale

Body.

## Examples

Body.

## Exceptions

Body.
`;
    const result = parseCanonicalDocument(content);
    expect(result.ok).toBe(false);
  });
});
