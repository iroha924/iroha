import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewQueue } from "@/pages/ReviewQueue.js";
import { mockApi, ok, renderWithProviders } from "@/test-utils.js";

function statusOf(url: string): string | null {
  return new URL(url, "http://x").searchParams.get("status");
}

function rows(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `cand_${from + i}`,
    type: "decision",
    status: "pending",
    title: `candidate ${from + i}`,
    summary: "",
    confidence: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    revisionToken: "tok",
  }));
}

/** A `fetch` mock that answers `/candidates` from the cursor it was given. */
function mockPagedCandidates(
  pages: Array<{ cursor: string | null; count: number }>,
  total: number,
) {
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://x");
    const cursor = url.searchParams.get("cursor");
    const index = pages.findIndex((_p, i) =>
      i === 0 ? cursor === null : pages[i - 1]?.cursor === cursor,
    );
    const page = pages[index] ?? pages[0];
    if (page === undefined) throw new Error("no page");
    const from = pages.slice(0, index === -1 ? 0 : index).reduce((n, p) => n + p.count, 1);
    return new Response(
      JSON.stringify({
        ok: true,
        data: { items: rows(from, page.count), nextCursor: page.cursor, total },
        meta: { requestId: "req_test" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("ReviewQueue", () => {
  it("defaults to pending and switches the status filter on tab click", async () => {
    const fn = mockApi({
      "GET /api/v1/candidates": ok({ items: [], nextCursor: null, total: 0 }),
    });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText(/No candidates awaiting review/);

    // The default request carries the pending status.
    expect(fn.mock.calls.some((c) => statusOf(String(c[0])) === "pending")).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Approved" }));
    await waitFor(() =>
      expect(fn.mock.calls.some((c) => statusOf(String(c[0])) === "approved")).toBe(true),
    );
  });

  it("requests ten rows and numbers the pages from the reported total", async () => {
    const fn = mockPagedCandidates([{ cursor: "c1", count: 10 }], 26);
    renderWithProviders(<ReviewQueue />);

    await screen.findByText("candidate 1");
    expect(screen.getAllByText(/^candidate \d+$/)).toHaveLength(10);
    // 26 candidates at ten per page is three pages, and the range reads 1-10.
    expect(screen.getByRole("button", { name: "3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "4" })).not.toBeInTheDocument();
    expect(screen.getByText("1–10 / 26")).toBeInTheDocument();
    expect(new URL(String(fn.mock.calls[0]?.[0]), "http://x").searchParams.get("limit")).toBe("10");
  });

  it("walks the cursor forward to reach a deep-linked page", async () => {
    mockPagedCandidates(
      [
        { cursor: "c1", count: 10 },
        { cursor: null, count: 10 },
      ],
      20,
    );
    renderWithProviders(<ReviewQueue />, ["/?status=pending&page=2"]);

    // Page 2 is only reachable by fetching page 1 first, so its rows arrive late.
    expect(await screen.findByText("candidate 11")).toBeInTheDocument();
    expect(screen.queryByText("candidate 1")).not.toBeInTheDocument();
  });

  it("falls back to the last existing page when the URL asks beyond the queue", async () => {
    mockPagedCandidates([{ cursor: null, count: 4 }], 4);
    renderWithProviders(<ReviewQueue />, ["/?status=pending&page=9"]);

    // Four candidates are a single page, so page 9 renders page 1 rather than
    // an empty list, and no pagination bar is drawn at all.
    expect(await screen.findByText("candidate 1")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "pagination" })).not.toBeInTheDocument();
  });

  it("resets to the first page when the status filter changes", async () => {
    mockPagedCandidates(
      [
        { cursor: "c1", count: 10 },
        { cursor: null, count: 10 },
      ],
      20,
    );
    renderWithProviders(<ReviewQueue />, ["/?status=pending&page=2"]);
    await screen.findByText("candidate 11");

    await userEvent.click(screen.getByRole("button", { name: "Rejected" }));

    await waitFor(() => expect(screen.getByText("candidate 1")).toBeInTheDocument());
  });
});
