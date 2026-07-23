import { useMutation, useQuery } from "@tanstack/react-query";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useState } from "react";
import { api } from "@/api/client.js";
import { EmptyState, ErrorState, FilterChip, Loading, PageHeader } from "@/components/brand.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useI18n } from "@/i18n/index.js";
import { mergeNeighbors, seedLayout } from "./graph-merge.js";

const DEPTHS = [1, 2, 3, 4] as const;
/** `POST /v1/graph/query` rejects `roots` arrays longer than this (`graphQuerySchema`). */
const MAX_ROOTS = 20;

interface SeedItem {
  id: string;
  label: string;
}

/** A group of selectable seed entities (Knowledge / Sessions) rendered as toggle chips. */
function SeedGroup({
  title,
  items,
  selected,
  onToggle,
}: {
  title: string;
  items: SeedItem[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
        {title}
      </div>
      <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
        {items.map((it) => (
          <FilterChip key={it.id} active={selected.includes(it.id)} onClick={() => onToggle(it.id)}>
            {it.label}
          </FilterChip>
        ))}
      </div>
    </div>
  );
}

/**
 * Work Graph (dashboard-api.md §6): an interactive bounded relation view. Seed
 * from browsable entities (Knowledge / Sessions), pick a depth, then explore by
 * clicking a node to load its neighbors (server-side expansion). React Flow
 * applies node positions via CSSOM (not a `style` attribute), so it stays within
 * the strict `style-src 'self'` CSP. Always paired with the accessible neighbor
 * list (§8) so the graph has an equivalent table representation.
 */
export function Graph() {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string[]>([]);
  const [depth, setDepth] = useState(2);
  const [graph, setGraph] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });
  const [truncated, setTruncated] = useState(false);
  const [pathMissing, setPathMissing] = useState(false);
  // One error flag for whichever graph op ran last; cleared when the next op
  // starts (or on Clear) so a prior failure never lingers over a fresh graph.
  const [opError, setOpError] = useState(false);

  // Seed candidates are the two entity lists a human can browse; the rest of the
  // default chain (Issue / Commit / PR / Review) is reached via load-neighbors.
  const knowledge = useQuery({
    queryKey: ["graph-seed-knowledge"],
    queryFn: () => api.knowledge(),
  });
  const sessions = useQuery({ queryKey: ["graph-seed-sessions"], queryFn: () => api.sessions() });

  const loadGraph = useMutation({
    mutationFn: (vars: { roots: string[]; depth: number }) =>
      api.graphQuery(vars.roots, vars.depth),
    onMutate: () => setOpError(false),
    onSuccess: (data) => {
      setGraph(seedLayout(data));
      setTruncated(data.truncated);
      setPathMissing(false);
    },
    onError: () => setOpError(true),
  });

  const expandNode = useMutation({
    mutationFn: (id: string) => api.entityRelations(id),
    onMutate: () => setOpError(false),
    onSuccess: (data, id) => {
      setGraph((g) => mergeNeighbors(g, data, id));
      if (data.truncated) setTruncated(true);
    },
    onError: () => setOpError(true),
  });

  const findPath = useMutation({
    mutationFn: (vars: { from: string; to: string }) => api.graphPath(vars.from, vars.to),
    onMutate: () => setOpError(false),
    onSuccess: (data) => {
      setPathMissing(!data.found);
      setGraph(data.found ? seedLayout(data) : { nodes: [], edges: [] });
      setTruncated(false);
    },
    onError: () => setOpError(true),
  });

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const clear = () => {
    setSelected([]);
    setGraph({ nodes: [], edges: [] });
    setTruncated(false);
    setPathMissing(false);
    setOpError(false);
  };

  const runFindPath = () => {
    const [from, to] = selected;
    if (from !== undefined && to !== undefined) {
      findPath.mutate({ from, to });
    }
  };

  const knowledgeItems: SeedItem[] = (knowledge.data?.items ?? []).map((k) => ({
    id: k.id,
    label: k.title,
  }));
  const sessionItems: SeedItem[] = (sessions.data?.items ?? []).map((s) => ({
    id: s.id,
    label: [s.platform, s.latestBranch ?? "", s.lastSeenAt.slice(0, 10)]
      .filter(Boolean)
      .join(" · "),
  }));
  const seedsLoading = knowledge.isPending || sessions.isPending;
  const seedsError = knowledge.isError || sessions.isError;
  const hasSeeds = knowledgeItems.length + sessionItems.length > 0;
  const busy = loadGraph.isPending || expandNode.isPending || findPath.isPending;
  const failed = opError;
  // Titles for the accessible edge table, so it reads as human labels (like the
  // visual graph) rather than raw ULIDs.
  const titleById = new Map(graph.nodes.map((n) => [n.id, String(n.data.label ?? n.id)]));

  return (
    <section>
      <PageHeader eyebrow={t("nav.graph")} title={t("graph.title")} />

      <div className="mb-4 rounded-2xl border border-hairline bg-paper-raised p-4">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          {t("graph.selectSeeds")}
        </div>
        {seedsLoading && <Loading />}
        {seedsError && <ErrorState />}
        {!seedsLoading && !seedsError && !hasSeeds && (
          <p className="text-sm text-ink-muted">{t("graph.noSeeds")}</p>
        )}
        <SeedGroup
          title={t("nav.knowledge")}
          items={knowledgeItems}
          selected={selected}
          onToggle={toggle}
        />
        <SeedGroup
          title={t("nav.sessions")}
          items={sessionItems}
          selected={selected}
          onToggle={toggle}
        />
        {hasSeeds && <p className="mt-1 text-[11px] text-ink-faint">{t("graph.seedNote")}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 text-xs text-ink-muted">
            <span>{t("graph.depth")}</span>
            <Select value={String(depth)} onValueChange={(value) => setDepth(Number(value))}>
              <SelectTrigger size="sm" aria-label={t("graph.depth")} className="w-16">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEPTHS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            disabled={selected.length === 0 || selected.length > MAX_ROOTS || busy}
            onClick={() => loadGraph.mutate({ roots: selected, depth })}
          >
            {t("graph.loadGraph")}
            {selected.length > 0 && ` (${selected.length})`}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={selected.length !== 2 || busy}
            onClick={runFindPath}
          >
            {t("graph.findPath")}
          </Button>
          {(graph.nodes.length > 0 || selected.length > 0) && (
            <Button type="button" variant="outline" disabled={busy} onClick={clear}>
              {t("common.clear")}
            </Button>
          )}
        </div>
        {selected.length > MAX_ROOTS && (
          <p className="mt-2 text-xs text-persimmon">{t("graph.tooManyRoots")}</p>
        )}
      </div>

      {busy && <Loading />}
      {failed && <ErrorState />}
      {pathMissing && (
        <p className="rounded-xl bg-warn-tint px-3 py-2 text-sm text-warn">
          {t("graph.pathNotFound")}
        </p>
      )}
      {graph.nodes.length === 0 && !busy && !pathMissing && !failed && (
        <EmptyState message={t("graph.empty")} />
      )}

      {graph.nodes.length > 0 && (
        <>
          <div className="mb-2 text-xs text-ink-muted">
            {t("graph.nodes")} {graph.nodes.length} · {t("graph.edges")} {graph.edges.length}
            {truncated && <span className="ml-2 text-warn">· {t("graph.truncated")}</span>}
            <span className="ml-2">· {t("graph.hint")}</span>
          </div>
          <div className="h-[480px] overflow-hidden rounded-2xl border border-hairline bg-paper-raised">
            <ReactFlow
              nodes={graph.nodes}
              edges={graph.edges}
              onNodesChange={(c: NodeChange[]) =>
                setGraph((g) => ({ ...g, nodes: applyNodeChanges(c, g.nodes) }))
              }
              onEdgesChange={(c: EdgeChange[]) =>
                setGraph((g) => ({ ...g, edges: applyEdgeChanges(c, g.edges) }))
              }
              // Gated while a mutation is in flight so an expand can't interleave
              // with a fresh load/clear and repopulate a graph the user just replaced.
              onNodeClick={(_, node) => {
                if (!busy) expandNode.mutate(node.id);
              }}
              fitView
              nodesConnectable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="var(--color-hairline)" />
            </ReactFlow>
          </div>

          <h2 className="mt-6 mb-2 text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">
            {t("graph.list")}
          </h2>
          <div className="overflow-x-auto rounded-2xl border border-hairline bg-paper-raised">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-hairline">
                {graph.edges.map((e) => (
                  <tr key={e.id}>
                    <td className="px-4 py-2 text-ink">{titleById.get(e.source) ?? e.source}</td>
                    <td className="px-4 py-2 text-ink-muted">{String(e.label ?? "")}</td>
                    <td className="px-4 py-2 text-ink">{titleById.get(e.target) ?? e.target}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
