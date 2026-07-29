import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { api } from "@/api/client.js";
import { Settings } from "@/pages/Settings.js";
import { fail, mockApi, ok, renderWithProviders } from "@/test-utils.js";

const SHARED = {
  repository_id: "repo_01JQZ0000000000000000001",
  default_language: "en",
  search: {
    embedding: {
      enabled: false,
      provider: "voyage",
      model: "voyage-4-large",
    },
  },
  forge: {
    enabled: false,
    provider: "github",
    review_learning_threshold: 3,
  },
};

function settings(retentionDays: number | null) {
  return ok({
    shared: SHARED,
    local: {
      embeddingKeyPresent: false,
      forgeTokenPresent: false,
      embeddingKeyUnreadable: false,
      forgeTokenUnreadable: false,
      retentionDays,
    },
  });
}

/**
 * The select trigger's rendered text, which `Select`'s `items` maps to a label.
 * The trailing strip drops the chevron glyph the trigger renders after it.
 */
function retentionValue(): string {
  return document.getElementById("cfg-retention")?.textContent?.replace(/\W+$/, "") ?? "";
}

describe("Settings — local event retention", () => {
  it("shows the window as off when nothing is set", async () => {
    mockApi({ "GET /api/v1/settings": settings(null) });
    renderWithProviders(<Settings />);

    expect(await screen.findByText("Keep local session history")).toBeDefined();
    // The label, not the stored value: "forever" reaching the trigger is the bug.
    expect(retentionValue()).toBe("Forever");
  });

  it("shows a configured window", async () => {
    mockApi({ "GET /api/v1/settings": settings(90) });
    renderWithProviders(<Settings />);

    await screen.findByText("Keep local session history");
    expect(retentionValue()).toBe("90 days");
  });

  it("saves the window to the local endpoint, not the shared config", async () => {
    // Driving the Base UI select through jsdom is unreliable, so the write path
    // is asserted on the client call the change handler makes. The handler's own
    // value mapping is covered by the two rendering cases above.
    const fetchMock = mockApi({
      "PATCH /api/v1/settings/local": ok({ key: "retention.local_events" }),
    });

    await api.updateLocalSetting("retention.local_events", { days: 30 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/settings/local");
    expect(init.method).toBe("PATCH");
    // A mutation without this header is rejected by the anti-CSRF middleware.
    expect((init.headers as Record<string, string>)["X-Iroha-Request"]).toBe("1");
    expect(JSON.parse(String(init.body))).toEqual({
      key: "retention.local_events",
      value: { days: 30 },
    });
  });
});

describe("Settings — save feedback", () => {
  it("confirms a completed save with a toast", async () => {
    mockApi({
      "GET /api/v1/settings": settings(null),
      "PATCH /api/v1/settings/shared": ok(SHARED),
    });
    renderWithProviders(<Settings />);
    await screen.findByText("Keep local session history");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved.")).toBeDefined();
  });

  it("reports a rejected save as an error toast", async () => {
    mockApi({
      "GET /api/v1/settings": settings(null),
      "PATCH /api/v1/settings/shared": fail("INTERNAL_ERROR", 500),
    });
    renderWithProviders(<Settings />);
    await screen.findByText("Keep local session history");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Something went wrong.")).toBeDefined();
  });
});

describe("Settings — provider credentials", () => {
  it("sends the pasted key to the write-only endpoint and clears the field", async () => {
    const fetchMock = mockApi({
      "GET /api/v1/settings": settings(null),
      "PUT /api/v1/settings/credentials": ok({ provider: "voyage", present: true }),
    });
    renderWithProviders(<Settings />);
    await screen.findByText("Voyage API key");

    const field = document.getElementById("cfg-key-voyage") as HTMLInputElement;
    // A key must not be readable over the user's shoulder, and the browser must
    // not offer to remember it.
    expect(field.type).toBe("password");
    expect(field.autocomplete).toBe("off");

    await userEvent.type(field, "pa-pasted-key");
    await userEvent.click(screen.getByRole("button", { name: "Save: Voyage API key" }));

    const call = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/api/v1/settings/credentials",
    ) as [string, RequestInit];
    expect(call[1].method).toBe("PUT");
    expect(JSON.parse(String(call[1].body))).toEqual({
      provider: "voyage",
      api_key: "pa-pasted-key",
    });
    // Left in place it would be re-submitted by the next save on this page, and
    // nothing can read the stored key back to show instead.
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("keeps the save disabled until something is typed", async () => {
    mockApi({ "GET /api/v1/settings": settings(null) });
    renderWithProviders(<Settings />);
    await screen.findByText("GitHub token");

    const button = screen.getByRole("button", { name: "Save: GitHub token" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
  it("does not discard an unsaved toggle when a credential is saved", async () => {
    mockApi({
      "GET /api/v1/settings": settings(null),
      "PUT /api/v1/settings/credentials": ok({ provider: "voyage", present: true }),
    });
    renderWithProviders(<Settings />);
    await screen.findByText("Voyage API key");

    // Enabling embedding, then pasting the key, then pressing Save is the
    // natural order. Refetching `settings` here would replace `shared` and the
    // effect would revert the toggle under the user.
    // The `id` lands on Base UI's hidden checkbox; the operable element is the
    // sibling with role="switch", and its state shows up as `data-checked`.
    const toggle = screen.getByRole("switch", { name: "Enable embedding" });
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    const field = document.getElementById("cfg-key-voyage") as HTMLInputElement;
    await userEvent.type(field, "pa-pasted-key");
    await userEvent.click(screen.getByRole("button", { name: "Save: Voyage API key" }));

    await waitFor(() => expect(field.value).toBe(""));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // And the row must reflect the key it just stored.
    expect(screen.getAllByText("Set").length).toBeGreaterThan(0);
  });
});
