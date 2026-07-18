import { describe, expect, it } from "vitest";
import { checkpointInputSchema } from "./checkpoint.js";
import { createAjvValidator } from "./test-helpers/ajv.js";

const ajvValidate = createAjvValidator(
  new URL("../../../../schemas/checkpoint-v1.schema.json", import.meta.url),
);

function zodValid(data: unknown): boolean {
  return checkpointInputSchema.safeParse(data).success;
}

const SESSION_TOKEN = `ist_${"a".repeat(43)}`;
const ULID = "01J31J6Y00ZZZFVZ7VZBWZHXZP";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sessionToken: SESSION_TOKEN,
    idempotencyKey: "checkpoint-key-0001",
    outcome: "completed",
    objective: "Implement WP-01 canonical schema",
    summary: "Ported canonical-v1.schema.json to Zod",
    implementation: [{ file: "src/schemas/canonical.ts", change: "Added the schema" }],
    validation: [{ command: "pnpm test", result: "passed" }],
    unresolved: [],
    references: [{ type: "issue", ref: "GH-42" }],
    labels: ["architecture"],
    proposals: [],
    ...overrides,
  };
}

const minimalProposal = {
  type: "decision",
  title: "Use libSQL",
  summary: "Chose libSQL for the local index",
  body: "Because it is embeddable and supports FTS5.",
  labels: [],
  scope: { paths: [], symbols: [] },
  sources: [{ type: "issue", ref: "GH-42" }],
};

/** One valid checkpoint input, plus a few representative proposal/guard shapes. */
const positiveFixtures: Array<[string, unknown]> = [
  ["minimal valid checkpoint", baseInput()],
  ["with turnId", baseInput({ turnId: `trn_${ULID}` })],
  ["with unresolved items", baseInput({ unresolved: ["follow up on X"] })],
  [
    "implementation item with only symbol",
    baseInput({
      implementation: [{ symbol: "CanonicalDocument", change: "Added the type" }],
    }),
  ],
  [
    "implementation item with both file and symbol",
    baseInput({
      implementation: [
        { file: "src/schemas/canonical.ts", symbol: "CanonicalDocument", change: "Added" },
      ],
    }),
  ],
  ["with a decision proposal", baseInput({ proposals: [minimalProposal] })],
  [
    "with an advisory proposal carrying a guard (allowed for proposals)",
    baseInput({
      proposals: [
        {
          ...minimalProposal,
          type: "rule",
          enforcement: "advisory",
          guard: { tools: ["Edit"], paths: [] },
        },
      ],
    }),
  ],
  [
    "with a guardrail proposal",
    baseInput({
      proposals: [
        {
          ...minimalProposal,
          type: "rule",
          enforcement: "guardrail",
          guard: { tools: ["Edit"], paths: ["src/generated/**"] },
        },
      ],
    }),
  ],
  [
    "with a review_learning proposal",
    baseInput({
      proposals: [{ ...minimalProposal, type: "review_learning" }],
    }),
  ],
];

/** Targeted violations, one per constraint, each expected to fail both validators. */
const negativeFixtures: Array<[string, unknown]> = [
  ["top-level unknown field", baseInput({ extra: true })],
  ["schemaVersion wrong", baseInput({ schemaVersion: 2 })],
  ["sessionToken bad prefix", baseInput({ sessionToken: `xxx_${"a".repeat(43)}` })],
  ["sessionToken wrong length", baseInput({ sessionToken: `ist_${"a".repeat(42)}` })],
  ["idempotencyKey too short", baseInput({ idempotencyKey: "short" })],
  ["idempotencyKey bad chars", baseInput({ idempotencyKey: "has a space here!!" })],
  ["turnId wrong prefix", baseInput({ turnId: `ses_${ULID}` })],
  ["outcome unknown", baseInput({ outcome: "cancelled" })],
  ["objective empty", baseInput({ objective: "" })],
  ["objective too long", baseInput({ objective: "x".repeat(1001) })],
  ["summary empty", baseInput({ summary: "" })],
  [
    "implementation item missing both file and symbol",
    baseInput({ implementation: [{ change: "did something" }] }),
  ],
  ["implementation item missing change", baseInput({ implementation: [{ file: "src/index.ts" }] })],
  [
    "implementation item path traversal",
    baseInput({ implementation: [{ file: "../secret.env", change: "x" }] }),
  ],
  ["validation item unknown result", baseInput({ validation: [{ result: "flaky" }] })],
  [
    "validation item negative duration",
    baseInput({ validation: [{ result: "passed", durationMs: -1 }] }),
  ],
  ["reference missing ref", baseInput({ references: [{ type: "issue" }] })],
  [
    "reference unknown type (session is not a valid reference type here)",
    baseInput({ references: [{ type: "session", ref: "ses_x" }] }),
  ],
  [
    "reference invalid url",
    baseInput({ references: [{ type: "url", ref: "x", url: "not-a-url" }] }),
  ],
  ["labels bad slug", baseInput({ labels: ["Not_A_Slug"] })],
  ["labels duplicate", baseInput({ labels: ["a", "a"] })],
  [
    "proposal missing scope",
    baseInput({
      proposals: [
        {
          type: "decision",
          title: "x",
          summary: "x",
          body: "x",
          labels: [],
          sources: [{ type: "issue", ref: "GH-1" }],
        },
      ],
    }),
  ],
  [
    "proposal guardrail without guard",
    baseInput({
      proposals: [{ ...minimalProposal, type: "rule", enforcement: "guardrail" }],
    }),
  ],
  [
    "proposal guardrail with guard missing paths",
    baseInput({
      proposals: [
        {
          ...minimalProposal,
          type: "rule",
          enforcement: "guardrail",
          guard: { tools: ["Edit"] },
        },
      ],
    }),
  ],
  ["proposal sources empty", baseInput({ proposals: [{ ...minimalProposal, sources: [] }] })],
  [
    "proposal confidence out of range",
    baseInput({ proposals: [{ ...minimalProposal, confidence: 1.5 }] }),
  ],
];

describe("checkpoint input schema: AJV/Zod equivalence", () => {
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
});
