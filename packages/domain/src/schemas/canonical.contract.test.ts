import { describe, expect, it } from "vitest";
import { canonicalDocumentSchema } from "./canonical.js";
import { createAjvValidator } from "./test-helpers/ajv.js";

const ajvValidate = createAjvValidator(
  new URL("../../../../schemas/canonical-v1.schema.json", import.meta.url),
);

function zodValid(data: unknown): boolean {
  return canonicalDocumentSchema.safeParse(data).success;
}

const ULID_A = "01J31J6Y00ZZZFVZ7VZBWZHXZP";
const ULID_B = "01J31J6Y01ZZZFVZ7VZBWZHXZP";

function actor(name: string) {
  return { provider: "git" as const, display_name: name };
}

function baseFields(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    status: "approved",
    revision: 1,
    created_at: "2026-07-18T00:00:00.000Z",
    updated_at: "2026-07-18T00:00:00.000Z",
    created_by: actor("Dev"),
    approved_by: actor("Reviewer"),
    approved_at: "2026-07-18T00:00:00.000Z",
    labels: ["architecture"],
    scope: { repository: `repo_${ULID_A}`, paths: [], symbols: [] },
    sources: [{ type: "session", ref: `ses_${ULID_A}` }],
    relations: [],
    ...overrides,
  };
}

function doc(frontmatter: Record<string, unknown>, body = "# Title\n\nbody text") {
  return { frontmatter, body };
}

/** One valid document per canonical type, matching the fixed body templates. */
const positiveFixtures: Array<[string, unknown]> = [
  [
    "session_summary",
    doc({
      ...baseFields({ id: `ses_${ULID_A}`, title: "Session summary" }),
      type: "session_summary",
      session: { platforms: ["claude_code"], run_count: 1, outcome: "completed" },
    }),
  ],
  [
    "decision",
    doc({
      ...baseFields({ id: `dec_${ULID_A}`, title: "Use libSQL as the local index" }),
      type: "decision",
      decision: { kind: "architecture" },
    }),
  ],
  [
    "rule (advisory)",
    doc({
      ...baseFields({ id: `rul_${ULID_A}`, title: "Advisory rule" }),
      type: "rule",
      rule: { enforcement: "advisory", severity: "info" },
    }),
  ],
  [
    "rule (guardrail)",
    doc({
      ...baseFields({ id: `rul_${ULID_B}`, title: "Guardrail rule" }),
      type: "rule",
      rule: {
        enforcement: "guardrail",
        severity: "error",
        guard: { tools: ["Edit"], paths: ["src/generated/**"] },
      },
    }),
  ],
  [
    "concept",
    doc({
      ...baseFields({ id: `con_${ULID_A}`, title: "Repository pattern" }),
      type: "concept",
      concept: { domain: "architecture" },
    }),
  ],
  [
    "insight",
    doc({
      ...baseFields({ id: `ins_${ULID_A}`, title: "An insight" }),
      type: "insight",
      insight: { category: "implementation" },
    }),
  ],
  [
    "incident",
    doc({
      ...baseFields({ id: `inc_${ULID_A}`, title: "An incident" }),
      type: "incident",
      incident: { severity: "low", resolution: "resolved" },
    }),
  ],
  [
    "pattern",
    doc({
      ...baseFields({ id: `pat_${ULID_A}`, title: "A pattern" }),
      type: "pattern",
      pattern: { maturity: "established" },
    }),
  ],
  [
    "review_learning",
    doc({
      ...baseFields({ id: `rev_${ULID_A}`, title: "A review learning" }),
      type: "review_learning",
      review_learning: { category: "correctness" },
    }),
  ],
];

const validDecision = positiveFixtures[1]?.[1] as { frontmatter: Record<string, unknown> };

function withFrontmatter(overrides: Record<string, unknown>) {
  return doc({ ...validDecision.frontmatter, ...overrides });
}

