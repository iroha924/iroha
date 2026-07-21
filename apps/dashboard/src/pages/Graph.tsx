import { useQuery } from "@tanstack/react-query";
import { Background, type Edge, type Node, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { type FormEvent, useState } from "react";
import { api } from "@/api/client.js";
import { EmptyState, ErrorNote, Loading, PageTitle } from "@/components/ui.js";
import { useI18n } from "@/i18n/index.js";

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

function colorFor(type: string): string {
  return TYPE_COLOR[type] ?? "#6F675A";
}

function circle(index: number, total: number): { x: number; y: number } {
  if (total <= 1) return { x: 340, y: 220 };
  const angle = (2 * Math.PI * index) / total;
  return { x: 340 + 260 * Math.cos(angle), y: 220 + 190 * Math.sin(angle) };
}

/**
 * Work Graph (dashboard-api.md §6): a bounded relation view. React Flow applies
 * node positions via CSSOM (not a `style` attribute), so it stays within the
 * strict `style-src 'self'` CSP. Always paired with the accessible neighbor
 * list (§8) so the graph has an equivalent table representation.
 */
export function Graph() {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [root, setRoot] = useState("");

  const q = useQuery({
    queryKey: ["graph", root],
    queryFn: () => api.graphQuery([root]),
    enabled: root.length > 0,
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setRoot(input.trim());
  };

  const nodes: Node[] =
    q.data?.nodes.map((n, i) => ({
      id: n.id,
      position: circle(i, q.data?.nodes.length ?? 1),
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
    })) ?? [];

  const edges: Edge[] =
    q.data?.edges.map((e, i) => ({
      id: `e-${i}-${e.from}-${e.to}`,
      source: e.from,
      target: e.to,
      label: e.type,
      style: { stroke: "#D8CDB4" },
    })) ?? [];

  return (
    <section>
      <PageTitle>{t("graph.title")}</PageTitle>
      <form onSubmit={onSubmit} className="mb-5 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("graph.rootPlaceholder")}
          aria-label={t("graph.rootPlaceholder")}
          className="h-10 flex-1 rounded-xl border border-hairline bg-paper-raised px-3 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-matcha focus:outline-none"
        />
        <button
          type="submit"
          className="h-10 rounded-xl bg-matcha px-4 font-medium text-paper-raised"
        >
          {t("graph.load")}
        </button>
      </form>

      {root.length === 0 && <EmptyState message={t("graph.empty")} />}
      {q.isFetching && <Loading />}
      {q.isError && <ErrorNote />}

      {q.data !== undefined && (
        <>
          <div className="mb-2 text-xs text-ink-muted">
            {t("graph.nodes")} {q.data.nodes.length} · {t("graph.edges")} {q.data.edges.length}
            {q.data.truncated && <span className="ml-2 text-warn">· {t("graph.truncated")}</span>}
          </div>
          <div className="h-[480px] overflow-hidden rounded-2xl border border-hairline bg-paper-raised">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              fitView
              nodesDraggable={false}
              nodesConnectable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#E6DCC8" />
            </ReactFlow>
          </div>

          <h2 className="mt-6 mb-2 text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">
            {t("graph.list")}
          </h2>
          <div className="overflow-x-auto rounded-2xl border border-hairline bg-paper-raised">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-hairline">
                {q.data.edges.map((e, i) => (
                  <tr key={`row-${i}-${e.from}-${e.to}`}>
                    <td className="px-4 py-2 font-mono text-ink">{e.from}</td>
                    <td className="px-4 py-2 text-ink-muted">{e.type}</td>
                    <td className="px-4 py-2 font-mono text-ink">{e.to}</td>
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
