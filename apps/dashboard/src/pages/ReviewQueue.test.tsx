import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ReviewQueue } from "@/pages/ReviewQueue.js";
import { mockApi, ok, renderWithProviders } from "@/test-utils.js";

function paramOf(url: string, key: string): string | null {
  return new URL(url, "http://x").searchParams.get(key);
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

/** Serves `/candidates` from `offset`, the way the real endpoint does. */
function mockOffsetCandidates(total: number, pageSize = 10) {
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://x");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const count = Math.max(0, Math.min(pageSize, total - offset));
    return new Response(
      JSON.stringify({
        ok: true,
        data: { items: rows(offset + 1, count), nextCursor: null, total },
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

    expect(fn.mock.calls.some((c) => paramOf(String(c[0]), "status") === "pending")).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Approved" }));
    await waitFor(() =>
      expect(fn.mock.calls.some((c) => paramOf(String(c[0]), "status") === "approved")).toBe(true),
    );
  });

  it("requests ten rows and numbers the pages from the reported total", async () => {
    const fn = mockOffsetCandidates(26);
    renderWithProviders(<ReviewQueue />);

    await screen.findByText("candidate 1");
    expect(screen.getAllByText(/^candidate \d+$/)).toHaveLength(10);
    expect(screen.getByRole("button", { name: "3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "4" })).not.toBeInTheDocument();
    expect(screen.getByText("1–10 / 26")).toBeInTheDocument();
    expect(paramOf(String(fn.mock.calls[0]?.[0]), "limit")).toBe("10");
  });

  // The whole point of offset over a walked cursor: page 5 is one request,
  // and the four pages before it are never fetched.
  it("reaches a deep-linked page in a single request", async () => {
    const fn = mockOffsetCandidates(200);
    renderWithProviders(<ReviewQueue />, ["/?status=pending&page=5"]);

    expect(await screen.findByText("candidate 41")).toBeInTheDocument();
    expect(fn.mock.calls).toHaveLength(1);
    expect(paramOf(String(fn.mock.calls[0]?.[0]), "offset")).toBe("40");
  });

  it("pages forward from a numbered button without refetching earlier pages", async () => {
    const fn = mockOffsetCandidates(50);
    renderWithProviders(<ReviewQueue />);
    await screen.findByText("candidate 1");
    const before = fn.mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "4" }));

    expect(await screen.findByText("candidate 31")).toBeInTheDocument();
    expect(screen.queryByText("candidate 1")).not.toBeInTheDocument();
    const offsets = fn.mock.calls.slice(before).map((c) => paramOf(String(c[0]), "offset"));
    expect(offsets).toContain("30");
    expect(offsets).not.toContain("10");
    expect(offsets).not.toContain("20");
  });

  it("falls back to the last existing page when the URL asks beyond the queue", async () => {
    mockOffsetCandidates(4);
    renderWithProviders(<ReviewQueue />, ["/?status=pending&page=9"]);

    expect(await screen.findByText("candidate 1")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "pagination" })).not.toBeInTheDocument();
  });

  it("treats a non-integer page in the URL as the first page", async () => {
    const fn = mockOffsetCandidates(30);
    renderWithProviders(<ReviewQueue />, ["/?status=pending&page=2.5"]);

    expect(await screen.findByText("candidate 1")).toBeInTheDocument();
    expect(paramOf(String(fn.mock.calls[0]?.[0]), "offset")).toBe("0");
  });

  // `keepPreviousData` keeps the outgoing view on screen across a key change,
  // so the page clamp must not judge the incoming page number against it. A
  // cold mount never hits this, which is why the clamp test above misses it.
  it("keeps a deep-linked page reached from a shorter queue", async () => {
    const totals: Record<string, number> = { pending: 200, rejected: 2 };
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://x");
      const status = url.searchParams.get("status") ?? "pending";
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const total = totals[status] ?? 0;
      const count = Math.max(0, Math.min(10, total - offset));
      return new Response(
        JSON.stringify({
          ok: true,
          data: { items: rows(offset + 1, count), nextCursor: null, total },
          meta: { requestId: "req_test" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    function Harness() {
      return (
        <>
          <Link to="/?status=pending&page=15">deep link</Link>
          <ReviewQueue />
        </>
      );
    }
    renderWithProviders(<Harness />, ["/?status=rejected&page=1"]);
    await screen.findByText("candidate 1");

    await userEvent.click(screen.getByRole("link", { name: "deep link" }));

    // Page 15 of the pending queue starts at row 141; landing on row 1 means
    // the clamp fired against the rejected view's page count.
    expect(await screen.findByText("candidate 141")).toBeInTheDocument();
  });

  it("resets to the first page when the status filter changes", async () => {
    mockOffsetCandidates(20);
    renderWithProviders(<ReviewQueue />, ["/?status=pending&page=2"]);
    await screen.findByText("candidate 11");

    await userEvent.click(screen.getByRole("button", { name: "Rejected" }));

    await waitFor(() => expect(screen.getByText("candidate 1")).toBeInTheDocument());
  });

  // A page number that outran the queue must not render a bordered box with
  // nothing in it, which is what keying the empty state on `total` produced.
  it("shows the empty state, not an empty frame, when a page has no rows", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          data: { items: [], nextCursor: null, total: 4 },
          meta: { requestId: "req_test" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    renderWithProviders(<ReviewQueue />);

    expect(await screen.findByText(/No candidates awaiting review/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
