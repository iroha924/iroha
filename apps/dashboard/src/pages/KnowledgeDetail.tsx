import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "@/api/client.js";
import { useI18n } from "@/i18n/index.js";

/** Approved-knowledge detail with body, provenance, and relations (dashboard-api.md §6). */
export function KnowledgeDetail() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: ["knowledge", id], queryFn: () => api.knowledgeDetail(id) });

  if (q.isPending) return <p className="text-slate-500">{t("common.loading")}</p>;
  if (q.isError || q.data === undefined) return <p className="text-red-600">{t("common.error")}</p>;
  const d = q.data;

  return (
    <section>
      <Link to="/knowledge" className="text-sm text-slate-500 hover:underline">
        ← {t("common.back")}
      </Link>
      <h1 className="mt-2 text-lg font-semibold">{d.title}</h1>
      <div className="mt-1 text-xs text-slate-500">
        {d.type} · {t("common.status")}: {d.status} · {t("knowledge.authority")} {d.authority}
      </div>
      {d.body !== null && (
        <pre className="mt-4 overflow-x-auto whitespace-pre-wrap rounded border border-slate-200 bg-white p-4 text-sm">
          {d.body}
        </pre>
      )}
      {d.relations.length > 0 && (
        <ul className="mt-4 space-y-1 text-sm text-slate-600">
          {d.relations.map((r) => (
            <li key={`${r.direction}-${r.relationType}-${r.entityId}`}>
              {r.direction === "outgoing" ? "→" : "←"} {r.relationType}{" "}
              <Link to={`/knowledge/${r.entityId}`} className="text-slate-800 hover:underline">
                {r.entityId}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
