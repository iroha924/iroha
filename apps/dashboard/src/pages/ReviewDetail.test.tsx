import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ReviewDetail } from "@/pages/ReviewDetail.js";
import { mockApi, ok, renderWithProviders } from "@/test-utils.js";

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "cand_x",
    type: "decision",
    status: "pending",
    confidence: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    revisionToken: "tok1",
    source: { sessionId: null, checkpointId: null },
    draft: {
      type: "decision",
      title: "Use libSQL",
      summary: "chosen",
      body: "# Use libSQL\n\n## Context\n\nx",
      labels: [],
      scope: { paths: [], symbols: [] },
      sources: [{ type: "commit", ref: "abc1234" }],
    },
    canonicalPreview: "---\nid: dec_x\n---\n\n# Use libSQL",
    validation: {
      schemaValid: true,
      bodyValid: true,
      secretsClean: true,
      approvable: true,
      issues: [],
      secretFindings: [],
    },
    ...overrides,
  };
}

function renderDetail() {
  return renderWithProviders(
    <Routes>
      <Route path="/review/:id" element={<ReviewDetail />} />
    </Routes>,
    ["/review/cand_x"],
  );
}

describe("ReviewDetail", () => {
  it("enables approval only after a reviewer name is entered, then approves via keyboard", async () => {
    const fetchMock = mockApi({
      "GET /api/v1/candidates/cand_x": ok(candidate()),
      "POST /api/v1/candidates/cand_x/approve": ok({
        candidateId: "cand_x",
        entityId: "dec_x",
        canonicalPath: "decisions/dec_x.md",
        type: "decision",
        revision: 1,
      }),
    });
    renderDetail();

    const approve = await screen.findByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();

    await userEvent.click(screen.getByLabelText("Reviewer name"));
    await userEvent.keyboard("Alice");
    expect(approve).toBeEnabled();

    await userEvent.click(approve);
    await waitFor(() => {
      const called = fetchMock.mock.calls.some(
        (c) => String(c[0]).includes("/approve") && (c[1] as RequestInit)?.method === "POST",
      );
      expect(called).toBe(true);
    });
  });

  it("prefills the reviewer from the local Git identity", async () => {
    mockApi({
      "GET /api/v1/candidates/cand_x": ok(candidate()),
      "GET /api/v1/people": ok({ names: ["alice", "iroha924"], self: "iroha924" }),
    });
    renderDetail();

    await waitFor(() => expect(screen.getByLabelText("Reviewer name")).toHaveValue("iroha924"));
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  // Prefilling writes a name into the same field the picker filters on, so
  // sharing one piece of state between them leaves only the prefilled name.
  it("still offers everyone in the picker when the field was prefilled", async () => {
    mockApi({
      "GET /api/v1/candidates/cand_x": ok(candidate()),
      "GET /api/v1/people": ok({ names: ["alice", "bob", "iroha924"], self: "iroha924" }),
    });
    renderDetail();
    await waitFor(() => expect(screen.getByLabelText("Reviewer name")).toHaveValue("iroha924"));

    await userEvent.click(screen.getByRole("combobox", { name: "Pick from list" }));

    expect(await screen.findByRole("option", { name: "alice" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "bob" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "iroha924" })).toBeInTheDocument();
  });

  // Choosing a name is not a search for it; reopening must not show one entry.
  it("restores the whole list after a name is picked", async () => {
    mockApi({
      "GET /api/v1/candidates/cand_x": ok(candidate()),
      "GET /api/v1/people": ok({ names: ["alice", "bob", "iroha924"], self: null }),
    });
    renderDetail();

    const field = await screen.findByLabelText("Reviewer name");
    await userEvent.click(field);
    await userEvent.keyboard("ali");
    await userEvent.click(screen.getByRole("combobox", { name: "Pick from list" }));
    await userEvent.click(await screen.findByRole("option", { name: "alice" }));
    await waitFor(() => expect(field).toHaveValue("alice"));

    await userEvent.click(screen.getByRole("combobox", { name: "Pick from list" }));

    expect(await screen.findByRole("option", { name: "bob" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "iroha924" })).toBeInTheDocument();
  });

  it("narrows the picker to names matching what was typed", async () => {
    mockApi({
      "GET /api/v1/candidates/cand_x": ok(candidate()),
      "GET /api/v1/people": ok({ names: ["alice", "bob", "iroha924"], self: null }),
    });
    renderDetail();

    const field = await screen.findByLabelText("Reviewer name");
    await userEvent.click(field);
    await userEvent.keyboard("iro");

    await userEvent.click(screen.getByRole("combobox", { name: "Pick from list" }));
    expect(await screen.findByRole("option", { name: "iroha924" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "alice" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("option", { name: "iroha924" }));
    await waitFor(() => expect(field).toHaveValue("iroha924"));
  });

  it("still approves under a name Git has never seen", async () => {
    const fetchMock = mockApi({
      "GET /api/v1/candidates/cand_x": ok(candidate()),
      "GET /api/v1/people": ok({ names: ["alice"], self: null }),
      "POST /api/v1/candidates/cand_x/approve": ok({
        candidateId: "cand_x",
        entityId: "dec_x",
        canonicalPath: "decisions/dec_x.md",
        type: "decision",
        revision: 1,
      }),
    });
    renderDetail();

    await userEvent.click(await screen.findByLabelText("Reviewer name"));
    await userEvent.keyboard("someone-new");

    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeEnabled();
    await userEvent.click(approve);

    await waitFor(() => {
      const body = fetchMock.mock.calls.find((c) => String(c[0]).includes("/approve"))?.[1] as
        | RequestInit
        | undefined;
      expect(String(body?.body)).toContain("someone-new");
    });
  });

  it("blocks approval and warns when a secret is detected", async () => {
    mockApi({
      "GET /api/v1/candidates/cand_x": ok(
        candidate({
          canonicalPreview: null,
          validation: {
            schemaValid: true,
            bodyValid: true,
            secretsClean: false,
            approvable: false,
            issues: ["A possible secret was detected; approval is blocked."],
            secretFindings: [{ ruleId: "rsa", message: "masked" }],
          },
        }),
      ),
    });
    renderDetail();

    expect(await screen.findByRole("alert")).toHaveTextContent(/secret was detected/i);
    await userEvent.click(screen.getByLabelText("Reviewer name"));
    await userEvent.keyboard("Alice");
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });
});
