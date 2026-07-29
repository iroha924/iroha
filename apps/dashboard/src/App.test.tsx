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
  rulesetAdequacy: { enforceable: 2, not_hook_enforceable: 1, invalid: 0 },
  denials: {
    windowDays: 30,
    total: 0,
    byRule: [],
    clusters: { items: [], total: 0, truncated: false },
  },
  pendingReviewLearnings: 0,
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
    expect(await screen.findByRole("link", { name: "Candidates" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "JA" }));
    expect(await screen.findByRole("link", { name: "ナレッジ候補" })).toBeInTheDocument();
  });

  it("never renders an individual ranking on the overview", async () => {
    mockApi({ "GET /api/v1/bootstrap": BOOTSTRAP, "GET /api/v1/overview": OVERVIEW });
    renderWithProviders(<App />);
    await screen.findByRole("link", { name: "Candidates" });
    expect(screen.queryByText(/ranking/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/leaderboard/i)).not.toBeInTheDocument();
  });

  it("redirects an unknown path to the front page instead of rendering it blank", async () => {
    // `/overview` moved to `/` in this change; a bookmark of it — or any typo —
    // matched no route and left `main` empty, which reads as a broken app.
    mockApi({ "GET /api/v1/bootstrap": BOOTSTRAP, "GET /api/v1/overview": OVERVIEW });
    renderWithProviders(<App />, ["/overview"]);

    expect(await screen.findByText("Guardrail enforceability")).toBeInTheDocument();
  });
});
