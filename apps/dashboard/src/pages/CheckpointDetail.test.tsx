import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { CheckpointDetail } from "@/pages/CheckpointDetail.js";
import { mockApi, ok, renderWithProviders } from "@/test-utils.js";

function checkpoint(overrides: Record<string, unknown> = {}) {
  return {
    id: "chk_x",
    sessionId: "ses_x",
    turnId: "trn_x",
    outcome: "completed",
    objective: "Move PaymentService onto the repository port",
    summary: "Introduced a port and moved the query behind it.",
    implementation: [{ file: "src/payments/service.ts", change: "extracted the port" }],
    validation: [{ command: "pnpm test", result: "passed", durationMs: 1200 }],
    unresolved: ["Backfill the migration on staging"],
    references: [{ type: "pull_request", ref: "#42", url: "https://example.com/pr/42" }],
    labels: ["payments"],
    createdAt: "2026-07-06T10:00:00.000Z",
    ...overrides,
  };
}

function renderDetail() {
  return renderWithProviders(
    <Routes>
      <Route path="/sessions/:id/checkpoints/:checkpointId" element={<CheckpointDetail />} />
    </Routes>,
    ["/sessions/ses_x/checkpoints/chk_x"],
  );
}

describe("CheckpointDetail", () => {
  it("renders the checkpoint's implementation, validation, unresolved items, and references", async () => {
    mockApi({ "GET /api/v1/checkpoints/chk_x": ok(checkpoint()) });
    renderDetail();

    expect(await screen.findByText("Move PaymentService onto the repository port")).toBeDefined();
    expect(screen.getByText("src/payments/service.ts")).toBeDefined();
    expect(screen.getByText("extracted the port")).toBeDefined();
    expect(screen.getByText("pnpm test")).toBeDefined();
    expect(screen.getByText("passed")).toBeDefined();
    expect(screen.getByText("Backfill the migration on staging")).toBeDefined();

    const prLink = screen.getByRole("link", { name: "#42" });
    expect(prLink.getAttribute("href")).toBe("https://example.com/pr/42");
  });

  it("shows an error state when the checkpoint is missing", async () => {
    mockApi({});
    renderDetail();

    expect(await screen.findByText("Something went wrong.")).toBeDefined();
  });
});