/** Targeted violations, one per constraint, each expected to fail both validators. */
const negativeFixtures: Array<[string, unknown]> = [
  ["top-level unknown field", { ...validDecision, extra: true }],
  ["missing body", { frontmatter: validDecision.frontmatter }],
  ["empty body", doc(validDecision.frontmatter, "")],
  ["body over 100000 chars", doc(validDecision.frontmatter, "x".repeat(100001))],
  ["frontmatter unknown field", withFrontmatter({ unknown_field: "x" })],
  ["schema_version wrong", withFrontmatter({ schema_version: 2 })],
  ["id wrong prefix for type", withFrontmatter({ id: `rul_${ULID_A}` })],
  ["id malformed ULID", withFrontmatter({ id: "dec_not-a-ulid" })],
  ["type unknown", withFrontmatter({ type: "unknown_type" })],
  [
    "type old review vocabulary",
    withFrontmatter({ type: "review", review: { category: "correctness" } }),
  ],
  ["title empty", withFrontmatter({ title: "" })],
  ["title over 160 chars", withFrontmatter({ title: "x".repeat(161) })],
  ["status unknown", withFrontmatter({ status: "draft" })],
  ["revision zero", withFrontmatter({ revision: 0 })],
  ["revision not integer", withFrontmatter({ revision: 1.5 })],
  ["created_at missing Z suffix", withFrontmatter({ created_at: "2026-07-18T00:00:00.000+09:00" })],
  ["created_at not a date", withFrontmatter({ created_at: "not-a-date" })],
  ["created_by missing display_name", withFrontmatter({ created_by: { provider: "git" } })],
  [
    "created_by unknown provider",
    withFrontmatter({ created_by: { provider: "bitbucket", display_name: "x" } }),
  ],
  ["labels bad slug", withFrontmatter({ labels: ["Not_A_Slug"] })],
  ["labels duplicate", withFrontmatter({ labels: ["a", "a"] })],
  ["labels over 50", withFrontmatter({ labels: Array.from({ length: 51 }, (_, i) => `l${i}`) })],
  [
    "scope missing repository prefix",
    withFrontmatter({ scope: { repository: `dec_${ULID_A}`, paths: [], symbols: [] } }),
  ],
  [
    "scope.paths absolute",
    withFrontmatter({
      scope: { repository: `repo_${ULID_A}`, paths: ["/etc/passwd"], symbols: [] },
    }),
  ],
  [
    "scope.paths traversal",
    withFrontmatter({ scope: { repository: `repo_${ULID_A}`, paths: ["a/../b"], symbols: [] } }),
  ],
  [
    "scope.paths duplicate",
    withFrontmatter({ scope: { repository: `repo_${ULID_A}`, paths: ["a", "a"], symbols: [] } }),
  ],
  [
    "scope.languages bad pattern",
    withFrontmatter({
      scope: { repository: `repo_${ULID_A}`, paths: [], symbols: [], languages: ["Type Script"] },
    }),
  ],
  ["sources empty array", withFrontmatter({ sources: [] })],
  ["sources unknown type", withFrontmatter({ sources: [{ type: "chat", ref: "x" }] })],
  [
    "sources invalid url",
    withFrontmatter({ sources: [{ type: "url", ref: "x", url: "not-a-url" }] }),
  ],
  [
    "sources bad quote_hash",
    withFrontmatter({ sources: [{ type: "url", ref: "x", quote_hash: "not-a-hash" }] }),
  ],
  [
    "relations unknown type",
    withFrontmatter({ relations: [{ type: "UNKNOWN_EDGE", target: `dec_${ULID_A}` }] }),
  ],
  [
    "relations bad target",
    withFrontmatter({ relations: [{ type: "SUPERSEDES", target: "not-an-id" }] }),
  ],
  [
    "rule guardrail without guard",
    doc({
      ...baseFields({ id: `rul_${ULID_A}`, title: "Bad guardrail" }),
      type: "rule",
      rule: { enforcement: "guardrail", severity: "error" },
    }),
  ],
  [
    "rule advisory with guard",
    doc({
      ...baseFields({ id: `rul_${ULID_A}`, title: "Bad advisory" }),
      type: "rule",
      rule: {
        enforcement: "advisory",
        severity: "info",
        guard: { tools: ["Edit"], paths: [] },
      },
    }),
  ],
  [
    "rule guardrail missing guard.paths",
    doc({
      ...baseFields({ id: `rul_${ULID_A}`, title: "Bad guardrail 2" }),
      type: "rule",
      rule: { enforcement: "guardrail", severity: "error", guard: { tools: ["Edit"] } },
    }),
  ],
  [
    "session_summary duplicate platforms",
    doc({
      ...baseFields({ id: `ses_${ULID_A}`, title: "Bad session" }),
      type: "session_summary",
      session: { platforms: ["claude_code", "claude_code"], run_count: 1, outcome: "completed" },
    }),
  ],
  [
    "session_summary run_count zero",
    doc({
      ...baseFields({ id: `ses_${ULID_A}`, title: "Bad session 2" }),
      type: "session_summary",
      session: { platforms: ["claude_code"], run_count: 0, outcome: "completed" },
    }),
  ],
  [
    "decision unknown kind",
    doc({
      ...baseFields({ id: `dec_${ULID_A}`, title: "Bad decision" }),
      type: "decision",
      decision: { kind: "marketing" },
    }),
  ],
  [
    "concept domain too long",
    doc({
      ...baseFields({ id: `con_${ULID_A}`, title: "Bad concept" }),
      type: "concept",
      concept: { domain: "x".repeat(121) },
    }),
  ],
  [
    "insight unknown category",
    doc({
      ...baseFields({ id: `ins_${ULID_A}`, title: "Bad insight" }),
      type: "insight",
      insight: { category: "marketing" },
    }),
  ],
  [
    "incident unknown severity",
    doc({
      ...baseFields({ id: `inc_${ULID_A}`, title: "Bad incident" }),
      type: "incident",
      incident: { severity: "catastrophic", resolution: "resolved" },
    }),
  ],
  [
    "pattern unknown maturity",
    doc({
      ...baseFields({ id: `pat_${ULID_A}`, title: "Bad pattern" }),
      type: "pattern",
      pattern: { maturity: "legendary" },
    }),
  ],
  [
    "review_learning unknown category",
    doc({
      ...baseFields({ id: `rev_${ULID_A}`, title: "Bad review learning" }),
      type: "review_learning",
      review_learning: { category: "vibes" },
    }),
  ],
  // Shapes the JSON Schema accepted while Zod rejected them (#169), each
  // verified to be accepted by the pre-fix schema so the fixture is a
  // regression guard and not a restatement. Two mechanisms: the old
  // `$defs.timestamp` anchored only `Z$`, and `ajv-formats` splits the date
  // from the time on `/t|\s/i`, so a space or a lowercase `t` separator and a
  // leap second all passed; and `{"type":"integer"}` carries no upper bound
  // while `.int()` stops at the safe-integer range.
  ["approved_at leap second", withFrontmatter({ approved_at: "2026-12-31T23:59:60Z" })],
  ["created_at space separator", withFrontmatter({ created_at: "2026-07-18 00:00:00Z" })],
  ["created_at lowercase t separator", withFrontmatter({ created_at: "2026-07-18t00:00:00Z" })],
  ["revision past MAX_SAFE_INTEGER", withFrontmatter({ revision: 1e21 })],
  [
    "sources[].line_start past MAX_SAFE_INTEGER",
    withFrontmatter({
      sources: [{ type: "file", ref: "packages/a.ts", path: "packages/a.ts", line_start: 1e21 }],
    }),
  ],
  [
    "session.run_count past MAX_SAFE_INTEGER",
    doc({
      ...baseFields({ id: `ses_${ULID_A}`, title: "Session" }),
      type: "session_summary",
      session: { platforms: ["claude_code"], run_count: 1e21, outcome: "completed" },
    }),
  ],
  // Not a pre-fix gap — `ajv-formats` full mode already capped the hour at 23,
  // so this went green before the change too. It covers the new pattern's own
  // `([01][0-9]|2[0-3])` group, which nothing else exercises.
  ["created_at hour 24", withFrontmatter({ created_at: "2026-07-18T24:00:00Z" })],
];

