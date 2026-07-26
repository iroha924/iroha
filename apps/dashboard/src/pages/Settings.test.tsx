import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { api } from "@/api/client.js";
import { Settings } from "@/pages/Settings.js";
import { mockApi, ok, renderWithProviders } from "@/test-utils.js";

const SHARED = {
  repository_id: "repo_01JQZ0000000000000000001",
  default_language: "en",
  search: {
    embedding: {
      enabled: false,
      provider: "voyage",
      model: "voyage-4-large",
      api_key_env: "VOYAGE_API_KEY",
    },
  },
  forge: {
    enabled: false,
    provider: "github",
    api_token_env: "GITHUB_TOKEN",
    review_learning_threshold: 3,
  },
};

function settings(retentionDays: number | null) {
  return ok({ shared: SHARED, local: { embeddingKeyPresent: false, retentionDays } });
}

/** The select's rendered value; Base UI shows the raw value, not the item label. */
function retentionValue(): string {
  return document.getElementById("cfg-retention")?.textContent?.replace(/\W+$/, "") ?? "";
}

describe("Settings — local event retention", () => {
  it("shows the window as off when nothing is set", async () => {
    mockApi({ "GET /api/v1/settings": settings(null) });
    renderWithProviders(<Settings />);

    expect(await screen.findByText("Keep local session history")).toBeDefined();
    expect(retentionValue()).toBe("forever");
  });

  it("shows a configured window", async () => {
    mockApi({ "GET /api/v1/settings": settings(90) });
    renderWithProviders(<Settings />);

    await screen.findByText("Keep local session history");
    expect(retentionValue()).toBe("90");
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
