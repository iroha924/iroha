import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { KnowledgeDetail } from "@/pages/KnowledgeDetail.js";
import { mockApi, ok, renderWithProviders } from "@/test-utils.js";

function knowledge(overrides: Record<string, unknown> = {}) {
  return {
    id: "pat_x",
    type: "pattern",
    title: "Keyed batch fetch for page enrichment",
    summary: "Fetch related rows once, keyed by id.",
    status: "approved",
    authority: 100,
    body: "# Keyed batch fetch\n\n## Problem\n\nAn N+1 read per row.",
    canonicalPath: "patterns/pat_x.md",
    revision: 3,
    approvedAt: "2026-07-06T10:00:00.000Z",
    frontmatter: {
      created_by: { provider: "git", display_name: "Alice" },
      approved_by: { provider: "git", display_name: "Bob" },
      labels: ["performance"],
      scope: { paths: ["packages/storage/src"], symbols: ["getEntitiesByIds"] },
      sources: [{ type: "commit", ref: "abc1234", url: "https://example.com/c/abc1234" }],
    },
    relations: [],
    ...overrides,
  };
}

function renderDetail() {
  return renderWithProviders(
    <Routes>
      <Route path="/knowledge/:id" element={<KnowledgeDetail />} />
    </Routes>,
    ["/knowledge/pat_x"],
  );
}

describe("KnowledgeDetail", () => {
  it("renders the body as Markdown, not raw markers", async () => {
    mockApi({ "GET /api/v1/knowledge/pat_x": ok(knowledge()) });
    renderDetail();

    expect(await screen.findByRole("heading", { name: "Problem" })).toBeDefined();
    expect(screen.queryByText("## Problem")).toBeNull();
  });

  it("surfaces the provenance the API returns", async () => {
    mockApi({ "GET /api/v1/knowledge/pat_x": ok(knowledge()) });
    renderDetail();

    await screen.findByRole("heading", { name: "Problem" });
    // Approver, source link, scope, label, and canonical path all shown.
    expect(screen.getByText("Bob", { exact: false })).toBeDefined();
    expect(screen.getByRole("link", { name: "abc1234" }).getAttribute("href")).toBe(
      "https://example.com/c/abc1234",
    );
    expect(screen.getByText("packages/storage/src")).toBeDefined();
    expect(screen.getByText("performance")).toBeDefined();
    expect(screen.getByText("patterns/pat_x.md")).toBeDefined();
  });
});
