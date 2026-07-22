import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

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
