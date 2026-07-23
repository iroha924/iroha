import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "@/App.js";
import { fail, mockApi, ok, renderWithProviders } from "@/test-utils.js";

const BOOTSTRAP = ok({
  repository: { id: "repo_x", defaultLanguage: "en", requireHumanApproval: true },
  schema: { version: "1", supported: true },
  capabilities: { ftsUnicode61: true, ftsTrigram: true, vector: false },
  embedding: { enabled: false, keyPresent: false },
});

const OVERVIEW = ok({
  pendingCandidates: 2,
  oldestPendingCreatedAt: null,
  approvedKnowledge: 3,
  approvedKnowledgeByType: {
    decision: 1,
    rule: 1,
    concept: 1,
    insight: 0,
    incident: 0,
    pattern: 0,
    review_learning: 0,
  },
  sessions: 1,
  openDirtyMarkers: 0,
  recentSessions: [],
  lastCanonicalSyncAt: null,
});

describe("App", () => {
  it("shows the relaunch prompt when the session is invalid", async () => {
    mockApi({ "GET /api/v1/bootstrap": fail("INVALID_SESSION_TOKEN", 401) });
    renderWithProviders(<App />);
    expect(await screen.findByText(/Launch from the iroha dashboard/)).toBeInTheDocument();
  });

  it("defaults to English and toggles to Japanese", async () => {
    mockApi({ "GET /api/v1/bootstrap": BOOTSTRAP, "GET /api/v1/overview": OVERVIEW });
    renderWithProviders(<App />);

    // English nav by default (distributable-language rule).
    expect(await screen.findByRole("link", { name: "Review" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "JA" }));
    expect(await screen.findByRole("link", { name: "レビュー待ち" })).toBeInTheDocument();
  });

  it("never renders an individual ranking on the overview", async () => {
    mockApi({ "GET /api/v1/bootstrap": BOOTSTRAP, "GET /api/v1/overview": OVERVIEW });
    renderWithProviders(<App />);
    await screen.findByRole("link", { name: "Review" });
    expect(screen.queryByText(/ranking/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/leaderboard/i)).not.toBeInTheDocument();
  });
});
