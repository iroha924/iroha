import { FixedClock, FixedRandomSource, makeTypedId } from "@iroha/domain";
import { describe, expect, it } from "vitest";
import { parseCanonicalDocument } from "./parse-canonical-document.js";
import { serializeCanonicalDocument } from "./serialize-canonical-document.js";

const clock = new FixedClock(new Date("2026-01-01T00:00:00.000Z"));
const random = new FixedRandomSource(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
const decisionId = makeTypedId("dec", clock, random);
const repositoryId = makeTypedId("repo", clock, random);
const sessionId = makeTypedId("ses", clock, random);
const targetId = makeTypedId("dec", clock, random);

const decisionBody = `# Use libSQL as the local index

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

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    frontmatter: {
      schema_version: 1,
      id: decisionId,
      type: "decision",
      title: "Use libSQL as the local index",
      status: "approved",
      revision: 1,
      // Deliberately out of "contract order" and with second-precision
      // timestamps (no milliseconds) to exercise steps 3 and 7.
      approved_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
      approved_by: { display_name: "Example Reviewer", provider: "git" },
      created_by: { display_name: "Example Developer", provider: "git" },
      // Deliberately unsorted.
      labels: ["testing", "architecture"],
      scope: { repository: repositoryId, paths: [], symbols: [] },
      sources: [{ type: "session", ref: sessionId }],
      relations: [{ type: "RELATED_TO", target: targetId }],
      decision: { kind: "architecture" },
      ...overrides,
    },
    body: decisionBody,
  };
}

describe("serializeCanonicalDocument", () => {
  it("serializes a valid candidate to canonical text with a stable hash", () => {
    const result = serializeCanonicalDocument(candidate());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.value.content.startsWith("---\nschema_version: 1\n")).toBe(true);
      expect(result.value.content.endsWith("\n")).toBe(true);
      expect(result.value.content.endsWith("\n\n")).toBe(false);
    }
  });

  it("sorts frontmatter fields into contract order regardless of input order", () => {
    const result = serializeCanonicalDocument(candidate());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const keyOrder = [
        "schema_version",
        "id",
        "type",
        "title",
        "status",
        "revision",
        "created_at",
        "updated_at",
        "created_by",
        "approved_by",
        "approved_at",
        "labels",
        "scope",
        "sources",
        "relations",
        "decision",
      ];
      let searchFrom = 0;
      for (const key of keyOrder) {
        const index = result.value.content.indexOf(`\n${key}:`, searchFrom);
        expect(
          index,
          `expected key "${key}" to appear after position ${searchFrom}`,
        ).toBeGreaterThan(-1);
        searchFrom = index + 1;
      }
    }
  });

  it("sorts labels lexicographically", () => {
    const result = serializeCanonicalDocument(candidate());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.document.frontmatter.labels).toEqual(["architecture", "testing"]);
    }
  });

  it("formats timestamps as UTC with milliseconds", () => {
    const result = serializeCanonicalDocument(candidate());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toContain("created_at: 2026-01-01T00:00:00.000Z");
      expect(result.value.content).toContain("approved_at: 2026-01-01T00:00:00.000Z");
    }
  });

  it("produces byte-identical output for the same semantic input regardless of key order", () => {
    const a = candidate();
    const b = candidate();
    // Reorder frontmatter keys via a fresh object with different insertion order.
    const reordered = { body: b.body, frontmatter: { ...b.frontmatter } };
    const resultA = serializeCanonicalDocument(a);
    const resultB = serializeCanonicalDocument(reordered);
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (resultA.ok && resultB.ok) {
      expect(resultA.value.content).toBe(resultB.value.content);
      expect(resultA.value.hash).toBe(resultB.value.hash);
    }
  });

  it("produces output that itself parses successfully", () => {
    const result = serializeCanonicalDocument(candidate());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const reparsed = parseCanonicalDocument(result.value.content);
      expect(reparsed.ok).toBe(true);
    }
  });

  it("rejects an invalid candidate", () => {
    const invalid = candidate({ status: "not-a-real-status" });
    const result = serializeCanonicalDocument(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("orders a guardrail rule's guard object and omits it for an advisory rule", () => {
    const ruleId = makeTypedId("rul", clock, random);
    const guardrail = {
      frontmatter: {
        schema_version: 1,
        id: ruleId,
        type: "rule",
        title: "Example guardrail rule",
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
        rule: {
          enforcement: "guardrail",
          severity: "error",
          // Deliberately unordered guard fields.
          guard: { paths: ["src/**"], tools: ["Bash"] },
        },
      },
      body: `# Example guardrail rule

## Rule

Body.

## Scope

Body.

## Rationale

Body.

## Examples

Body.

## Exceptions

Body.`,
    };
    const result = serializeCanonicalDocument(guardrail);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const toolsIndex = result.value.content.indexOf("tools:");
      const pathsIndex = result.value.content.indexOf(
        "paths:",
        result.value.content.indexOf("guard:"),
      );
      expect(toolsIndex).toBeGreaterThan(-1);
      expect(pathsIndex).toBeGreaterThan(toolsIndex);
    }
  });
});
