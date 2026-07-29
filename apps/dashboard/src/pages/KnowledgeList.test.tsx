import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeList } from "@/pages/KnowledgeList.js";
import { mockApi, ok, renderWithProviders } from "@/test-utils.js";

function knowledgeItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: "decision",
    title: id,
    summary: null,
    authority: 100,
    status: "approved",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Serves a distinct row per page, so a wrong `offset` shows the wrong title. */
function mockPagedByOffset(total: number): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://x");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const data = {
      items: [knowledgeItem(`Row at ${offset}`)],
      nextCursor: null,
      total,
    };
    return new Response(JSON.stringify({ ok: true, data, meta: { requestId: "r" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("KnowledgeList", () => {
  it("requests the page's offset and renders that page's rows", async () => {
    mockPagedByOffset(25);
    renderWithProviders(<KnowledgeList />);

    // Page 1 asks for offset 0; the fixture echoes it back in the title, so a
    // page button that did not change the offset would still show "Row at 0".
    expect(await screen.findByText("Row at 0")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "3" }));
    expect(await screen.findByText("Row at 20")).toBeInTheDocument();
  });

  it("shows no pagination when everything fits on one page", async () => {
    mockPagedByOffset(4);
    renderWithProviders(<KnowledgeList />);

    await screen.findByText("Row at 0");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("sends the selected type as a repeated query param and returns to page 1", async () => {
    const fn = mockApi({
      "GET /api/v1/knowledge": ok({ items: [], nextCursor: null, total: 0 }),
    });
    renderWithProviders(<KnowledgeList />);
    await screen.findByText(/No approved knowledge/);

    await userEvent.click(screen.getByRole("button", { name: "Decision" }));
    await waitFor(() => {
      const last = new URL(String(fn.mock.calls.at(-1)?.[0]), "http://x").searchParams;
      expect(last.getAll("type")).toContain("decision");
      // A filter change that kept the old page would ask past the end of the
      // smaller result set and render an empty page instead of the matches.
      expect(last.get("offset")).toBe("0");
    });
  });
});
