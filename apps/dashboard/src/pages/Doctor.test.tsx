import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Doctor } from "@/pages/Doctor.js";
import { mockApi, ok, renderWithProviders } from "@/test-utils.js";

const CHECKS = { checks: [{ name: "git", status: "ok", message: "git 2.49.0" }] };

describe("Doctor", () => {
  it("lists recent diagnostics events with their source, duration, and error code", async () => {
    mockApi({
      "GET /api/v1/doctor": ok(CHECKS),
      "GET /api/v1/events": ok({
        events: [
          {
            id: "log_01JQZ0000000000000000001",
            eventType: "guardrail.denied",
            adapter: "claude_code",
            durationMs: 8,
            outcome: "denied",
            errorCode: "kno_01JQZ0000000000000000000",
            occurredAt: "2026-01-01T09:30:00.000Z",
          },
          {
            id: "log_01JQZ0000000000000000002",
            eventType: "mcp.tool_call",
            adapter: "create_checkpoint",
            durationMs: 143,
            outcome: "success",
            errorCode: null,
            occurredAt: "2026-01-01T09:29:00.000Z",
          },
        ],
      }),
    });
    renderWithProviders(<Doctor />);

    expect(await screen.findByText("guardrail.denied")).toBeDefined();
    expect(screen.getByText("kno_01JQZ0000000000000000000")).toBeDefined();
    expect(screen.getByText("claude_code")).toBeDefined();
    expect(screen.getByText("denied")).toBeDefined();
    expect(screen.getByText("8 ms")).toBeDefined();
    expect(screen.getByText("create_checkpoint")).toBeDefined();
    expect(screen.getByText("2026-01-01 09:29:00")).toBeDefined();
  });

  it("shows an empty state when nothing has been recorded yet", async () => {
    mockApi({
      "GET /api/v1/doctor": ok(CHECKS),
      "GET /api/v1/events": ok({ events: [] }),
    });
    renderWithProviders(<Doctor />);

    expect(await screen.findByText(/No events recorded yet/)).toBeDefined();
  });
});
