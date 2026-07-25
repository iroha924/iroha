import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// The 1000ms default for `findBy*`/`waitFor` races the async data queries on
// shared CI runners under load (a chip rendered only after React Query resolves
// can arrive after the deadline). Polling still resolves a passing case the
// instant the DOM updates, so this only widens the failure deadline, never the
// happy path.
configure({ asyncUtilTimeout: 5000 });

// Vitest runs without `globals`, so React Testing Library never registers its
// auto-cleanup — unmount each render between tests, otherwise leaked DOM from a
// prior test collides with `getBy*` queries (duplicate matches).
afterEach(() => {
  cleanup();
});

// jsdom has no ResizeObserver; @xyflow/react (the Work Graph) instantiates one
// on mount, so provide a no-op stub for tests that render the graph.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
