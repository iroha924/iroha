import { describe, expect, it, vi } from "vitest";
import { createVoyageProvider } from "./embedding-provider.js";

const SECRET = "sk-super-secret-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createVoyageProvider", () => {
  it("returns one vector per input in input order, regardless of API row order", async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init;
      // Deliberately out of order to prove we sort by `index`.
      return jsonResponse({
        data: [
          { index: 1, embedding: [1, 1, 1, 1] },
          { index: 0, embedding: [0, 0, 0, 0] },
        ],
      });
    }) as unknown as typeof fetch;

    const provider = createVoyageProvider({ apiKey: SECRET, dimension: 4, fetchImpl });
    const result = await provider.embed(["first", "second"], "document");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        [0, 0, 0, 0],
        [1, 1, 1, 1],
      ]);
    }
    // Request shape matches the Voyage contract.
    const headers = captured?.headers as Record<string, string>;
    expect(captured?.method).toBe("POST");
    expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(String(captured?.body));
    expect(body).toMatchObject({
      model: "voyage-4",
      input_type: "document",
      output_dimension: 4,
      input: ["first", "second"],
    });
  });

  it("returns [] for empty input without calling the API", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = createVoyageProvider({ apiKey: SECRET, fetchImpl });
    const result = await provider.embed([], "query");
    expect(result.ok && result.value).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [500, true],
    [429, true],
    [400, false],
    [401, false],
  ])(
    "HTTP %i degrades to EMBEDDING_UNAVAILABLE (retryable=%s) and never leaks the key",
    async (status, retryable) => {
      const fetchImpl = vi.fn(async () =>
        // Even if the body echoed the key, we must not surface it.
        jsonResponse({ error: `context including ${SECRET}` }, status),
      ) as unknown as typeof fetch;
      const provider = createVoyageProvider({ apiKey: SECRET, dimension: 4, fetchImpl });
      const result = await provider.embed(["q"], "query");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("EMBEDDING_UNAVAILABLE");
        expect(result.error.retryable).toBe(retryable);
        expect(result.error.message).not.toContain(SECRET);
        expect(JSON.stringify(result.error.details ?? {})).not.toContain(SECRET);
      }
    },
  );

  it("degrades to a retryable error on a network failure without leaking the key", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`ECONNRESET https://api.voyageai.com auth=${SECRET}`);
    }) as unknown as typeof fetch;
    const provider = createVoyageProvider({ apiKey: SECRET, dimension: 4, fetchImpl });
    const result = await provider.embed(["q"], "query");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EMBEDDING_UNAVAILABLE");
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).not.toContain(SECRET);
    }
  });

  it("rejects a response whose vector dimension does not match", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
    ) as unknown as typeof fetch;
    const provider = createVoyageProvider({ apiKey: SECRET, dimension: 4, fetchImpl });
    const result = await provider.embed(["q"], "query");
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed (non-JSON) response non-retryably", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("<html>gateway</html>", { status: 200 }),
    ) as unknown as typeof fetch;
    const provider = createVoyageProvider({ apiKey: SECRET, dimension: 4, fetchImpl });
    const result = await provider.embed(["q"], "query");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(false);
    }
  });

  it("rejects a batch larger than the Voyage cap without calling the API", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = createVoyageProvider({ apiKey: SECRET, fetchImpl });
    const result = await provider.embed(new Array(1001).fill("x"), "document");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_INPUT");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
