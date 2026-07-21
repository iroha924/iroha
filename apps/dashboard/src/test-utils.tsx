import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { I18nProvider } from "@/i18n/index.js";

export function renderWithProviders(
  ui: ReactElement,
  initialEntries: string[] = ["/"],
): RenderResult {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

export interface MockResponse {
  status?: number;
  json: unknown;
}

/**
 * Installs a `fetch` mock that maps `(method, path)` to an API envelope. The
 * SPA's client talks to `/api/...`; tests supply just the response body so a
 * component exercises the real client + envelope handling.
 */
export function mockApi(routes: Record<string, MockResponse>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const method = init?.method ?? "GET";
    const route = routes[`${method} ${path}`] ?? routes[`GET ${path}`];
    if (route === undefined) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: "NOT_FOUND", message: "not found", retryable: false, fieldErrors: {} },
          meta: { requestId: "req_test" },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify(route.json), {
      status: route.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

export function ok<T>(data: T): MockResponse {
  return { status: 200, json: { ok: true, data, meta: { requestId: "req_test" } } };
}

export function fail(code: string, status: number): MockResponse {
  return {
    status,
    json: {
      ok: false,
      error: { code, message: code, retryable: false, fieldErrors: {} },
      meta: { requestId: "req_test" },
    },
  };
}
