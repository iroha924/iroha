import type { KnowledgeProposal } from "@iroha/domain";
import { describe, expect, it } from "vitest";
import { redactProposal, redactReference } from "./redact.js";

// Same known-detected private-key shape the canonical secret-scan test uses.
// Detected by the recommend preset's privatekey rule, so these tests are
// independent of the added `ist_` pattern rule.
const PRIVATE_KEY_BODY =
  "MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz+/==";
const SECRET = `-----BEGIN RSA PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\n-----END RSA PRIVATE KEY-----`;

const baseProposal: KnowledgeProposal = {
  type: "insight",
  title: "A finding",
  summary: "A short summary",
  body: "A longer body describing the insight.",
  labels: [],
  scope: { paths: [], symbols: [] },
  sources: [{ type: "commit", ref: "abc1234" }],
};

// These fields were previously passed through verbatim by redactProposal /
// redactReference (docstring claimed relative paths "cannot carry a
// credential"). Each test is red on the pre-fix code: the field reaches the
// output unredacted, so the `[redacted` assertion fails.
describe("redactProposal — previously-unscanned free-text fields", () => {
  it("redacts a secret in scope.paths", async () => {
    const result = await redactProposal(
      { ...baseProposal, scope: { paths: [SECRET], symbols: [] } },
      "p",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.redactions.some((r) => r.field === "p.scope.paths[0]")).toBe(true);
      expect(result.value.proposal.scope.paths[0]).toContain("[redacted");
      expect(result.value.proposal.scope.paths[0]).not.toContain("PRIVATE KEY");
    }
  });

  it("redacts a secret in guard.paths", async () => {
    const result = await redactProposal(
      { ...baseProposal, enforcement: "guardrail", guard: { tools: ["Edit"], paths: [SECRET] } },
      "p",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.redactions.some((r) => r.field === "p.guard.paths[0]")).toBe(true);
      expect(result.value.proposal.guard?.paths[0]).toContain("[redacted");
    }
  });

  it("redacts a secret in a relations[] edge's type and target", async () => {
    const result = await redactProposal(
      { ...baseProposal, relations: [{ type: SECRET, target: SECRET }] },
      "p",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.redactions.some((r) => r.field === "p.relations[0].type")).toBe(true);
      expect(result.value.redactions.some((r) => r.field === "p.relations[0].target")).toBe(true);
      expect(result.value.proposal.relations?.[0]?.type).toContain("[redacted");
      expect(result.value.proposal.relations?.[0]?.target).toContain("[redacted");
    }
  });

  it("gives distinct placeholders to two secret-bearing relation edges", async () => {
    // Two edges whose type carries a secret must not collapse to identical
    // `{type, target}` objects. Red on the pre-fix constant placeholder.
    const result = await redactProposal(
      {
        ...baseProposal,
        relations: [
          { type: SECRET, target: "dec_01ABC" },
          { type: SECRET, target: "dec_01ABC" },
        ],
      },
      "p",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const relations = result.value.proposal.relations;
      expect(relations?.[0]?.type).toContain("[redacted");
      expect(relations?.[1]?.type).toContain("[redacted");
      expect(relations?.[0]?.type).not.toBe(relations?.[1]?.type);
    }
  });

  it("gives distinct placeholders to two secret-bearing array entries (no uniqueItems collision)", async () => {
    // Two DISTINCT paths, each carrying a secret, must not collapse to one
    // placeholder: canonical `scope.paths` is `unique()`, so identical
    // placeholders would make the approved document fail validation and leave
    // the candidate un-approvable. Red on the pre-fix constant placeholder.
    const result = await redactProposal(
      { ...baseProposal, scope: { paths: [`a/${SECRET}`, `b/${SECRET}`], symbols: [] } },
      "p",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const paths = result.value.proposal.scope.paths;
      expect(paths).toHaveLength(2);
      expect(paths[0]).toContain("[redacted");
      expect(paths[1]).toContain("[redacted");
      expect(paths[0]).not.toBe(paths[1]);
    }
  });

  it("leaves a clean proposal's new fields untouched", async () => {
    const result = await redactProposal(
      {
        ...baseProposal,
        scope: { paths: ["src/index.ts"], symbols: [] },
        relations: [{ type: "SUPERSEDES", target: "dec_01ABC" }],
      },
      "p",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.redactions).toEqual([]);
      expect(result.value.proposal.scope.paths).toEqual(["src/index.ts"]);
      expect(result.value.proposal.relations?.[0]).toEqual({
        type: "SUPERSEDES",
        target: "dec_01ABC",
      });
    }
  });
});

describe("redactReference — previously-unscanned path", () => {
  it("redacts a secret in a reference path", async () => {
    const result = await redactReference(
      { type: "file", ref: "src/x.ts", path: SECRET },
      "p.sources[0]",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.redactions.some((r) => r.field === "p.sources[0].path")).toBe(true);
      expect(result.value.reference.path).toContain("[redacted");
    }
  });
});
