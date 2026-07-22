import type { GraphEdge, GraphNode } from "@iroha/api";
import type { Edge, Node } from "@xyflow/react";

// Color encodes entity type, never person performance (dashboard-api.md §6).
const TYPE_COLOR: Record<string, string> = {
  decision: "#6E7B57",
  rule: "#515E3E",
  concept: "#BC9870",
  insight: "#A8823F",
  incident: "#C26A3C",
  pattern: "#8C7A57",
  review_learning: "#7B6B8E",
  session: "#6F675A",
  checkpoint: "#968D7C",
};

export function colorFor(type: string): string {
  return TYPE_COLOR[type] ?? "#6F675A";
}

interface Point {
  x: number;
  y: number;
}

/** A relation is identified by (from, type, to); `~` never appears in an id or a relation type. */
export function edgeKey(e: { from: string; type: string; to: string }): string {
  return `${e.from}~${e.type}~${e.to}`;
}

/** Places item `index` of `total` on a ring of the given radius around `center`. */
function ring(center: Point, index: number, total: number, radius: number): Point {
  if (total <= 1) return { x: center.x, y: center.y };
  const angle = (2 * Math.PI * index) / total;
  return { x: center.x + radius * Math.cos(angle), y: center.y - radius * Math.sin(angle) };
}

/** A relation view shared by `GraphData` and `GraphPathData` (both expose nodes + edges). */
export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function toFlowNode(n: GraphNode, position: Point): Node {
  return {
    id: n.id,
    position,
    data: { label: n.title },
    style: {
      background: colorFor(n.type),
      color: "#FBF7EE",
      border: "none",
      borderRadius: 12,
      fontSize: 12,
      padding: 8,
      width: 150,
    },
  };
}

function toFlowEdge(e: GraphEdge): Edge {
  return {
    id: edgeKey(e),
    source: e.from,
    target: e.to,
    label: e.type,
    style: { stroke: "#D8CDB4" },
  };
}

/**
 * Lays out a fresh graph (the seed from `graphQuery`/`graphPath`) — replaces
 * whatever was on screen. Nodes are spread on a ring; the seed roots, being
 * first in the data, are laid out first.
 */
export function seedLayout(data: GraphView): { nodes: Node[]; edges: Edge[] } {
  const total = data.nodes.length;
  const nodes = data.nodes.map((n, i) =>
    toFlowNode(n, total <= 1 ? { x: 340, y: 220 } : ring({ x: 340, y: 220 }, i, total, 240)),
  );
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const e of data.edges) {
    const key = edgeKey(e);
    if (!seen.has(key)) {
      seen.add(key);
      edges.push(toFlowEdge(e));
    }
  }
  return { nodes, edges };
}

/**
 * Merges a node's neighbors (`entityRelations`) into the current graph without
 * disturbing existing node positions. New nodes are ringed around the expanded
 * node; nodes and edges already present are left untouched (de-duped by id /
 * `edgeKey`), so re-expanding a node is idempotent and React keys never collide.
 */
export function mergeNeighbors(
  current: { nodes: Node[]; edges: Edge[] },
  data: GraphView,
  anchorId: string,
): { nodes: Node[]; edges: Edge[] } {
  const existingNodeIds = new Set(current.nodes.map((n) => n.id));
  const anchor = current.nodes.find((n) => n.id === anchorId)?.position ?? { x: 340, y: 220 };
  const fresh = data.nodes.filter((n) => !existingNodeIds.has(n.id));
  const addedNodes = fresh.map((n, i) => toFlowNode(n, ring(anchor, i, fresh.length, 160)));

  const existingEdgeIds = new Set(current.edges.map((e) => e.id));
  const addedEdges: Edge[] = [];
  const seen = new Set<string>(existingEdgeIds);
  for (const e of data.edges) {
    const key = edgeKey(e);
    if (!seen.has(key)) {
      seen.add(key);
      addedEdges.push(toFlowEdge(e));
    }
  }
  return { nodes: [...current.nodes, ...addedNodes], edges: [...current.edges, ...addedEdges] };
}
