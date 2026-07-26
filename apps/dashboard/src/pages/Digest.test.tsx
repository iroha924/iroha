import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Digest } from "@/pages/Digest.js";
import { mockApi, ok, renderWithProviders } from "@/test-utils.js";

const EMPTY_BY_TYPE = {
  decision: 0,
  rule: 0,
  concept: 0,
  insight: 0,
  incident: 0,
  pattern: 0,
  review_learning: 0,
};

const EMPTY_LIST = { items: [], total: 0, truncated: false };

function digest(overrides: Record<string, unknown> = {}) {
  return ok({
    period: {
      unit: "week",
      key: "2026-07-20",
      start: "2026-07-20T00:00:00.000Z",
      end: "2026-07-27T00:00:00.000Z",
      offset: 0,
    },
    local: {
      denials: { value: 0, priorValue: 0, byRule: [] },
      checkpoints: {
        value: 0,
        priorValue: 0,
        byOutcome: { completed: 0, partial: 0, blocked: 0, no_change: 0 },
      },
      sessions: { value: 0, priorValue: 0 },
      pendingReviewLearnings: 0,
      correlations: EMPTY_LIST,
    },
    team: {
      knowledge: { value: 0, priorValue: 0, byType: EMPTY_BY_TYPE },
      guardrailsChanged: EMPTY_LIST,
      reviewLearnings: EMPTY_LIST,
      rulesetAdequacy: { enforceable: 0, not_hook_enforceable: 0, invalid: 0 },
    },
    facts: [],
    prose: null,
    ...overrides,
  });
}

describe("Digest", () => {
  it("labels the issue with its anchored period", async () => {
    mockApi({ "GET /api/v1/digest": digest() });
    renderWithProviders(<Digest />);

    expect(await screen.findByText("The iroha Digest")).toBeDefined();
    expect(screen.getByText("Week of 2026-07-20")).toBeDefined();
  });

  it("renders templated copy — never a blank page — when no prose has been composed", async () => {
    mockApi({ "GET /api/v1/digest": digest() });
    renderWithProviders(<Digest />);

    expect(await screen.findByText(/No prose has been composed for this period yet/)).toBeDefined();
    expect(screen.getByText(/Run \/iroha:digest/)).toBeDefined();
  });

  it("shows the composed headline and marks it unreviewed", async () => {
    mockApi({
      "GET /api/v1/digest": digest({
        prose: {
          composedAt: "2026-07-23T00:00:00.000Z",
          unreviewed: true,
          prose: {
            headline: "2 edits the Guardrails caught",
            standfirst: "Both in one package.",
            sections: [
              { slot: "stumbles", heading: "Where it stopped", body: "The hook held the line." },
            ],
          },
        },
      }),
    });
    renderWithProviders(<Digest />);

    expect(await screen.findByText("2 edits the Guardrails caught")).toBeDefined();
    expect(screen.getByText("Both in one package.")).toBeDefined();
    // The label is the honest counterweight to prose that could contradict a
    // correct number — the one failure the fact-ID seam cannot catch.
    expect(screen.getByText(/Auto-composed, unreviewed/)).toBeDefined();
    expect(screen.getByText("Where it stopped")).toBeDefined();
  });

  it("attributes denials to rules and names an unattributed one", async () => {
    mockApi({
      "GET /api/v1/digest": digest({
        local: {
          denials: {
            value: 5,
            priorValue: 2,
            byRule: [
              { ruleId: "kn_abc", ruleTitle: "Never touch generated files", count: 3 },
              { ruleId: null, ruleTitle: null, count: 2 },
            ],
          },
          checkpoints: {
            value: 0,
            priorValue: 0,
            byOutcome: { completed: 0, partial: 0, blocked: 0, no_change: 0 },
          },
          sessions: { value: 1, priorValue: 0 },
          pendingReviewLearnings: 0,
          correlations: EMPTY_LIST,
        },
      }),
    });
    renderWithProviders(<Digest />);

    expect(await screen.findByText("Never touch generated files")).toBeDefined();
    expect(screen.getByText("(rule not recorded)")).toBeDefined();
    expect(screen.getByText("Previous period: 2")).toBeDefined();
  });

  it("reports Guardrails the hook cannot enforce alongside the ones it can", async () => {
    mockApi({
      "GET /api/v1/digest": digest({
        team: {
          knowledge: { value: 0, priorValue: 0, byType: EMPTY_BY_TYPE },
          guardrailsChanged: EMPTY_LIST,
          reviewLearnings: EMPTY_LIST,
          rulesetAdequacy: { enforceable: 4, not_hook_enforceable: 1, invalid: 2 },
        },
      }),
    });
    renderWithProviders(<Digest />);

    expect(await screen.findByText("Not enforceable at the hook")).toBeDefined();
    expect(screen.getByText("Malformed spec")).toBeDefined();
  });

  it("shows a denial cluster when iroha found one", async () => {
    mockApi({
      "GET /api/v1/digest": digest({
        local: {
          denials: { value: 3, priorValue: 0, byRule: [] },
          checkpoints: {
            value: 0,
            priorValue: 0,
            byOutcome: { completed: 0, partial: 0, blocked: 0, no_change: 0 },
          },
          sessions: { value: 1, priorValue: 0 },
          pendingReviewLearnings: 0,
          correlations: {
            items: [
              {
                kind: "denial_cluster",
                key: "packages/git",
                paths: ["packages/git/a.ts", "packages/git/b.ts"],
                count: 3,
              },
            ],
            total: 1,
            truncated: false,
          },
        },
      }),
    });
    renderWithProviders(<Digest />);

    expect(await screen.findByText("Where denials clustered")).toBeDefined();
    // The badge names the cluster, which is also what its fact id is built from.
    expect(screen.getByText("packages/git")).toBeDefined();
  });

  it("states that advisory rules are not measured instead of implying a score", async () => {
    mockApi({ "GET /api/v1/digest": digest() });
    renderWithProviders(<Digest />);

    expect(await screen.findByText(/leave no machine-observable trace/)).toBeDefined();
  });

  it("disables the newer-issue control from the offset the server resolved", async () => {
    mockApi({ "GET /api/v1/digest": digest() });
    renderWithProviders(<Digest />);

    const newer = await screen.findByRole("button", { name: "Newer issue" });
    expect(newer.hasAttribute("disabled")).toBe(true);
  });

  it("enables the newer-issue control on a back issue the server actually served", async () => {
    // The requested offset is not the authority: an out-of-range request is
    // clamped, so the control must follow `period.offset` from the response.
    mockApi({
      "GET /api/v1/digest": digest({
        period: {
          unit: "week",
          key: "2026-07-13",
          start: "2026-07-13T00:00:00.000Z",
          end: "2026-07-20T00:00:00.000Z",
          offset: 1,
        },
      }),
    });
    renderWithProviders(<Digest />);

    const newer = await screen.findByRole("button", { name: "Newer issue" });
    expect(newer.hasAttribute("disabled")).toBe(false);
  });
});
