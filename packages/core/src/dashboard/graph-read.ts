import type { Clock, IrohaError, RandomSource, Result } from "@iroha/domain";
import { err, IrohaError as IrohaErrorClass, ok } from "@iroha/domain";
import {
  type Executor,
  getEntityById,
  getNeighbors,
  getPath,
  getSubgraph,
  type RelationDirection,
  type RelationRow,
  type RelationType,
} from "@iroha/storage";
import { withDashboardRepository } from "./with-repository.js";

/** dashboard-api.md §5: "Graph query limits: depth 4, 200 edges, 200 nodes." */
const MAX_DEPTH = 4;
const MAX_EDGES = 200;
const MAX_NODES = 200;

export interface GraphNode {
  id: string;
  type: string;
  title: string;
  authority: number;
  status: string;
}

export interface GraphEdge {
  from: string;
  type: RelationType;
  to: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

function edgesFrom(rows: RelationRow[]): GraphEdge[] {
  return rows.map((rel) => ({
    from: rel.fromEntityId,
    type: rel.relationType,
    to: rel.toEntityId,
  }));
}

/** Resolves node metadata for every entity id referenced by the edges (+ seeds), capped at `MAX_NODES`. */
async function resolveNodes(
  db: Executor,
  edges: GraphEdge[],
  seeds: string[],
): Promise<Result<{ nodes: GraphNode[]; truncated: boolean }, IrohaError>> {
  const ids = new Set<string>(seeds);
  for (const edge of edges) {
    ids.add(edge.from);
    ids.add(edge.to);
  }
  let truncated = false;
  const nodes: GraphNode[] = [];
  for (const id of ids) {
    if (nodes.length >= MAX_NODES) {
      truncated = true;
      break;
    }
    const entityResult = await getEntityById(db, id);
    if (!entityResult.ok) {
      return entityResult;
    }
    const entity = entityResult.value;
    if (entity !== null) {
      nodes.push({
        id: entity.id,
        type: entity.entityType,
        title: entity.title,
        authority: entity.authority,
        status: entity.status,
      });
    }
  }
  return ok({ nodes, truncated });
}

export interface GetEntityRelationsInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  entityId: string;
  relationTypes?: RelationType[];
  direction?: RelationDirection;
  limit?: number;
}

/** Bounded neighbors of one entity (`GET /api/v1/entities/:id/relations`). */
export async function getEntityRelations(
  input: GetEntityRelationsInput,
): Promise<Result<GraphData, IrohaError>> {
  const limit = Math.min(MAX_EDGES, Math.max(1, input.limit ?? 100));
  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const neighbors = await getNeighbors(ctx.db, input.entityId, {
        ...(input.relationTypes !== undefined ? { relationTypes: input.relationTypes } : {}),
        ...(input.direction !== undefined ? { direction: input.direction } : {}),
        limit: limit + 1,
      });
      if (!neighbors.ok) {
        return neighbors;
      }
      const edgeTruncated = neighbors.value.length > limit;
      const edges = edgesFrom(neighbors.value.slice(0, limit));
      const nodesResult = await resolveNodes(ctx.db, edges, [input.entityId]);
      if (!nodesResult.ok) {
        return nodesResult;
      }
      return ok({
        nodes: nodesResult.value.nodes,
        edges,
        truncated: edgeTruncated || nodesResult.value.truncated,
      });
    },
  );
}

export interface GraphQueryInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  roots: string[];
  depth?: number;
}

/** Bounded subgraph from one or more roots (`POST /api/v1/graph/query`). */
export async function graphQuery(input: GraphQueryInput): Promise<Result<GraphData, IrohaError>> {
  if (input.roots.length === 0) {
    return err(new IrohaErrorClass("INVALID_INPUT", "At least one graph root is required"));
  }
  const depth = Math.min(MAX_DEPTH, Math.max(1, input.depth ?? 2));
  return withDashboardRepository(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const subgraph = await getSubgraph(ctx.db, input.roots, depth, MAX_EDGES);
      if (!subgraph.ok) {
        return subgraph;
      }
      const edgeTruncated = subgraph.value.length >= MAX_EDGES;
      const edges = edgesFrom(subgraph.value);
      const nodesResult = await resolveNodes(ctx.db, edges, input.roots);
      if (!nodesResult.ok) {
        return nodesResult;
      }
      return ok({
        nodes: nodesResult.value.nodes,
        edges,
        truncated: edgeTruncated || nodesResult.value.truncated,
      });
    },
  );
}

export interface GraphPathInput {
  cwd: string;
  clock: Clock;
  random: RandomSource;
  fromId: string;
  toId: string;
}

export interface GraphPathData {
  found: boolean;
  edges: GraphEdge[];
  nodes: GraphNode[];
}

/** Bounded path between two entities (`GET /api/v1/graph/path`). */
export async function graphPath(input: GraphPathInput): Promise<Result<GraphPathData, IrohaError>> {
  return withDashboardRepository<GraphPathData>(
    { cwd: input.cwd, clock: input.clock, random: input.random },
    async (ctx) => {
      const pathResult = await getPath(ctx.db, input.fromId, input.toId, MAX_DEPTH);
      if (!pathResult.ok) {
        return pathResult;
      }
      if (pathResult.value === null) {
        return ok({ found: false, edges: [], nodes: [] });
      }
      const edges = edgesFrom(pathResult.value);
      const nodesResult = await resolveNodes(ctx.db, edges, [input.fromId, input.toId]);
      if (!nodesResult.ok) {
        return nodesResult;
      }
      return ok({ found: true, edges, nodes: nodesResult.value.nodes });
    },
  );
}
