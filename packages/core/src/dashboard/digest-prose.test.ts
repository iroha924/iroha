import { describe, expect, it } from "vitest";
import type { DigestFact } from "./digest.js";
import {
  type DigestProse,
  digestProseSchema,
  parseStoredProse,
  redactProse,
  referencedFactIds,
  renderProse,
  validateProse,
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

  it("rejects duplicate slots at a length the bound allows", () => {
    // The length bound alone cannot catch this: four sections is legal, so the
    // renderer would key two siblings on the same slot.
    const result = digestProseSchema.safeParse(
      prose({
        sections: [
          { slot: "wins", heading: "a", body: "a" },
          { slot: "wins", heading: "b", body: "b" },
        ],
      }),
    );

    expect(result.success).toBe(false);
  });

  it("accepts one section per slot", () => {
    const result = digestProseSchema.safeParse(
      prose({
        sections: [
          { slot: "stumbles", heading: "a", body: "a" },
          { slot: "codebase", heading: "b", body: "b" },
          { slot: "wins", heading: "c", body: "c" },
          { slot: "teaching", heading: "d", body: "d" },
        ],
      }),
    );

    expect(result.success).toBe(true);
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

  it("resolves a fact id containing a non-ASCII path", () => {
    // A charset-based reference pattern failed to match iroha's own issued id here:
    // the save passed having found no reference, and the page showed the literal
    // braces. Matching up to `}}` and resolving against the issued set cannot drift.
    const facts: DigestFact[] = [
      { id: "local.correlations.packages/日本語.count", value: 4, label: "clustered" },
    ];

    const rendered = renderProse(
      prose({ headline: "{{local.correlations.packages/日本語.count}} denials" }),
      facts,
    );

    expect(rendered.headline).toBe("4 denials");
    expect(
      referencedFactIds(prose({ headline: "{{local.correlations.packages/日本語.count}}" })),
    ).toEqual(["local.correlations.packages/日本語.count"]);
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

describe("validateProse", () => {
  it("accepts prose that cites only issued facts", () => {
    const result = validateProse(prose({ headline: "{{local.denials.total}} denials" }), FACTS);

    expect(result.ok).toBe(true);
  });

  it("rejects an invented fact id and names it", () => {
    const result = validateProse(prose({ headline: "{{local.velocity.score}} points" }), FACTS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_INPUT");
    expect(result.error.details).toEqual({ unknownFactIds: ["local.velocity.score"] });
  });

  it("accepts prose citing nothing at all", () => {
    expect(validateProse(prose(), FACTS).ok).toBe(true);
  });

  it("rejects a figure written as digits instead of referenced", () => {
    // Without this the seam's central claim is false: the text cites nothing, so
    // reference validation passes and the agent's own number renders as page copy.
    const result = validateProse(prose({ headline: "There were 999 denials" }), FACTS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_INPUT");
    expect(result.error.details).toEqual({ fields: ["headline"] });
  });

  it("rejects a typed figure in any field, and names them", () => {
    const result = validateProse(
      prose({
        standfirst: "Up by 4 this week.",
        sections: [{ slot: "wins", heading: "h", body: "and 12 more elsewhere" }],
      }),
      FACTS,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.details).toEqual({
      fields: ["standfirst", "sections[0].body"],
    });
  });

  it("leaves digits inside identifiers, versions, and dates writable", () => {
    for (const text of [
      "ADR-016 settled this",
      "the week of 2026-07-20",
      "see §16 for the contract",
      "running on Node 24.x",
      "under packages/git",
      "{{local.denials.total}} denials",
    ]) {
      expect(validateProse(prose({ headline: text }), FACTS).ok, text).toBe(true);
    }
  });
});

describe("redactProse", () => {
  it("passes prose with no secrets through unchanged", async () => {
    const original = prose();

    const result = await redactProse(original);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prose).toEqual(original);
    expect(result.value.redactions).toEqual([]);
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
    expect(result.value.prose.sections[0]?.body).not.toContain("ghp_");
    expect(result.value.prose.sections[0]?.body).toContain("redacted");
    expect(result.value.redactions.map((r) => r.field)).toEqual(["sections[0].body"]);
  });

  it("redacts a secret in the headline", async () => {
    const result = await redactProse(prose({ headline: `Leaked ${SESSION_TOKEN} in a commit` }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prose.headline).not.toContain(SESSION_TOKEN);
    expect(result.value.redactions.map((r) => r.field)).toEqual(["headline"]);
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
