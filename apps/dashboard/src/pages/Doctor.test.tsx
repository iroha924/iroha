import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Doctor } from "@/pages/Doctor.js";
import { mockApi, ok, renderWithProviders } from "@/test-utils.js";

const CHECKS = { checks: [{ name: "git", status: "ok", message: "git 2.49.0" }] };

describe("Doctor", () => {
  it("lists recent failures with their source, duration, and error code", async () => {
    mockApi({
      "GET /api/v1/doctor": ok(CHECKS),
      "GET /api/v1/events": ok({
        events: [
          {
            id: "log_01JQZ0000000000000000001",
            eventType: "api.request",
            adapter: "GET /api/v1/knowledge/:id",
            durationMs: 8,
            outcome: "warning",
            errorCode: "NOT_FOUND",
            occurredAt: "2026-01-01T09:30:00.000Z",
          },
          {
            id: "log_01JQZ0000000000000000002",
            eventType: "mcp.tool_call",
            adapter: "create_checkpoint",
            durationMs: 143,
            outcome: "failure",
            errorCode: "INTERNAL_ERROR",
            occurredAt: "2026-01-01T09:29:00.000Z",
          },
        ],
      }),
    });
    renderWithProviders(<Doctor />);

    expect(await screen.findByText("api.request")).toBeDefined();
    expect(screen.getByText("NOT_FOUND")).toBeDefined();
    expect(screen.getByText("GET /api/v1/knowledge/:id")).toBeDefined();
    // The label, not the stored value: the badge renders `evoutcome.warning`.
    expect(screen.getByText("Warning")).toBeDefined();
    expect(screen.queryByText("warning")).toBeNull();
    expect(screen.getByText("8 ms")).toBeDefined();
    expect(screen.getByText("create_checkpoint")).toBeDefined();
    expect(screen.getByText("2026-01-01 09:29:00")).toBeDefined();
  });

  it("shows an empty state when nothing has failed", async () => {
    mockApi({
      "GET /api/v1/doctor": ok(CHECKS),
      "GET /api/v1/events": ok({ events: [] }),
    });
    renderWithProviders(<Doctor />);

    expect(await screen.findByText(/Nothing has failed/)).toBeDefined();
  });
});
