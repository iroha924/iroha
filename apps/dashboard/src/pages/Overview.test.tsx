import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Overview } from "@/pages/Overview.js";
import { mockApi, ok, renderWithProviders } from "@/test-utils.js";

function overview(latestCheckpoint: unknown) {
  return ok({
    pendingCandidates: 0,
    oldestPendingCreatedAt: null,
    approvedKnowledge: 0,
    approvedKnowledgeByType: {
      decision: 0,
      rule: 0,
      concept: 0,
      insight: 0,
      incident: 0,
      pattern: 0,
      review_learning: 0,
    },
    openDirtyMarkers: 0,
    lastCanonicalSyncAt: null,
    rulesetAdequacy: { enforceable: 0, not_hook_enforceable: 0, invalid: 0 },
    denials: {
      windowDays: 30,
      total: 0,
      byRule: [],
      clusters: { items: [], total: 0, truncated: false },
    },
    pendingReviewLearnings: 0,
    latestCheckpoint,
  });
}

// The card exists because this text reaches an agent without passing review
// (#199), so the assertions are that the text is on the page — not that some
// container rendered.
describe("Overview: what the agent is handed back", () => {
  it("shows the latest Checkpoint's summary and each unresolved item", async () => {
    mockApi({
      "GET /api/v1/overview": overview({
        id: "chk_01JQZ0000000000000000001",
        outcome: "partial",
        summary: "Reverted the url guard; the timestamp and integer arms stand.",
        unresolved: ["Decide whether to close #169", "SDK bump waits for the release-age hold"],
        createdAt: "2026-07-30T05:46:14.154Z",
        sessionId: "ses_01JQZ0000000000000000001",
      }),
    });
    renderWithProviders(<Overview />);

    await waitFor(() => {
      expect(
        screen.getByText("Reverted the url guard; the timestamp and integer arms stand."),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Decide whether to close #169")).toBeInTheDocument();
    expect(screen.getByText("SDK bump waits for the release-age hold")).toBeInTheDocument();
    // The outcome and id are what let a reader tell which record they are reading.
    expect(screen.getByText(/chk_01JQZ0000000000000000001/)).toBeInTheDocument();
    expect(screen.getByText(/partial/)).toBeInTheDocument();
    // With two agents in one repository, the session id is the only thing saying
    // which of them this text goes back to, and there is no detail view to look
    // it up in.
    expect(screen.getByText(/ses_01JQZ0000000000000000001/)).toBeInTheDocument();
  });

  it("says nothing is unresolved rather than rendering an empty list", async () => {
    mockApi({
      "GET /api/v1/overview": overview({
        id: "chk_01JQZ0000000000000000002",
        outcome: "completed",
        summary: "Cut 0.6.1.",
        unresolved: [],
        createdAt: "2026-07-30T05:25:38.104Z",
        sessionId: "ses_01JQZ0000000000000000001",
      }),
    });
    renderWithProviders(<Overview />);

    await waitFor(() => {
      expect(screen.getByText("Cut 0.6.1.")).toBeInTheDocument();
    });
    expect(screen.getByText("Nothing left unresolved.")).toBeInTheDocument();
  });

  it("shows the empty state when no Checkpoint has been written", async () => {
    mockApi({ "GET /api/v1/overview": overview(null) });
    renderWithProviders(<Overview />);

    await waitFor(() => {
      expect(screen.getByText("No Checkpoint written yet.")).toBeInTheDocument();
    });
  });
});
