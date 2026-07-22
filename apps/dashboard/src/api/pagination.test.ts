import { describe, expect, it } from "vitest";
import { flattenPages } from "./pagination.js";

describe("flattenPages", () => {
  it("concatenates pages in order", () => {
    const result = flattenPages([{ items: [{ id: "a" }, { id: "b" }] }, { items: [{ id: "c" }] }]);
    expect(result.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("de-duplicates rows that overlap at a page seam, keeping the first (freshest) copy", () => {
    // `b` reappears on page 2 because a row above it left the list between fetches.
    const result = flattenPages([
      {
        items: [
          { id: "a", v: 1 },
          { id: "b", v: 1 },
        ],
      },
      {
        items: [
          { id: "b", v: 2 },
          { id: "c", v: 1 },
        ],
      },
    ]);
    expect(result.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(result.find((i) => i.id === "b")?.v).toBe(1);
  });

  it("returns an empty list for no pages", () => {
    expect(flattenPages([])).toEqual([]);
  });
});
