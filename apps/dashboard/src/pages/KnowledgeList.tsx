import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/api/client.js";
import { EmptyState, ErrorNote, Loading, PageTitle, Pill } from "@/components/ui.js";
import { useI18n } from "@/i18n/index.js";

/** Approved-knowledge list (dashboard-api.md §6). */
export function KnowledgeList() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ["knowledge"], queryFn: () => api.knowledge() });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined) return <ErrorNote />;

  return (
    <section>
      <PageTitle>{t("knowledge.title")}</PageTitle>
      {q.data.items.length === 0 ? (
        <EmptyState message={t("knowledge.empty")} />
      ) : (
        <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-paper-raised">
          {q.data.items.map((item) => (
            <li key={item.id}>
              <Link
                to={`/knowledge/${item.id}`}
                className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-paper-inset"
              >
                <Pill tone="neutral">{item.type}</Pill>
                <span className="flex-1 font-medium text-ink">{item.title}</span>
                <span className="text-xs tabular-nums text-ink-faint">
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
