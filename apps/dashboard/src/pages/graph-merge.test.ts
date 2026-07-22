import type { GraphEdge, GraphNode } from "@iroha/api";
import { describe, expect, it } from "vitest";
import { edgeKey, mergeNeighbors, seedLayout } from "./graph-merge.js";

function gnode(id: string, type = "decision"): GraphNode {
  return { id, type, title: id, authority: 100, status: "approved" };
}
function gedge(from: string, type: string, to: string): GraphEdge {
  return { from, type: type as GraphEdge["type"], to };
}

describe("graph-merge", () => {
  it("edgeKey distinguishes direction and relation type", () => {
    expect(edgeKey({ from: "a", type: "T", to: "b" })).toBe("a~T~b");
    expect(edgeKey({ from: "a", type: "T", to: "b" })).not.toBe(
      edgeKey({ from: "b", type: "T", to: "a" }),
    );
    expect(edgeKey({ from: "a", type: "T", to: "b" })).not.toBe(
      edgeKey({ from: "a", type: "U", to: "b" }),
    );
  });

  it("seedLayout maps nodes and de-dupes edges by (from, type, to)", () => {
    const { nodes, edges } = seedLayout({
      nodes: [gnode("a"), gnode("b")],
      edges: [gedge("a", "T", "b"), gedge("a", "T", "b")],
    });
    expect(nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.id).toBe("a~T~b");
  });

  it("mergeNeighbors adds only new nodes/edges, keeps existing positions, and is idempotent", () => {
    const seed = seedLayout({ nodes: [gnode("a")], edges: [] });
    const anchorPos = seed.nodes[0]?.position;

    const merged = mergeNeighbors(
      seed,
      {
        nodes: [gnode("a"), gnode("b"), gnode("c")],
        edges: [gedge("a", "T", "b"), gedge("a", "T", "c")],
      },
      "a",
    );
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    // The expanded node keeps its position; only the fresh neighbors are placed.
    expect(merged.nodes.find((n) => n.id === "a")?.position).toEqual(anchorPos);
    expect(merged.edges.map((e) => e.id).sort()).toEqual(["a~T~b", "a~T~c"]);

    const again = mergeNeighbors(
      merged,
      {
        nodes: [gnode("a"), gnode("b"), gnode("c")],
        edges: [gedge("a", "T", "b"), gedge("a", "T", "c")],
      },
      "a",
    );
    expect(again.nodes).toHaveLength(3);
    expect(again.edges).toHaveLength(2);
  });
});
