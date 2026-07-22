import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Graph } from "@/pages/Graph.js";
import { mockApi, ok, renderWithProviders } from "@/test-utils.js";

function knowledgeItem(id: string, title: string) {
  return {
    id,
    type: "decision",
    title,
    summary: null,
    authority: 100,
    status: "approved",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const NODE = {
  id: "dec_1",
  type: "decision",
  title: "Use libSQL",
  authority: 100,
  status: "approved",
};

function bodyOf(call: unknown[]): unknown {
  return JSON.parse(String((call[1] as RequestInit).body));
}

describe("Graph", () => {
  it("seeds the graph from picked entities via graphQuery(roots, depth)", async () => {
    const fn = mockApi({
      "GET /api/v1/knowledge": ok({
        items: [knowledgeItem("dec_1", "Use libSQL")],
        nextCursor: null,
      }),
      "GET /api/v1/sessions": ok({ items: [], nextCursor: null }),
      "POST /api/v1/graph/query": ok({ nodes: [NODE], edges: [], truncated: false }),
    });
    renderWithProviders(<Graph />);

    await userEvent.click(await screen.findByRole("button", { name: "Use libSQL" }));
    // Depth defaults to 2; the button reflects the one selected seed.
    await userEvent.click(screen.getByRole("button", { name: /Load graph \(1\)/ }));

    await waitFor(() => {
      const call = fn.mock.calls.find((c) => String(c[0]).endsWith("/api/v1/graph/query"));
      expect(call).toBeDefined();
      expect(bodyOf(call as unknown[])).toEqual({ roots: ["dec_1"], depth: 2 });
    });
  });

  it("enables Find path only with two seeds and calls graphPath", async () => {
    const fn = mockApi({
      "GET /api/v1/knowledge": ok({
        items: [knowledgeItem("dec_1", "First"), knowledgeItem("dec_2", "Second")],
        nextCursor: null,
      }),
      "GET /api/v1/sessions": ok({ items: [], nextCursor: null }),
      "GET /api/v1/graph/path": ok({ found: false, edges: [], nodes: [] }),
    });
    renderWithProviders(<Graph />);

    // Wait for the seed chips (populated by the async knowledge query) to render.
    const first = await screen.findByRole("button", { name: "First" });
    const findPath = screen.getByRole("button", { name: "Find path" });
    expect(findPath).toBeDisabled();

    await userEvent.click(first);
    expect(findPath).toBeDisabled(); // one seed is not enough
    await userEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(findPath).toBeEnabled();

    await userEvent.click(findPath);
    await waitFor(() => {
      const call = fn.mock.calls.find((c) => String(c[0]).includes("/api/v1/graph/path"));
      expect(call).toBeDefined();
      const url = new URL(String(call?.[0]), "http://x");
      expect(url.searchParams.get("from")).toBe("dec_1");
      expect(url.searchParams.get("to")).toBe("dec_2");
    });
    // No path found → the not-found note is shown.
    expect(await screen.findByText(/No path found/)).toBeInTheDocument();
  });
});
