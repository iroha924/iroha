import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Sessions } from "@/pages/Sessions.js";
import { mockApi, ok, renderWithProviders } from "@/test-utils.js";

function param(url: string, key: string): string | null {
  return new URL(url, "http://x").searchParams.get(key);
}

describe("Sessions", () => {
  it("widens the `to` date to the end of the UTC day and sends the platform filter", async () => {
    const fn = mockApi({ "GET /api/v1/sessions": ok({ items: [], nextCursor: null }) });
    renderWithProviders(<Sessions />);
    await screen.findByText(/No sessions yet/);

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-01-15" } });
    await waitFor(() =>
      expect(
        fn.mock.calls.some((c) => param(String(c[0]), "to") === "2026-01-15T23:59:59.999Z"),
      ).toBe(true),
    );

    await userEvent.click(screen.getByRole("button", { name: "Codex" }));
    await waitFor(() =>
      expect(fn.mock.calls.some((c) => param(String(c[0]), "platform") === "codex")).toBe(true),
    );
  });
});
