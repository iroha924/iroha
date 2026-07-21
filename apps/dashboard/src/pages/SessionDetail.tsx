import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "@/api/client.js";
import { Card, ErrorNote, Loading, Pill } from "@/components/ui.js";
import { useI18n } from "@/i18n/index.js";

/** Session detail: Runs and Checkpoints (dashboard-api.md §6); never raw conversation. */
export function SessionDetail() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: ["session", id], queryFn: () => api.sessionDetail(id) });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined) return <ErrorNote />;
  const d = q.data;

  return (
    <section className="space-y-5">
      <Link to="/sessions" className="text-sm text-ink-muted hover:text-ink">
        ← {t("common.back")}
      </Link>
      <h1 className="font-display text-2xl font-semibold tracking-[-0.005em] text-ink">
        {d.platform}
      </h1>
      <div className="text-xs text-ink-muted">
        {t("common.status")}: {d.summaryStatus} · {d.startedAt.slice(0, 16).replace("T", " ")}
      </div>

      <Card>
        <h2 className="mb-3 text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">
          {t("sessions.runs")}
        </h2>
        <ul className="space-y-2">
          {d.runs.map((r) => (
            <li key={r.id} className="flex items-center gap-3 text-sm">
              <Pill tone={r.status === "active" ? "approve" : "neutral"}>{r.status}</Pill>
              <Link to={`/sessions/${d.id}/runs/${r.id}`} className="text-matcha hover:underline">
                {r.gitBranch ?? r.startSource}
              </Link>
              <span className="text-ink-faint">{r.startedAt.slice(0, 16).replace("T", " ")}</span>
            </li>
          ))}
        </ul>
      </Card>

      {d.checkpoints.length > 0 && (
        <Card>
          <h2 className="mb-3 text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">
            {t("session.checkpoints")}
          </h2>
          <ul className="space-y-2">
            {d.checkpoints.map((cp) => (
              <li key={cp.id} className="flex items-center gap-3 text-sm">
                <Pill tone="neutral">{cp.outcome}</Pill>
                <span className="flex-1 text-ink">{cp.objective}</span>
                <span className="text-xs text-ink-faint">{cp.createdAt.slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
