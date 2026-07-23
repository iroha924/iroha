import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "@/api/client.js";
import { BackLink, ErrorState, Loading } from "@/components/brand.js";
import { Badge } from "@/components/ui/badge.js";
import { useI18n } from "@/i18n/index.js";
import { knowledgeStatusTone } from "@/lib/status.js";

/** Approved-knowledge detail with body, provenance, and relations (dashboard-api.md §6). */
export function KnowledgeDetail() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: ["knowledge", id], queryFn: () => api.knowledgeDetail(id) });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined) return <ErrorState />;
  const d = q.data;

  return (
    <section>
      <BackLink to="/knowledge">{t("common.back")}</BackLink>
      <h1 className="font-display text-2xl font-semibold tracking-[-0.005em] text-ink">
        {d.title}
      </h1>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <Badge variant="neutral">{t(`ktype.${d.type}`)}</Badge>
        <Badge variant={knowledgeStatusTone(d.status)}>{t(`status.${d.status}`)}</Badge>
        <span className="tabular-nums">
          {t("knowledge.authority")} {d.authority}
        </span>
      </div>

      {d.body !== null && (
        <pre className="mt-6 overflow-x-auto whitespace-pre-wrap rounded-2xl border border-hairline bg-paper-inset p-5 font-mono text-[13px] leading-relaxed text-ink">
          {d.body}
        </pre>
      )}

      {d.relations.length > 0 && (
        <ul className="mt-6 space-y-1.5 text-sm text-ink-muted">
          {d.relations.map((r) => (
            <li key={`${r.direction}-${r.relationType}-${r.entityId}`}>
              <span className="text-ink-faint">{r.direction === "outgoing" ? "→" : "←"}</span>{" "}
              <span className="font-medium text-ink">{r.relationType}</span>{" "}
              <Link to={`/knowledge/${r.entityId}`} className="text-matcha hover:underline">
                {r.entityId}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
