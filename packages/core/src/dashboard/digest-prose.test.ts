import { describe, expect, it } from "vitest";
import type { DigestFact } from "./digest.js";
import {
  type DigestProse,
  digestProseSchema,
  parseStoredProse,
  redactProse,
  referencedFactIds,
  renderProse,
  validateFactReferences,
} from "./digest-prose.js";

/**
 * Fixtures the shared scanner actually flags, in the shapes the repository
 * already commits: a URL whose userinfo carries a token (secretlint's `basicauth`
 * rule) and an iroha session token (its `pattern` rule). A bare `ghp_…` short
 * fake is *not* detected, so it would make the assertion vacuous; a realistic
 * 36-character `ghp_` token is detected but trips the pre-commit gitleaks scan,
 * which cannot tell a fixture from a leak.
 */
const CREDENTIALED_URL = "https://user:ghp_secrettoken@github.com/x/y.git";
const SESSION_TOKEN = `ist_${"A".repeat(43)}`;

const FACTS: DigestFact[] = [
  { id: "local.denials.total", value: 7, label: "Guardrail denials" },
  { id: "team.knowledge.total", value: 2, label: "Knowledge approved" },
  { id: "local.denials.byRule.kn_abc", value: 5, label: "Denials by rule Generated files" },
];

function prose(overrides: Partial<DigestProse> = {}): DigestProse {
  return {
    headline: "A week of guarded edits",
    standfirst: "Seven denials, all in one place.",
    sections: [{ slot: "stumbles", heading: "Where it stopped", body: "The hook held the line." }],
    ...overrides,
  };
}

describe("digestProseSchema", () => {
  it("rejects an unknown slot", () => {
    const result = digestProseSchema.safeParse(
      prose({ sections: [{ slot: "editorial", heading: "h", body: "b" }] as never }),
    );

    expect(result.success).toBe(false);
  });

  it("rejects more sections than there are slots", () => {
    const result = digestProseSchema.safeParse(
      prose({
        sections: Array.from({ length: 5 }, () => ({
          slot: "wins" as const,
          heading: "h",
          body: "b",
        })),
      }),
    );

    expect(result.success).toBe(false);
  });

  it("rejects an unknown top-level field", () => {
    const result = digestProseSchema.safeParse({ ...prose(), byline: "an agent" });

    expect(result.success).toBe(false);
  });
});

describe("referencedFactIds", () => {
  it("collects references from every field, deduplicated", () => {
    const ids = referencedFactIds(
      prose({
        headline: "{{local.denials.total}} denials",
        standfirst: "and {{team.knowledge.total}} approvals",
        sections: [
          {
            slot: "stumbles",
            heading: "{{local.denials.total}} again",
            body: "of which {{local.denials.byRule.kn_abc}} from one rule",
          },
        ],
      }),
    );

    expect(ids.sort()).toEqual([
      "local.denials.byRule.kn_abc",
      "local.denials.total",
      "team.knowledge.total",
    ]);
  });

  it("finds no references in prose that cites nothing", () => {
    expect(referencedFactIds(prose())).toEqual([]);
  });
});

describe("renderProse", () => {
  it("substitutes iroha's value for each reference", () => {
    const rendered = renderProse(
      prose({
        headline: "{{local.denials.total}} denials this week",
        standfirst: "against {{team.knowledge.total}} new lessons",
      }),
      FACTS,
    );

    expect(rendered.headline).toBe("7 denials this week");
    expect(rendered.standfirst).toBe("against 2 new lessons");
  });

  it("renders an em dash for a fact that no longer exists", () => {
    // Validation at save time cannot prevent this: a Rule deleted afterwards
    // takes its `byRule` fact with it.
    const rendered = renderProse(prose({ headline: "{{local.denials.byRule.kn_gone}} denials" }), [
      ...FACTS,
    ]);

    expect(rendered.headline).toBe("— denials");
  });

  it("leaves text with no references untouched", () => {
    const original = prose();

    expect(renderProse(original, FACTS)).toEqual(original);
  });

  it("substitutes inside a section body", () => {
    const rendered = renderProse(
      prose({
        sections: [
          { slot: "stumbles", heading: "h", body: "{{local.denials.byRule.kn_abc}} of them" },
        ],
      }),
      FACTS,
    );

    expect(rendered.sections[0]?.body).toBe("5 of them");
  });
});

describe("validateFactReferences", () => {
  it("accepts prose that cites only issued facts", () => {
    const result = validateFactReferences(
      prose({ headline: "{{local.denials.total}} denials" }),
      FACTS,
    );

    expect(result.ok).toBe(true);
  });

  it("rejects an invented fact id and names it", () => {
    const result = validateFactReferences(
      prose({ headline: "{{local.velocity.score}} points" }),
      FACTS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_INPUT");
    expect(result.error.details).toEqual({ unknownFactIds: ["local.velocity.score"] });
  });

  it("accepts prose citing nothing at all", () => {
    expect(validateFactReferences(prose(), FACTS).ok).toBe(true);
  });
});

describe("redactProse", () => {
  it("passes prose with no secrets through unchanged", async () => {
    const original = prose();

    const result = await redactProse(original);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(original);
  });

  it("redacts a secret in a section body before it can be stored", async () => {
    const result = await redactProse(
      prose({
        sections: [
          {
            slot: "stumbles",
            heading: "Where it stopped",
            body: `The remote was ${CREDENTIALED_URL}`,
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sections[0]?.body).not.toContain("ghp_");
    expect(result.value.sections[0]?.body).toContain("redacted");
  });

  it("redacts a secret in the headline", async () => {
    const result = await redactProse(prose({ headline: `Leaked ${SESSION_TOKEN} in a commit` }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.headline).not.toContain(SESSION_TOKEN);
  });
});

describe("parseStoredProse", () => {
  it("reads back a stored issue", () => {
    const issue = parseStoredProse(JSON.stringify(prose()), "2026-07-23T00:00:00.000Z");

    expect(issue?.prose.headline).toBe("A week of guarded edits");
    expect(issue?.composedAt).toBe("2026-07-23T00:00:00.000Z");
    expect(issue?.unreviewed).toBe(true);
  });

  it("treats invalid JSON as no prose rather than an error", () => {
    expect(parseStoredProse("{not json", "2026-07-23T00:00:00.000Z")).toBeNull();
  });

  it("treats a row that no longer matches the schema as no prose", () => {
    // Prose is decoration over authoritative numbers, so a stale shape must
    // degrade to templated copy instead of breaking the page.
    expect(parseStoredProse(JSON.stringify({ headline: "only" }), "2026-07-23T00:00:00.000Z")).toBe(
      null,
    );
  });
});
