import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Sessions } from "@/pages/Sessions.js";
import { mockApi, ok, renderWithProviders } from "@/test-utils.js";

function param(url: string, key: string): string | null {
  return new URL(url, "http://x").searchParams.get(key);
}

describe("Sessions", () => {
  it("widens the picked `to` date to the end of the UTC day and sends the platform filter", async () => {
    const fn = mockApi({ "GET /api/v1/sessions": ok({ items: [], nextCursor: null }) });
    renderWithProviders(<Sessions />);
    await screen.findByText(/No sessions yet/);

    // Open the "To" date picker and choose a day from the calendar grid. The exact
    // day is irrelevant — the test asserts the bare date is widened to the end of
    // the UTC day (so the selected day is included in `last_seen_at <= ?`).
    await userEvent.click(screen.getByRole("button", { name: "To" }));
    let days: HTMLElement[] = [];
    await waitFor(() => {
      days = screen
        .getAllByRole("button")
        .filter((b) => /^\d+$/.test((b.textContent ?? "").trim()));
      expect(days.length).toBeGreaterThan(10);
    });
    const pick = days[Math.floor(days.length / 2)];
    if (pick === undefined) throw new Error("no day button to pick");
    await userEvent.click(pick);

    await waitFor(() =>
      expect(
        fn.mock.calls.some((c) => {
          const to = param(String(c[0]), "to");
          return to !== null && /^\d{4}-\d{2}-\d{2}T23:59:59\.999Z$/.test(to);
        }),
      ).toBe(true),
    );

    await userEvent.click(screen.getByRole("button", { name: "Codex" }));
    await waitFor(() =>
      expect(fn.mock.calls.some((c) => param(String(c[0]), "platform") === "codex")).toBe(true),
    );
  });
});
