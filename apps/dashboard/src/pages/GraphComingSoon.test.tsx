import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GraphComingSoon } from "@/pages/GraphComingSoon.js";
import { mockApi, renderWithProviders } from "@/test-utils.js";

describe("GraphComingSoon", () => {
  it("titles the page once and says when the graph arrives", () => {
    mockApi({});
    renderWithProviders(<GraphComingSoon />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText(/still in development/)).toBeInTheDocument();
    expect(screen.getByText(/lands here once it reads better/)).toBeInTheDocument();
  });

  it("queries nothing — a placeholder in front of a live fetch still costs a request", () => {
    const fn = mockApi({});
    renderWithProviders(<GraphComingSoon />);

    expect(fn).not.toHaveBeenCalled();
  });
});
