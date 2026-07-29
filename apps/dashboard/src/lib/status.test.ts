import { describe, expect, it } from "vitest";
import { KNOWLEDGE_TYPES, knowledgeTypeTone } from "./status.js";

/**
 * The Review badge and the Overview chart used to hold separate colour lists and
 * drifted apart. They now share `KNOWLEDGE_TYPES`, and these are the properties
 * that made the drift visible.
 */
describe("KNOWLEDGE_TYPES", () => {
  // migrations/001_initial.sql candidates.candidate_type, minus session_summary,
  // which no producer emits. Transcribed from the constraint, not from the table
  // under test.
  const CANONICAL_TYPES = [
    "decision",
    "rule",
    "concept",
    "insight",
    "incident",
    "pattern",
    "review_learning",
  ];

  it("covers every canonical knowledge type", () => {
    expect(KNOWLEDGE_TYPES.map((t) => t.key).sort()).toEqual([...CANONICAL_TYPES].sort());
  });

  // The complaint this table exists to answer: several types sharing one colour.
  it("gives each type a tone and a colour of its own", () => {
    expect(new Set(KNOWLEDGE_TYPES.map((t) => t.tone)).size).toBe(KNOWLEDGE_TYPES.length);
    expect(new Set(KNOWLEDGE_TYPES.map((t) => t.color)).size).toBe(KNOWLEDGE_TYPES.length);
  });

  it("resolves a tone for every type, and neutral for anything else", () => {
    for (const type of CANONICAL_TYPES) {
      expect(knowledgeTypeTone(type)).not.toBe("neutral");
    }
    expect(knowledgeTypeTone("session_summary")).toBe("neutral");
    expect(knowledgeTypeTone("not-a-type")).toBe("neutral");
  });
});