describe("canonical document schema: AJV/Zod equivalence", () => {
  for (const [label, fixture] of positiveFixtures) {
    it(`accepts (both validators): ${label}`, () => {
      expect(ajvValidate(fixture)).toBe(true);
      expect(zodValid(fixture)).toBe(true);
    });
  }

  for (const [label, fixture] of negativeFixtures) {
    it(`rejects (both validators): ${label}`, () => {
      expect(ajvValidate(fixture)).toBe(false);
      expect(zodValid(fixture)).toBe(false);
    });
  }

  // The bounds added for #169 sit one step above these values, so a tighter
  // bound would start rejecting legitimate documents. Asserting the accepted
  // side is what makes the negative fixtures above a bound rather than a ban.
  const boundaryFixtures: Array<[string, unknown]> = [
    ["revision at MAX_SAFE_INTEGER", withFrontmatter({ revision: Number.MAX_SAFE_INTEGER })],
    [
      "timestamp with no fractional seconds",
      withFrontmatter({ approved_at: "2026-07-18T00:00:00Z" }),
    ],
    [
      "timestamp with six fractional digits",
      withFrontmatter({ approved_at: "2026-07-18T00:00:00.123456Z" }),
    ],
    ["second 59 and hour 23", withFrontmatter({ approved_at: "2026-12-31T23:59:59Z" })],
  ];

  for (const [label, fixture] of boundaryFixtures) {
    it(`accepts (both validators): ${label}`, () => {
      expect(ajvValidate(fixture)).toBe(true);
      expect(zodValid(fixture)).toBe(true);
    });
  }
});

describe("canonical document schema: Zod-specific behavior", () => {
  it("rejects an unparseable value without throwing", () => {
    expect(() => canonicalDocumentSchema.safeParse(null)).not.toThrow();
    expect(canonicalDocumentSchema.safeParse(null).success).toBe(false);
  });

  it("parses a valid decision and preserves its shape", () => {
    const result = canonicalDocumentSchema.safeParse(validDecision);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.frontmatter.type).toBe("decision");
    }
  });
});
