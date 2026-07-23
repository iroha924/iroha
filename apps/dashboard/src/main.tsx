import { CSPProvider } from "@base-ui/react/csp-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "@/App.js";
import { api } from "@/api/client.js";
import "@/index.css";
import { I18nProvider } from "@/i18n/index.js";

/**
 * dashboard-api.md §3: read the one-time launch token from the URL fragment,
 * exchange it for the HttpOnly cookie, then strip the fragment from history so
 * it never lingers in the address bar or a bookmark.
 */
async function exchangeFragmentToken(): Promise<void> {
  const match = window.location.hash.match(/token=([^&]+)/);
  if (match?.[1] !== undefined) {
    try {
      await api.exchange(decodeURIComponent(match[1]));
    } catch {
      // An invalid/expired token leaves the app unauthenticated; App shows the relaunch prompt.
    }
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Root element #root not found");
}

exchangeFragmentToken().finally(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <CSPProvider disableStyleElements>
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </I18nProvider>
        </QueryClientProvider>
      </CSPProvider>
    </StrictMode>,
  );
});
