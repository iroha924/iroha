import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionDetail } from "@/pages/SessionDetail.js";
import { mockApi, ok, renderWithProviders } from "@/test-utils.js";

function session() {
  return {
    id: "ses_x",
    platform: "claude_code",
    startedAt: "2026-07-06T10:00:00.000Z",
    lastSeenAt: "2026-07-06T11:00:00.000Z",
    summaryStatus: "none",
    runs: [],
    checkpoints: [
      {
        id: "chk_x",
        turnId: "trn_x",
        outcome: "completed",
        objective: "Move PaymentService onto the repository port",
        createdAt: "2026-07-06T10:30:00.000Z",
      },
    ],
  };
}

describe("SessionDetail", () => {
  it("links each checkpoint row to its detail page", async () => {
    mockApi({ "GET /api/v1/sessions/ses_x": ok(session()) });
    renderWithProviders(
      <Routes>
        <Route path="/sessions/:id" element={<SessionDetail />} />
      </Routes>,
      ["/sessions/ses_x"],
    );

    const link = await screen.findByRole("link", {
      name: "Move PaymentService onto the repository port",
    });
    expect(link.getAttribute("href")).toBe("/sessions/ses_x/checkpoints/chk_x");
  });
});
