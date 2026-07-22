import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ReviewQueue } from "@/pages/ReviewQueue.js";
import { mockApi, ok, renderWithProviders } from "@/test-utils.js";

function statusOf(url: string): string | null {
  return new URL(url, "http://x").searchParams.get("status");
}

describe("ReviewQueue", () => {
  it("defaults to pending and switches the status filter on tab click", async () => {
    const fn = mockApi({ "GET /api/v1/candidates": ok({ items: [], nextCursor: null }) });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText(/No candidates awaiting review/);

    // The default request carries the pending status.
    expect(fn.mock.calls.some((c) => statusOf(String(c[0])) === "pending")).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Approved" }));
    await waitFor(() =>
      expect(fn.mock.calls.some((c) => statusOf(String(c[0])) === "approved")).toBe(true),
    );
  });
});
