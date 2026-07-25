import { isCanonicalEntityId, type TypedId } from "@iroha/domain";
import { describe, expect, it } from "vitest";
import { decisionDraft } from "../test-helpers/candidate.js";
import {
  type BuildCanonicalInput,
  buildCanonicalDocumentFromCandidate,
} from "./build-canonical.js";

const REPO = "repo_01J31J6Y00ZZZFVZ7VZBWZHXZP" as TypedId<"repo">;
const CANDIDATE_A = "cand_01J31J6Y00ZZZFVZ7VZBWZHXZP";
const CANDIDATE_B = "cand_01J31J6Y00ZZZFVZ7VZBWZHYAB";

function inputFor(candidateId: string, approvedAt: string): BuildCanonicalInput {
  return {
    candidateType: "decision",
    draft: decisionDraft(),
    repositoryId: REPO,
    candidateId,
    createdBy: { provider: "local", display_name: "iroha agent" },
    approvedBy: { provider: "git", display_name: "Reviewer" },
    createdAt: "2026-07-25T00:00:00.000Z",
    approvedAt,
    revision: 1,
    provenance: [],
  };
}

function idOf(input: BuildCanonicalInput): string {
  const built = buildCanonicalDocumentFromCandidate(input);
  if (!built.ok) {
    throw new Error(`build failed: ${built.error.code}: ${built.error.message}`);
  }
  return built.value.frontmatter.id;
}

describe("buildCanonicalDocumentFromCandidate: deterministic id", () => {
  it("derives the same canonical id for one candidate, independent of approval time", () => {
    // Two "approvals" of the same candidate at different times (a crash-then-retry):
    // the id must match so the retry overwrites the same canonical file, not duplicate it.
    const first = idOf(inputFor(CANDIDATE_A, "2026-07-25T01:00:00.000Z"));
    const second = idOf(inputFor(CANDIDATE_A, "2026-07-25T09:30:00.000Z"));
    expect(first).toBe(second);
    expect(isCanonicalEntityId(first)).toBe(true);
    expect(first.startsWith("dec_")).toBe(true);
  });

  it("derives different canonical ids for different candidates", () => {
    const a = idOf(inputFor(CANDIDATE_A, "2026-07-25T01:00:00.000Z"));
    const b = idOf(inputFor(CANDIDATE_B, "2026-07-25T01:00:00.000Z"));
    expect(a).not.toBe(b);
  });
});
