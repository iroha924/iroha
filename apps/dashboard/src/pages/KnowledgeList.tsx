import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/api/client.js";
import { useI18n } from "@/i18n/index.js";

/** Approved-knowledge list (dashboard-api.md §6). */
export function KnowledgeList() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ["knowledge"], queryFn: () => api.knowledge() });

  if (q.isPending) return <p className="text-slate-500">{t("common.loading")}</p>;
  if (q.isError || q.data === undefined) return <p className="text-red-600">{t("common.error")}</p>;

  return (
    <section>
      <h1 className="mb-4 text-lg font-semibold">{t("knowledge.title")}</h1>
      {q.data.items.length === 0 ? (
        <p className="text-slate-500">{t("knowledge.empty")}</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">
          {q.data.items.map((item) => (
            <li key={item.id}>
              <Link
                to={`/knowledge/${item.id}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-slate-50"
              >
                <span>
                  <span className="font-medium">{item.title}</span>
                  <span className="ml-2 text-xs text-slate-500">{item.type}</span>
                </span>
                <span className="text-xs text-slate-400">
                  {t("knowledge.authority")} {item.authority}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
