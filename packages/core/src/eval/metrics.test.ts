import { describe, expect, it } from "vitest";
import { aggregate, mrrAtK, ndcgAtK, recallAtK } from "./metrics.js";

describe("ranking metrics", () => {
  it("recall@k counts relevant hits over the relevant-set size", () => {
    const relevant = new Set(["a", "b"]);
    expect(recallAtK(["a", "x", "b", "y"], relevant, 10)).toBe(1);
    expect(recallAtK(["a", "x", "y", "z"], relevant, 10)).toBe(0.5);
    expect(recallAtK(["a", "b"], relevant, 1)).toBe(0.5); // truncated to top-1
  });

  it("mrr@k is the reciprocal rank of the first relevant hit", () => {
    const relevant = new Set(["a"]);
    expect(mrrAtK(["x", "a", "y"], relevant, 10)).toBeCloseTo(1 / 2);
    expect(mrrAtK(["a"], relevant, 10)).toBe(1);
    expect(mrrAtK(["x", "y"], relevant, 10)).toBe(0);
  });

  it("ndcg@k is 1 for an ideally-ordered result and lower when relevant items rank later", () => {
    const relevant = new Set(["a", "b"]);
    expect(ndcgAtK(["a", "b", "x"], relevant, 10)).toBeCloseTo(1);
    const worse = ndcgAtK(["x", "a", "b"], relevant, 10);
    expect(worse).toBeGreaterThan(0);
    expect(worse).toBeLessThan(1);
  });

  it("aggregate averages each metric across queries", () => {
    const agg = aggregate([
      { ranked: ["a"], relevant: new Set(["a"]) },
      { ranked: ["x"], relevant: new Set(["b"]) },
    ]);
    expect(agg.recallAt10).toBe(0.5);
    expect(agg.mrrAt10).toBe(0.5);
  });
});
