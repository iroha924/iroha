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

/** Serves page 1 with no cursor and page 2 when a cursor is present. */
function mockTwoPages(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://x");
    const data =
      url.searchParams.get("cursor") === null
        ? { items: [knowledgeItem("First")], nextCursor: "CUR1" }
        : { items: [knowledgeItem("Second", { type: "rule" })], nextCursor: null };
    return new Response(JSON.stringify({ ok: true, data, meta: { requestId: "r" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("KnowledgeList", () => {
  it("loads the next page via cursor and hides Load more when exhausted", async () => {
    mockTwoPages();
    renderWithProviders(<KnowledgeList />);

    expect(await screen.findByText("First")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Second")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument(),
    );
  });

  it("sends the selected type as a repeated query param", async () => {
    const fn = mockApi({ "GET /api/v1/knowledge": ok({ items: [], nextCursor: null }) });
    renderWithProviders(<KnowledgeList />);
    await screen.findByText(/No approved knowledge/);

    await userEvent.click(screen.getByRole("button", { name: "decision" }));
    await waitFor(() =>
      expect(
        fn.mock.calls.some((c) =>
          new URL(String(c[0]), "http://x").searchParams.getAll("type").includes("decision"),
        ),
      ).toBe(true),
    );
  });
});
